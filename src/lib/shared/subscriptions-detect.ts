import { minorToAmountText } from './amount-input.ts';
import { daysBetween } from './dates.ts';
import type { Locale } from './i18n.ts';
import { cleanDescriptor, matchKeyOf } from './merchants/clean.ts';
import {
	isoWeekday,
	REMINDER_DAYS_DEFAULT,
	SUBSCRIPTION_NAME_MAX_LENGTH,
	type BillingCycle,
	type SubscriptionFormValues
} from './subscriptions.ts';
import {
	SUBSCRIPTION_CATALOGUE,
	type CatalogueEntry,
	type SubscriptionCategory
} from './subscriptions-catalogue.ts';

/**
 * FN-26b subscription check: which of a space's recent expenses look like a bill that is not in its Langganan
 * list yet. Deterministic and pure (no DB, no AI): the server reads a bounded set of rows and passes them here.
 * Every figure a candidate carries is copied from one of those rows; nothing is averaged or invented.
 *
 * Two ways a group of rows becomes a candidate:
 * 1. Known name: the title names a catalogue service of a bill-shaped category (one row is enough).
 * 2. Recurring pattern: two or more rows of one merchant key with the same amount and currency, every gap
 *    between consecutive dates fitting one cadence's tolerance.
 */

/** An expense row as detection reads it (`occurredOn` is the WIB date). */
export interface ExpenseRow {
	id: string;
	title: string | null;
	amountMinor: number;
	currency: string;
	occurredOn: string;
}

export interface SubscriptionCandidate {
	/** Stable id for add and dismiss: `cat:<catalogue id>` for a known name, else the cleaned merchant key. */
	matchKey: string;
	name: string;
	catalogueId: string | null;
	/** From the catalogue match; null for a pattern-only match. */
	category: SubscriptionCategory | null;
	/** The most recent matching row's own amount and currency. */
	amountMinor: number;
	currency: string;
	/** The pattern's cadence; a known name seen without a pattern is guessed `monthly` (editable in the form). */
	cadence: BillingCycle;
	lastOccurredOn: string;
	/** At most SOURCE_ROWS_MAX of its own rows, newest first. */
	sourceRows: {
		id: string;
		occurredOn: string;
		amountMinor: number;
		currency: string;
		title: string | null;
	}[];
}

/** Days back from today (inclusive of today) the check reads (owner decision 2). */
export const DETECT_WINDOW_DAYS = 90;
/** Most expense rows one check reads (owner decision 6). */
export const DETECT_ROWS_MAX = 300;
/** Most candidates one check returns. */
export const CANDIDATES_MAX = 20;
/** Most source rows one candidate carries. */
export const SOURCE_ROWS_MAX = 6;

/** Gap tolerances in days (owner decision 3); they never overlap, so at most one cadence fits all gaps. */
const CADENCE_GAPS: readonly { cycle: BillingCycle; min: number; max: number }[] = [
	{ cycle: 'weekly', min: 6, max: 8 },
	{ cycle: 'monthly', min: 27, max: 32 },
	{ cycle: 'yearly', min: 358, max: 372 }
];

/**
 * The cadence every gap between consecutive dates (`YYYY-MM-DD`, ascending) fits, or null: fewer than two
 * dates, or gaps that fit no single cadence (two charges on one day, 10 then 40 days apart).
 */
export function guessCadence(datesSorted: readonly string[]): BillingCycle | null {
	if (datesSorted.length < 2) return null;
	const gaps = datesSorted.slice(1).map((d, i) => daysBetween(datesSorted[i]!, d));
	return (
		CADENCE_GAPS.find(({ min, max }) => gaps.every((g) => g >= min && g <= max))?.cycle ?? null
	);
}

/** Categories a known name counts in: a recurring bill. `lainnya` (memberships like GoPay Plus) never. */
const BILL_CATEGORIES: ReadonlySet<SubscriptionCategory> = new Set([
	'streaming',
	'musik',
	'game',
	'telko',
	'cloud',
	'software',
	'belajar',
	'utilitas'
]);

/** Catalogue names that are also everyday words or people's names: they match only as the whole title. */
const WHOLE_TITLE_ONLY: ReadonlySet<string> = new Set(['xl', 'tri']);

const KNOWN: readonly { entry: CatalogueEntry; words: string[] }[] = SUBSCRIPTION_CATALOGUE.filter(
	(e) => BILL_CATEGORIES.has(e.category)
).map((entry) => ({ entry, words: matchKeyOf(entry.name).split(' ') }));

/** The bill-shaped catalogue entry a merchant key names as a run of whole words, or null. */
export function catalogueMatch(key: string): CatalogueEntry | null {
	if (key === '') return null;
	const list = key.split(' ');
	for (const { entry, words } of KNOWN) {
		const name = words.join(' ');
		if (WHOLE_TITLE_ONLY.has(name)) {
			if (key === name) return entry;
			continue;
		}
		for (let i = 0; i + words.length <= list.length; i++)
			if (words.every((w, j) => list[i + j] === w)) return entry;
	}
	return null;
}

