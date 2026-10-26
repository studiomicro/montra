import { addDays, daysBetween, monthRange, pad, wibDateParts } from './dates.ts';
import { msg } from './i18n.ts';

/**
 * FN-26 subscriptions (Langganan): billing cycles, the next-charge date in WIB, the monthly estimate and the
 * bill-reminder window. Pure and shared, so the app Worker and `workers/jobs` use the same rules.
 */

export const BILLING_CYCLES = ['monthly', 'yearly', 'weekly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const BILLING_CYCLE_LABELS: Readonly<Record<BillingCycle, string>> = {
	monthly: msg('Bulanan'),
	yearly: msg('Tahunan'),
	weekly: msg('Mingguan')
};

/** ISO weekdays, index 0 = Monday (billing day 1) … 6 = Sunday (billing day 7). */
export const WEEKDAY_LABELS: readonly string[] = [
	msg('Senin'),
	msg('Selasa'),
	msg('Rabu'),
	msg('Kamis'),
	msg('Jumat'),
	msg('Sabtu'),
	msg('Minggu')
];

export const SUBSCRIPTION_NAME_MAX_LENGTH = 60;
/** Most days before the charge a reminder may come (PRD: 0–14). */
export const REMINDER_DAYS_MAX = 14;
export const REMINDER_DAYS_DEFAULT = 2;

/**
 * When a subscription charges. `day`: 1–31 for monthly; 1–7 (ISO weekday, Monday = 1) for weekly; for
 * yearly, the day of `month` (1–12), at most that month's length in a leap year (so 29 February is allowed).
 * `month` is null unless the cycle is yearly.
 */
export interface BillingSchedule {
	cycle: BillingCycle;
	day: number;
	month: number | null;
}

/** Days in month `month` (1–12) of `year`, through the shared month range (never a hand-rolled table). */
function daysInMonth(year: number, month: number): number {
	return wibDateParts(monthRange(`${String(year).padStart(4, '0')}-${pad(month)}`).to).day;
}

/** True when `schedule` names a real billing day for its cycle (the same rule the DB CHECK enforces). */
export function isValidSchedule(schedule: BillingSchedule): boolean {
	const { cycle, day, month } = schedule;
	if (!Number.isInteger(day)) return false;
	if (cycle === 'monthly') return month === null && day >= 1 && day <= 31;
	if (cycle === 'weekly') return month === null && day >= 1 && day <= 7;
	return (
		month !== null &&
		Number.isInteger(month) &&
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth(2024, month)
	);
}

/**
 * The date `day` of `year`-`month`, moved to the month's last real day when the month is shorter: billing day
 * 31 charges on 30 April, 28 February (29 in a leap year); a yearly 29 February charges on 28 February in other
 * years. The same rule a bank applies to a standing order.
 */
function clampedDate(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

/** ISO weekday of a WIB date: 1 = Monday … 7 = Sunday (1970-01-05 was a Monday). */
export function isoWeekday(date: string): number {
	return (((daysBetween('1970-01-05', date) % 7) + 7) % 7) + 1;
}

/**
 * The first charge date of `schedule` on or after the WIB date `from` (`YYYY-MM-DD`). A charge due on `from`
 * itself is that day's charge, so `nextChargeOn(s, today)` is today until it is marked paid. Month-end days are
 * clamped (see `clampedDate`). Throws RangeError for an invalid schedule or date.
 */
export function nextChargeOn(schedule: BillingSchedule, from: string): string {
	if (!isValidSchedule(schedule)) throw new RangeError('invalid billing schedule');
	const { year, month } = wibDateParts(from);
	if (schedule.cycle === 'weekly') return addDays(from, (schedule.day - isoWeekday(from) + 7) % 7);
	if (schedule.cycle === 'monthly') {
		const here = clampedDate(year, month, schedule.day);
		if (here >= from) return here;
		return month === 12
			? clampedDate(year + 1, 1, schedule.day)
			: clampedDate(year, month + 1, schedule.day);
	}
	const billingMonth = schedule.month as number;
	const here = clampedDate(year, billingMonth, schedule.day);
	return here >= from ? here : clampedDate(year + 1, billingMonth, schedule.day);
}

/**
 * The next charge to show and act on: the stored `next_charge_on` while it is still ahead of `today` (a
 * charge already marked paid), else recomputed from scratch from the schedule and `today` (never a stale,
 * past date). A stored date that is not an occurrence of the schedule moves to the next one that is.
 */
export function effectiveNextCharge(
	schedule: BillingSchedule,
	stored: string,
	today: string
): string {
	return nextChargeOn(schedule, stored > today ? stored : today);
}

/** The charge after `current` (what "Tandai sudah dibayar" advances to). */
export function followingCharge(schedule: BillingSchedule, current: string): string {
	return nextChargeOn(schedule, addDays(current, 1));
}

/**
 * True when the bill reminder for the charge on `next` is due on `today`: from `daysBefore` days ahead up to
 * the charge day itself (so a missed cron day still reminds), never after.
 */
export function isBillReminderDue(next: string, daysBefore: number, today: string): boolean {
	const left = daysBetween(today, next);
	return left >= 0 && left <= daysBefore;
}

/** Dedupe key of a bill reminder: one per subscription and charge date, so a cycle never reminds twice. */
export const billReminderDataKey = (subscriptionId: string, next: string) =>
	`bill:${subscriptionId}:${next}`;

/** An amount in one currency as the list and the monthly estimate read it. */
export interface CycleAmount {
	amountMinor: number;
	currency: string;
	cycle: BillingCycle;
}

/** One currency's monthly estimate; `totalMinor` null when it is past the safe integer range. */
export interface MonthlyTotal {
	currency: string;
	totalMinor: number | null;
}

/**
 * The "≈ per month" estimate, one per currency (never added across currencies): monthly amounts as they are,
 * yearly ÷ 12, weekly × 52 ÷ 12. Summed exactly as BigInt twelfths and floored once, so the figure never
 * overstates. IDR first, then the other codes alphabetically.
 */
export function monthlyTotals(items: readonly CycleAmount[]): MonthlyTotal[] {
	const twelfths = new Map<string, bigint>();
	for (const { amountMinor, currency, cycle } of items) {
		const factor = cycle === 'monthly' ? 12n : cycle === 'yearly' ? 1n : 52n;
		twelfths.set(currency, (twelfths.get(currency) ?? 0n) + BigInt(amountMinor) * factor);
	}
	const max = BigInt(Number.MAX_SAFE_INTEGER);
	return [...twelfths]
		.map(([currency, sum]) => {
			const total = sum / 12n;
			return { currency, totalMinor: total <= max ? Number(total) : null };
		})
		.sort((a, b) =>
			a.currency === b.currency
				? 0
				: a.currency === 'IDR'
					? -1
					: b.currency === 'IDR'
						? 1
						: a.currency < b.currency
							? -1
							: 1
		);
}

/** The add/edit form's fields as typed (a refused no-JS form echoes them back; never stored as such). */
export interface SubscriptionFormValues {
	catalogueId: string;
	name: string;
	category: string;
	/** Whole units, grouped as typed (`186.000`). */
	amount: string;
	currency: string;
	cycle: string;
	/** Day of month (monthly, yearly). */
	day: string;
	/** ISO weekday 1–7 (weekly). */
	weekday: string;
	/** Month 1–12 (yearly). */
	month: string;
	walletId: string;
	reminderDays: string;
}
