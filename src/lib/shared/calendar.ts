import { isDateString, isMonthString, monthOf, monthRange, shiftMonth } from './dates.ts';
import { nextRunOn, followingRun, type RecurringSchedule } from './recurring.ts';
import { followingCharge, type BillingSchedule } from './subscriptions.ts';

/**
 * FN-54 Part C: the month view behind Beranda's date badge (`/kalender`). Pure rules shared by the route and its
 * tests; every date is a WIB calendar date.
 */

/** Months before this WIB month the calendar may show (owner decision 8: 23 back, this month, 2 ahead). */
const CALENDAR_MONTHS_BACK = 23;
const CALENDAR_MONTHS_AHEAD = 2;
/** Most charges or runs listed per item and month (a weekly item has at most 5 in a month). */
export const MAX_STEPS = 40;

/** The month `?bulan=` asks for, when it is a real month inside the window; else this WIB month (no error). */
export function calendarMonth(param: string | null, thisMonth: string): string {
	if (param === null || param.length !== 7 || !isMonthString(param)) return thisMonth;
	const first = shiftMonth(thisMonth, -CALENDAR_MONTHS_BACK);
	const last = shiftMonth(thisMonth, CALENDAR_MONTHS_AHEAD);
	return param >= first && param <= last ? param : thisMonth;
}

/** The day `?hari=` asks for, only when it is a real date in `month`; else null (ignored). */
export function calendarDay(param: string | null, month: string): string | null {
	if (param === null || param.length !== 10 || !isDateString(param)) return null;
	return monthOf(param) === month ? param : null;
}

/** The stepper's neighbours of `month` inside the window (null at its ends). */
export function calendarNeighbours(
	month: string,
	thisMonth: string
): { prev: string | null; next: string | null } {
	const prev = shiftMonth(month, -1);
	const next = shiftMonth(month, 1);
	return {
		prev: prev >= shiftMonth(thisMonth, -CALENDAR_MONTHS_BACK) ? prev : null,
		next: next <= shiftMonth(thisMonth, CALENDAR_MONTHS_AHEAD) ? next : null
	};
}

/** `/kalender` for `month` (and `day`), this month without a query. */
export function calendarHref(month: string, thisMonth: string, day?: string | null): string {
	const params = new URLSearchParams();
	if (month !== thisMonth || day) params.set('bulan', month);
	if (day) params.set('hari', day);
	const query = params.toString();
	return query ? `/kalender?${query}` : '/kalender';
}

export interface DueSubscription {
	id: string;
	name: string;
	amountMinor: number;
	currency: string;
	schedule: BillingSchedule;
	/** The next charge on or after today (`effectiveNextCharge`, as the subscription list computes it). */
	nextChargeOn: string;
	walletName: string | null;
	isDemo: boolean;
}

export interface DueSeries {
	id: string;
	type: 'expense' | 'income';
	title: string | null;
	category: { name: string; isPreset: boolean } | null;
	amountMinor: number;
	currency: string;
	schedule: RecurringSchedule;
	startOn: string;
	endOn: string | null;
	nextRunOn: string;
	status: 'active' | 'paused' | 'stopped';
	walletName: string | null;
}

export interface DueItem {
	date: string;
	kind: 'subscription' | 'recurring';
	id: string;
	type: 'expense' | 'income';
	/** A subscription's name, or a series' title (null: the UI names it by its category). */
	title: string | null;
	category: { name: string; isPreset: boolean } | null;
	amountMinor: number;
	currency: string;
	walletName: string | null;
	isDemo: boolean;
}

/** Dates of a schedule from `start` (an occurrence), stepped by `next`, inside [from, to], at most MAX_STEPS. */
function occurrences(
	start: string,
	from: string,
	to: string,
	next: (d: string) => string,
	end: string | null
): string[] {
	const out: string[] = [];
	let d = start;
	for (let step = 0; step < MAX_STEPS && d <= to && (end === null || d <= end); step++) {
		if (d >= from) out.push(d);
		d = next(d);
	}
	return out;
}

/**
 * Bills and recurring items still to come in `month`, on dates on or after `today` only (a past day shows what
 * happened, never a projection): each live subscription's charges from its next charge on (stepped with
 * `followingCharge`, so day 31 lands where the subscription page says), and each **active** series' runs from its
 * next run on (never past `end_on`). Sorted by date, then subscriptions before series, then id.
 */
export function upcomingInMonth(
	month: string,
	today: string,
	subscriptions: readonly DueSubscription[],
	series: readonly DueSeries[]
): DueItem[] {
	const range = monthRange(month);
	if (range.to < today) return [];
	const from = range.from > today ? range.from : today;
	const items: DueItem[] = [];
	for (const s of subscriptions) {
		const start = s.nextChargeOn >= today ? s.nextChargeOn : today;
		for (const date of occurrences(
			start,
			from,
			range.to,
			(d) => followingCharge(s.schedule, d),
			null
		))
			items.push({
				date,
				kind: 'subscription',
				id: s.id,
				type: 'expense',
				title: s.name,
				category: null,
				amountMinor: s.amountMinor,
				currency: s.currency,
				walletName: s.walletName,
				isDemo: s.isDemo
			});
	}
	for (const r of series) {
		if (r.status !== 'active') continue;
		const after = [r.nextRunOn, r.startOn, today].sort().at(-1) as string;
		const start = nextRunOn(r.schedule, after);
		for (const date of occurrences(
			start,
			from,
			range.to,
			(d) => followingRun(r.schedule, d),
			r.endOn
		))
			items.push({
				date,
				kind: 'recurring',
				id: r.id,
				type: r.type,
				title: r.title,
				category: r.category,
				amountMinor: r.amountMinor,
				currency: r.currency,
				walletName: r.walletName,
				isDemo: false
			});
	}
	const order = { subscription: 0, recurring: 1 } as const;
	return items.sort(
		(a, b) =>
			(a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
			order[a.kind] - order[b.kind] ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}
