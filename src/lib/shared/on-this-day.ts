/**
 * FN-54 D4: "Pada hari ini" cards, honest by construction. The only source is the reviewed file
 * `src/lib/content/on-this-day/entries.json`: never fetched at runtime, never scraped, never written by a model. An
 * entry exists only after a person opened both of its sources and logged the check in
 * `docs/features/fn-54-greeting-calendar/ON_THIS_DAY_REVIEW.md` (one line per entry, cross-checked by a test). The
 * file may be empty: then the card is simply absent.
 */

interface LocalText {
	id: string;
	en: string;
}

export interface OnThisDayEntry {
	/** `MM-DD` (02-29 allowed). */
	date: string;
	year: number;
	headline: LocalText;
	body: LocalText;
	/** At least two, each an https page a reviewer opened. */
	sources: { label: string; url: string }[];
	/** `YYYY-MM-DD`. */
	reviewedOn: string;
	reviewedBy: string;
}

const HEADLINE_MAX = 60;
export const BODY_MAX = 180;
const BODY_MAX_SENTENCES = 2;
const MIN_SOURCES = 2;
const LABEL_MAX = 80;
const URL_MAX = 500;
const REVIEWER_MAX = 80;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** True for `MM-DD` naming a real day of some year (02-29 included). */
export function isMonthDay(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const m = /^(\d{2})-(\d{2})$/.exec(value);
	if (!m) return false;
	const month = Number(m[1]);
	const day = Number(m[2]);
	return month >= 1 && month <= 12 && day >= 1 && day <= (DAYS_IN_MONTH[month - 1] ?? 0);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const isText = (v: unknown, max: number): v is string =>
	typeof v === 'string' && v.trim().length > 0 && Array.from(v).length <= max;

/** Sentences of a body: runs ending in . ! or ? (a trailing run without one counts too). */
function sentenceCount(text: string): number {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean).length;
}

function localTextProblem(v: unknown, field: string, max: number, sentences?: number): string[] {
	if (!isRecord(v)) return [`${field}: needs id and en`];
	const out: string[] = [];
	for (const lang of ['id', 'en'] as const) {
		const text = v[lang];
		if (!isText(text, max)) out.push(`${field}.${lang}: 1–${max} characters`);
		else if (sentences !== undefined && sentenceCount(text) > sentences)
			out.push(`${field}.${lang}: at most ${sentences} sentences`);
	}
	return out;
}

function httpsUrl(v: unknown): boolean {
	if (typeof v !== 'string' || v.length > URL_MAX) return false;
	try {
		const url = new URL(v);
		return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
	} catch {
		return false;
	}
}

/** Every rule an entry breaks (empty when it is valid). */
export function entryProblems(v: unknown): string[] {
	if (!isRecord(v)) return ['not an object'];
	const out: string[] = [];
	if (!isMonthDay(v.date)) out.push('date: MM-DD of a real day');
	if (!Number.isInteger(v.year) || (v.year as number) < 1 || (v.year as number) > 9999)
		out.push('year: a whole year');
	out.push(...localTextProblem(v.headline, 'headline', HEADLINE_MAX));
	out.push(...localTextProblem(v.body, 'body', BODY_MAX, BODY_MAX_SENTENCES));
	if (!Array.isArray(v.sources) || v.sources.length < MIN_SOURCES)
		out.push(`sources: at least ${MIN_SOURCES}`);
	else
		v.sources.forEach((s, i) => {
			if (!isRecord(s) || !isText(s.label, LABEL_MAX)) out.push(`sources[${i}].label`);
			if (!isRecord(s) || !httpsUrl(s.url)) out.push(`sources[${i}].url: an https address`);
		});
	if (
		typeof v.reviewedOn !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}$/.test(v.reviewedOn) ||
		Number.isNaN(Date.parse(`${v.reviewedOn}T00:00:00Z`))
	)
		out.push('reviewedOn: YYYY-MM-DD');
	if (!isText(v.reviewedBy, REVIEWER_MAX)) out.push('reviewedBy: who checked it');
	return out;
}

/** Every problem of the whole file: each entry's, plus duplicates of `date` + `year`. */
export function fileProblems(file: unknown): string[] {
	if (!Array.isArray(file)) return ['the file must be a JSON array'];
	const out: string[] = [];
	const seen = new Set<string>();
	file.forEach((entry, i) => {
		for (const p of entryProblems(entry)) out.push(`#${i} ${p}`);
		if (isRecord(entry)) {
			const key = `${String(entry.date)}/${String(entry.year)}`;
			if (seen.has(key)) out.push(`#${i} duplicate date and year ${key}`);
			seen.add(key);
		}
	});
	return out;
}

/** The valid entries of `file` (an invalid one is never shown, whatever else the file holds). */
export function validEntries(file: unknown): OnThisDayEntry[] {
	if (!Array.isArray(file)) return [];
	return file.filter((e) => entryProblems(e).length === 0) as OnThisDayEntry[];
}

/** The entry for the WIB date `today` (`YYYY-MM-DD`): the oldest event of that `MM-DD`, or null. */
export function onThisDay(
	entries: readonly OnThisDayEntry[],
	today: string
): OnThisDayEntry | null {
	const monthDay = today.slice(5, 10);
	return [...entries].filter((e) => e.date === monthDay).sort((a, b) => a.year - b.year)[0] ?? null;
}