/** What a live subscription excludes: its cleaned name's key and the catalogue entry it is (or names). */
export function exclusionKeys(subs: readonly { name: string; catalogueId: string | null }[]) {
	const keys = new Set<string>();
	for (const s of subs) {
		const key = cleanDescriptor(s.name).key;
		if (key) keys.add(key);
		const id = s.catalogueId ?? catalogueMatch(key)?.id;
		if (id) keys.add(`cat:${id}`);
	}
	return keys;
}

const newestFirst = (a: ExpenseRow, b: ExpenseRow) =>
	a.occurredOn === b.occurredOn ? 0 : a.occurredOn < b.occurredOn ? 1 : -1;

/** The rows grouped by match key (`cat:<id>` for a known name, else the cleaned key); keyless rows dropped. */
export function groupByMerchantKey(rows: readonly ExpenseRow[]) {
	const groups = new Map<
		string,
		{ catalogue: CatalogueEntry | null; name: string; rows: ExpenseRow[] }
	>();
	for (const row of rows) {
		const { name, key } = cleanDescriptor(row.title ?? '');
		if (key === '') continue;
		const catalogue = catalogueMatch(key);
		const matchKey = catalogue ? `cat:${catalogue.id}` : key;
		const group = groups.get(matchKey) ?? { catalogue, name: catalogue?.name ?? name, rows: [] };
		group.rows.push(row);
		groups.set(matchKey, group);
	}
	for (const group of groups.values()) group.rows.sort(newestFirst);
	return groups;
}

/**
 * The newest same-amount run of `rows` (newest first) whose gaps fit a cadence: rows of one amount and
 * currency, tried in order of their newest row. Null when no run of two or more fits.
 */
function recurringRun(rows: readonly ExpenseRow[]) {
	const runs = new Map<string, ExpenseRow[]>();
	for (const row of rows) {
		const k = `${row.currency}:${row.amountMinor}`;
		runs.set(k, [...(runs.get(k) ?? []), row]);
	}
	for (const run of runs.values()) {
		const cadence = guessCadence(run.map((r) => r.occurredOn).reverse());
		if (cadence) return { cadence, rows: run };
	}
	return null;
}

/**
 * The candidates in `rows` not excluded by `excludeKeys` (live subscriptions' keys, dismissed keys), newest
 * last charge first, at most CANDIDATES_MAX.
 */
export function buildCandidates(
	rows: readonly ExpenseRow[],
	excludeKeys: ReadonlySet<string>
): SubscriptionCandidate[] {
	const out: SubscriptionCandidate[] = [];
	for (const [matchKey, group] of groupByMerchantKey(rows)) {
		if (excludeKeys.has(matchKey)) continue;
		const run = recurringRun(group.rows);
		if (!group.catalogue && !run) continue;
		const own = group.catalogue ? group.rows : run!.rows;
		const last = own[0]!;
		out.push({
			matchKey,
			name: group.name,
			catalogueId: group.catalogue?.id ?? null,
			category: group.catalogue?.category ?? null,
			amountMinor: last.amountMinor,
			currency: last.currency,
			cadence: run?.cadence ?? 'monthly',
			lastOccurredOn: last.occurredOn,
			sourceRows: own.slice(0, SOURCE_ROWS_MAX).map((r) => ({
				id: r.id,
				occurredOn: r.occurredOn,
				amountMinor: r.amountMinor,
				currency: r.currency,
				title: r.title
			}))
		});
	}
	return out
		.sort((a, b) =>
			a.lastOccurredOn === b.lastOccurredOn
				? a.name.localeCompare(b.name)
				: a.lastOccurredOn < b.lastOccurredOn
					? 1
					: -1
		)
		.slice(0, CANDIDATES_MAX);
}

/**
 * The add form filled from a candidate ("Tambah"): its name (cut to the form's 60), category (else Lainnya), the
 * amount and currency of its latest row, its cadence, and the billing day, weekday and month of that row's WIB
 * date. Every field stays editable; nothing is saved until the form is submitted through `createSubscription`.
 */
export function candidateFormValues(
	c: SubscriptionCandidate,
	locale: Locale
): SubscriptionFormValues {
	return {
		catalogueId: c.catalogueId ?? '',
		name: Array.from(c.name).slice(0, SUBSCRIPTION_NAME_MAX_LENGTH).join(''),
		category: c.category ?? 'lainnya',
		amount: minorToAmountText(c.amountMinor, c.currency, locale),
		currency: c.currency,
		cycle: c.cadence,
		day: String(Number(c.lastOccurredOn.slice(8))),
		weekday: String(isoWeekday(c.lastOccurredOn)),
		month: String(Number(c.lastOccurredOn.slice(5, 7))),
		walletId: '',
		reminderDays: String(REMINDER_DAYS_DEFAULT)
	};
}
