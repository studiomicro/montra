import {
	addDays,
	daysBetween,
	isDateString,
	isMonthString,
	monthOf,
	monthRange,
	yearToDateRange
} from './dates';
import { msg } from './i18n';
import { cleanText } from './text';
import { SEARCH_MAX_LENGTH, TRANSACTION_TYPES, type TransactionType } from './transactions';

/** Longest id read from the URL; ids are UUIDs, anything longer cannot match. */
const ID_MAX_LENGTH = 64;
/** Longest custom range: 366 days counted inclusively (the aggregate module's MAX_FILTER_DAYS). */
const RANGE_MAX_DAYS = 366;

/**
 * What /riwayat shows, as the URL says it (`type`, `period`, `month`, `from`, `to`, `category`, `wallet`,
 * `q`, `berulang`): every filter is a plain query parameter so links, the search form and the filter form all work
 * without JavaScript, and a shared link reproduces the same list.
 */
export interface RiwayatView {
	type: TransactionType | null;
	period: 'month' | 'range';
	/** The month shown in `month` mode (`YYYY-MM`). */
	month: string;
	/** The inclusive WIB dates of the list (the month's first and last day in `month` mode). */
	from: string;
	to: string;
	categoryId: string | null;
	walletId: string | null;
	q: string;
	/** "Aktif berulang" (FN-36): only rows created by a series that is still active. */
	recurring: boolean;
}

const idParam = (value: string | null) => (value && value.length <= ID_MAX_LENGTH ? value : null);

/**
 * The view a URL asks for, every value checked and bounded: an unknown `type` means all rows, a bad month means
 * the current one, a range is put in order and cut to 366 days, the search term is cleaned and capped. Never
 * throws for any input.
 */
export function parseRiwayatQuery(
	params: URLSearchParams,
	today: string
): { view: RiwayatView; cursor: string | null } {
	const type = params.get('type');
	const monthParam = params.get('month') ?? '';
	const month = isMonthString(monthParam) ? monthParam : monthOf(today);
	let period: RiwayatView['period'] = params.get('period') === 'range' ? 'range' : 'month';
	let { from, to } = monthRange(month);
	if (period === 'range') {
		const a = params.get('from') ?? '';
		const b = params.get('to') ?? '';
		if (isDateString(a) && isDateString(b)) {
			[from, to] = a <= b ? [a, b] : [b, a];
			if (daysBetween(from, to) >= RANGE_MAX_DAYS) to = addDays(from, RANGE_MAX_DAYS - 1);
		} else period = 'month';
	}
	return {
		view: {
			type: (TRANSACTION_TYPES as readonly (string | null)[]).includes(type)
				? (type as TransactionType)
				: null,
			period,
			month,
			from,
			to,
			categoryId: idParam(params.get('category')),
			walletId: idParam(params.get('wallet')),
			q: cleanText(params.get('q') ?? '', SEARCH_MAX_LENGTH),
			recurring: params.get('berulang') === '1'
		},
		cursor: params.get('cursor')?.slice(0, 128) ?? null
	};
}

/** The aggregate filter of a view (structurally the server's `TransactionFilter`). */
export function viewFilter(view: RiwayatView) {
	return {
		from: view.from,
		to: view.to,
		type: view.type,
		categoryId: view.categoryId,
		walletId: view.walletId,
		q: view.q || null,
		recurringOnly: view.recurring
	};
}

/**
 * `/riwayat?…` for `view` with `changes` applied: only non-default values are written, so the plain list is
 * plain `/riwayat`. `cursor` is added only when given (a filter change always starts from the top).
 */
export function riwayatHref(
	view: RiwayatView,
	changes: Partial<RiwayatView> = {},
	cursor?: string | null
): string {
	const v = { ...view, ...changes };
	const params = new URLSearchParams();
	if (v.type) params.set('type', v.type);
	if (v.period === 'range') {
		params.set('period', 'range');
		params.set('from', v.from);
		params.set('to', v.to);
	} else params.set('month', v.month);
	if (v.categoryId) params.set('category', v.categoryId);
	if (v.walletId) params.set('wallet', v.walletId);
	if (v.q) params.set('q', v.q);
	if (v.recurring) params.set('berulang', '1');
	if (cursor) params.set('cursor', cursor);
	return `/riwayat?${params.toString()}`;
}

/** The period chips of Transaksi (APP_PARITY § 3). */
export type PeriodPreset = 'month' | 'd30' | 'd90' | 'year' | 'd366';

export const PERIOD_PRESET_LABELS: Readonly<Record<PeriodPreset, string>> = {
	month: msg('Periode ini'),
	d30: msg('30 hari'),
	d90: msg('90 hari'),
	year: msg('Tahun ini'),
	// The list reads at most 366 days per filter (bounded scans), so "all" is honestly the last year.
	d366: msg('1 tahun terakhir')
};

/** The view changes each period chip applies, relative to the WIB date `today`. */
export function periodPresets(
	today: string
): { id: PeriodPreset; changes: Partial<RiwayatView> }[] {
	const range = (from: string): Partial<RiwayatView> => ({ period: 'range', from, to: today });
	return [
		{
			id: 'month',
			changes: { period: 'month', month: monthOf(today), ...monthRange(monthOf(today)) }
		},
		{ id: 'd30', changes: range(addDays(today, -29)) },
		{ id: 'd90', changes: range(addDays(today, -89)) },
		{ id: 'year', changes: range(yearToDateRange(today).from) },
		{ id: 'd366', changes: range(addDays(today, -(RANGE_MAX_DAYS - 1))) }
	];
}

/** The chip a view matches, or null for another month or a custom range. */
export function presetOf(view: RiwayatView, today: string): PeriodPreset | null {
	for (const { id, changes } of periodPresets(today)) {
		if (view.period !== changes.period) continue;
		if (
			view.period === 'month'
				? view.month === changes.month
				: view.from === changes.from && view.to === changes.to
		)
			return id;
	}
	return null;
}
