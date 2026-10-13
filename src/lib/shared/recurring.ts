import { addDays } from './dates.ts';
import { msg, type Translator } from './i18n.ts';
import { nextChargeOn, WEEKDAY_LABELS } from './subscriptions.ts';

/**
 * FN-36 recurring transactions: the schedule rules, shared by the app Worker (series pages) and `workers/jobs`
 * (the cron that creates due instances). The date math is the subscriptions' (`nextChargeOn`, FN-26): a
 * monthly day past a short month's end is clamped to its last day, a weekly day is an ISO weekday. All dates
 * are WIB calendar dates (`YYYY-MM-DD`; WIB is UTC+7 all year, no daylight saving).
 */

/** Only expense and income repeat this pass (owner decision A: no transfers, never a balance adjustment). */
export const RECURRING_TYPES = ['expense', 'income'] as const;
export type RecurringType = (typeof RECURRING_TYPES)[number];

/** Owner decision D: monthly by day of month, weekly by weekday. */
export const RECURRING_FREQUENCIES = ['monthly', 'weekly'] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export const RECURRING_STATUSES = ['active', 'paused', 'stopped'] as const;
export type RecurringStatus = (typeof RECURRING_STATUSES)[number];

/**
 * Why the cron could not create a due instance ("Perlu perhatian"): `limit` the space is at its transaction cap
 * (left due, retried every tick); `refs` the wallet or category is archived, hidden or gone; `member` the member
 * the series runs for is no longer in the space.
 */
export const RECURRING_ATTENTION = ['limit', 'refs', 'member'] as const;
export type RecurringAttention = (typeof RECURRING_ATTENTION)[number];

export interface RecurringSchedule {
	frequency: RecurringFrequency;
	/** Day of month 1–31 (monthly) or ISO weekday 1–7, Monday = 1 (weekly). */
	day: number;
}

/** True when `day` is a real day for `frequency` (the same rule as the table's CHECK). */
export function isValidRecurringSchedule(s: RecurringSchedule): boolean {
	return (
		Number.isInteger(s.day) &&
		s.day >= 1 &&
		s.day <= (s.frequency === 'monthly' ? 31 : s.frequency === 'weekly' ? 7 : 0)
	);
}

/** The first run of `schedule` on or after the WIB date `from` (a run due on `from` is that day's run). */
export function nextRunOn(schedule: RecurringSchedule, from: string): string {
	if (!isValidRecurringSchedule(schedule)) throw new RangeError('invalid recurring schedule');
	return nextChargeOn({ cycle: schedule.frequency, day: schedule.day, month: null }, from);
}

/** The run after `current` (what the cron advances `next_run_on` to once `current` exists). */
export function followingRun(schedule: RecurringSchedule, current: string): string {
	return nextRunOn(schedule, addDays(current, 1));
}

/**
 * Where a series (re)starts: the first run on or after both its start date and `today`, so creating a series
 * with a past start, resuming a paused one or fixing a flagged one never backfills a passed date (owner
 * decision B).
 */
export function restartRunOn(schedule: RecurringSchedule, startOn: string, today: string): string {
	return nextRunOn(schedule, startOn > today ? startOn : today);
}

/** The dedupe key of the instance of `seriesId` for the WIB date `runOn` (one per series and date, ever). */
export const recurringDedupeKey = (seriesId: string, runOn: string) =>
	`recurring:${seriesId}:${runOn}`;

/** "Tiap tanggal 12" / "Tiap minggu pada Senin". */
export function scheduleLabel(schedule: RecurringSchedule, t: Pick<Translator, 'tr' | 'trf'>) {
	if (schedule.frequency === 'monthly') return t.trf('Tiap tanggal {n}', { n: schedule.day });
	return t.trf('Tiap minggu pada {hari}', {
		hari: t.tr(WEEKDAY_LABELS[schedule.day - 1] ?? '')
	});
}

export const RECURRING_STATUS_LABELS: Readonly<Record<RecurringStatus, string>> = {
	active: msg('Aktif'),
	paused: msg('Dijeda'),
	stopped: msg('Dihentikan')
};

export const RECURRING_ATTENTION_HINTS: Readonly<Record<RecurringAttention, string>> = {
	limit: msg(
		'Ruang ini sudah mencapai batas transaksi. Transaksi berikutnya dicoba lagi tiap jam.'
	),
	refs: msg('Dompet atau kategorinya sudah diarsipkan, disembunyikan atau dihapus. Ubah seri ini.'),
	member: msg(
		'Pembuat seri ini sudah tidak ada di ruang ini. Ubah seri untuk melanjutkannya atas namamu.'
	)
};

/** The series form's fields as typed (a refused no-JavaScript form echoes them back; never stored as such). */
export interface RecurringFormValues {
	type: string;
	/** Whole units, grouped as typed (`25.000`). */
	amount: string;
	walletId: string;
	categoryId: string;
	title: string;
	note: string;
	frequency: string;
	/** Day of month (monthly). */
	day: string;
	/** ISO weekday 1–7 (weekly). */
	weekday: string;
	startOn: string;
	endOn: string;
}
