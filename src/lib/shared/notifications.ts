import { addDays, formatShortDay, wibDateParts, wibDateString, wibHour } from './dates.ts';
import { msg, type Translator } from './i18n.ts';
import { formatMoney } from './money-format.ts';

/**
 * FN-24 notifications: kinds, the fixed text templates, dedupe keys and the WIB schedule. Pure and shared, so
 * the app Worker (list, settings, goal milestones) and `workers/jobs` (cron and queue) use the same rules.
 *
 * A notification row stores its kind and the stored figures it was built from (`params`, JSON), never
 * rendered text: the list renders it in the reader's language, a push renders it in Indonesian (the jobs
 * Worker has no per-user language). No AI writes any of this copy.
 */

export const NOTIFICATION_KINDS = [
	'budget_80',
	'budget_100',
	'goal_milestone',
	'bill_reminder',
	'daily_nudge',
	'close_reminder',
	'weekly_summary'
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Kinds about one space's data (stored in `space_notifications`, purged with the space). */
export const SPACE_NOTIFICATION_KINDS = [
	'budget_80',
	'budget_100',
	'goal_milestone',
	'bill_reminder'
] as const;
export type SpaceNotificationKind = (typeof SPACE_NOTIFICATION_KINDS)[number];
/** Kinds about the user (stored in `user_notifications`, deleted with the account). */
export const USER_NOTIFICATION_KINDS = ['daily_nudge', 'close_reminder', 'weekly_summary'] as const;

export function isNotificationKind(value: string): value is NotificationKind {
	return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

export function isSpaceKind(kind: NotificationKind): kind is SpaceNotificationKind {
	return (SPACE_NOTIFICATION_KINDS as readonly string[]).includes(kind);
}

/** Settings rows (/pengaturan/notifikasi), one per kind, in NOTIFICATION_KINDS order. */
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, { label: string; hint: string }> = {
	budget_80: {
		label: msg('Anggaran 80%'),
		hint: msg('Saat pengeluaran bulan ini mencapai 80% anggaran')
	},
	budget_100: {
		label: msg('Anggaran habis'),
		hint: msg('Saat pengeluaran bulan ini mencapai anggaran')
	},
	goal_milestone: {
		label: msg('Target tabungan'),
		hint: msg('Saat tabungan mencapai setengah atau seluruh target')
	},
	bill_reminder: {
		label: msg('Tagihan langganan'),
		hint: msg('Beberapa hari sebelum langganan ditagih, sesuai pengaturan tiap langganan')
	},
	daily_nudge: {
		label: msg('Pengingat harian'),
		hint: msg('Sekitar pukul 07.00 WIB jika belum ada catatan hari ini')
	},
	close_reminder: {
		label: msg('Pengingat tutup hari'),
		hint: msg('Malam hari jika hari ini belum ditutup, pada jam yang kamu pilih')
	},
	weekly_summary: {
		label: msg('Ringkasan mingguan'),
		hint: msg('Senin pagi: pengeluaran minggu lalu')
	}
};

/** Every kind enabled unless a stored row says otherwise (default-on, owner decision 5). */
export function prefsFrom(
	rows: readonly { kind: string; enabled: boolean }[]
): Record<NotificationKind, boolean> {
	const prefs = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])) as Record<
		NotificationKind,
		boolean
	>;
	for (const row of rows) if (isNotificationKind(row.kind)) prefs[row.kind] = row.enabled;
	return prefs;
}

// ---- Figures stored with a notification (`params`) ----

interface BudgetParams {
	/** WIB month `YYYY-MM`. */
	month: string;
	currency: string;
	budgetMinor: number;
	/** Null: too large to show (never rounded). */
	spentMinor: number | null;
}

interface GoalParams {
	goalId: string;
	name: string;
	currency: string;
	threshold: GoalThreshold;
	savedMinor: number;
	targetMinor: number;
}

interface NudgeParams {
	/** WIB date `YYYY-MM-DD`. */
	date: string;
}

interface WeeklyParams {
	/** Monday and Sunday (WIB) of the summarised week. */
	from: string;
	to: string;
	currency: string;
	/** Null: too large to show. */
	spentMinor: number | null;
}

/** FN-26: a subscription charges on `chargeOn` (WIB); figures as stored on the subscription when created. */
interface BillParams {
	subscriptionId: string;
	name: string;
	currency: string;
	amountMinor: number;
	/** WIB date `YYYY-MM-DD` of the charge. */
	chargeOn: string;
}

/**
 * FN-26 (red team L1): the bills a recipient was not told about one by one today, past
 * BILL_REMINDERS_PER_DAY, grouped into one notification per space and WIB day. Names no subscription.
 */
interface BillGroupParams {
	count: number;
	/** WIB date `YYYY-MM-DD` of the day it was grouped. */
	date: string;
}

export type NotificationParams =
	BudgetParams | GoalParams | BillParams | BillGroupParams | NudgeParams | WeeklyParams;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const isStr = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length <= max;
const isMinor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isMinorOrNull = (v: unknown): v is number | null => v === null || isMinor(v);

/** The stored `params` of `kind`, or null when the JSON is not what that kind stores. */
export function parseParams(
	kind: NotificationKind,
	json: string | null
): NotificationParams | null {
	if (!json) return null;
	let v: unknown;
	try {
		v = JSON.parse(json);
	} catch {
		return null;
	}
	if (!isObj(v)) return null;
	switch (kind) {
		case 'budget_80':
		case 'budget_100':
			return isStr(v.month) &&
				isStr(v.currency, 3) &&
				isMinor(v.budgetMinor) &&
				isMinorOrNull(v.spentMinor)
				? {
						month: v.month,
						currency: v.currency,
						budgetMinor: v.budgetMinor,
						spentMinor: v.spentMinor
					}
				: null;
		case 'goal_milestone':
			return isStr(v.goalId) &&
				isStr(v.name, 200) &&
				isStr(v.currency, 3) &&
				(v.threshold === 50 || v.threshold === 100) &&
				isMinor(v.savedMinor) &&
				isMinor(v.targetMinor)
				? {
						goalId: v.goalId,
						name: v.name,
						currency: v.currency,
						threshold: v.threshold,
						savedMinor: v.savedMinor,
						targetMinor: v.targetMinor
					}
				: null;
		case 'bill_reminder':
			if (typeof v.count === 'number' && Number.isSafeInteger(v.count) && v.count > 0)
				return isStr(v.date, 10) ? { count: v.count, date: v.date } : null;
			return isStr(v.subscriptionId) &&
				isStr(v.name, 200) &&
				isStr(v.currency, 3) &&
				isMinor(v.amountMinor) &&
				isStr(v.chargeOn, 10)
				? {
						subscriptionId: v.subscriptionId,
						name: v.name,
						currency: v.currency,
						amountMinor: v.amountMinor,
						chargeOn: v.chargeOn
					}
				: null;
		case 'daily_nudge':
		case 'close_reminder':
			return isStr(v.date) ? { date: v.date } : null;
		case 'weekly_summary':
			return isStr(v.from) && isStr(v.to) && isStr(v.currency, 3) && isMinorOrNull(v.spentMinor)
				? { from: v.from, to: v.to, currency: v.currency, spentMinor: v.spentMinor }
				: null;
		default: {
			const unhandled: never = kind;
			throw new Error(`unknown kind ${String(unhandled)}`);
		}
	}
}

/** The in-app page a notification opens (a fixed same-origin path; never stored, never from input). */
export function notificationUrl(kind: NotificationKind, params: NotificationParams | null): string {
	switch (kind) {
		case 'budget_80':
		case 'budget_100':
			return '/';
		case 'goal_milestone': {
			const goalId = params && 'goalId' in params ? params.goalId : '';
			return /^[0-9a-f-]{1,64}$/.test(goalId) ? `/kekayaan/tabungan/${goalId}` : '/dompet';
		}
		case 'bill_reminder':
			return '/langganan';
		case 'daily_nudge':
			return '/riwayat/baru';
		case 'close_reminder':
			return '/beruntun';
		case 'weekly_summary':
			return '/laporan';
		default: {
			const unhandled: never = kind;
			throw new Error(`unknown kind ${String(unhandled)}`);
		}
	}
}

const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');

/**
 * Title and body of a notification in `t`'s language. `spaceName` is the space's display name (already
 * translated for a personal space); null for user-level kinds. Money goes through formatMoney only.
 */
export function notificationText(
	kind: NotificationKind,
	params: NotificationParams | null,
	t: Translator,
	spaceName: string | null
): { title: string; body: string } {
	const money = (minor: number | null, currency: string) =>
		minor === null ? t.tr(TOO_LARGE) : formatMoney(minor, currency);
	const space = spaceName ?? '';
	switch (kind) {
		case 'budget_80':
		case 'budget_100': {
			const p = params as BudgetParams | null;
			const title =
				kind === 'budget_80' ? t.tr('Anggaran hampir habis') : t.tr('Anggaran sudah habis');
			if (!p) return { title, body: t.trf('Ruang {space}', { space }) };
			return {
				title,
				body: t.trf('{spent} dari {budget} sudah terpakai bulan ini · {space}', {
					spent: money(p.spentMinor, p.currency),
					budget: formatMoney(p.budgetMinor, p.currency),
					space
				})
			};
		}
		case 'goal_milestone': {
			const p = params as GoalParams | null;
			if (!p) return { title: t.tr('Target tabungan'), body: '' };
			return {
				title:
					p.threshold === 100
						? t.trf('{name}: target tercapai', { name: p.name })
						: t.trf('{name}: setengah jalan', { name: p.name }),
				body: t.trf('{saved} dari {target} terkumpul · {space}', {
					saved: formatMoney(p.savedMinor, p.currency),
					target: formatMoney(p.targetMinor, p.currency),
					space
				})
			};
		}
		case 'bill_reminder': {
			if (params && 'count' in params)
				return {
					title: t.trf('{n} tagihan langganan lagi segera jatuh tempo', { n: params.count }),
					body: space
				};
			const p = params as BillParams | null;
			if (!p) return { title: t.tr('Tagihan langganan'), body: '' };
			return {
				title: t.trf('{name} segera ditagih', { name: p.name }),
				body: t.trf('{amount} pada {date} · {space}', {
					amount: formatMoney(p.amountMinor, p.currency),
					date: formatShortDay(p.chargeOn, t.locale),
					space
				})
			};
		}
		case 'daily_nudge':
			return {
				title: t.tr('Belum ada catatan hari ini'),
				body: t.tr('Catat pengeluaran hari ini selagi masih ingat.')
			};
		case 'close_reminder':
			return {
				title: t.tr('Hari ini belum ditutup'),
				body: t.tr('Periksa catatan hari ini, lalu tutup harinya agar beruntunmu terjaga.')
			};
		case 'weekly_summary': {
			const p = params as WeeklyParams | null;
			const title = t.tr('Ringkasan minggu lalu');
			if (!p) return { title, body: '' };
			return {
				title,
				body: t.trf('Pengeluaran {from}–{to}: {spent}', {
					from: formatShortDay(p.from, t.locale),
					to: formatShortDay(p.to, t.locale),
					spent: money(p.spentMinor, p.currency)
				})
			};
		}
		default: {
			const unhandled: never = kind;
			throw new Error(`unknown kind ${String(unhandled)}`);
		}
	}
}

// ---- Thresholds ----

export type BudgetThreshold = 80 | 100;
export type GoalThreshold = 50 | 100;

/**
 * The highest budget threshold `spentMinor` has reached (exact, BigInt): 100 at or past the budget, 80 at or
 * past 80 % of it, else null. Too large to show (null) is past every budget.
 */
export function budgetThreshold(
	spentMinor: number | null,
	budgetMinor: number
): BudgetThreshold | null {
	if (!Number.isSafeInteger(budgetMinor) || budgetMinor <= 0) return null;
	if (spentMinor === null) return 100;
	const spent = BigInt(spentMinor) * 100n;
	const budget = BigInt(budgetMinor);
	if (spent >= budget * 100n) return 100;
	if (spent >= budget * 80n) return 80;
	return null;
}

/** The highest goal milestone a saved percentage (FN-10 `goalProgressPercent`) has reached, or null. */
export function goalThreshold(percent: number): GoalThreshold | null {
	if (percent >= 100) return 100;
	if (percent >= 50) return 50;
	return null;
}

// ---- Dedupe keys: one notification per user, kind and key, ever (the unique index) ----

export const budgetDataKey = (spaceId: string, month: string, threshold: BudgetThreshold) =>
	`budget:${spaceId}:${month}:${threshold}`;
export const goalDataKey = (goalId: string, threshold: GoalThreshold) =>
	`goal:${goalId}:${threshold}`;
/** One grouped bill notification per recipient, space and WIB day (red team L1). */
export const billGroupDataKey = (spaceId: string, date: string) => `bills:${spaceId}:${date}`;
/** Most single bill reminders one recipient gets per WIB day; the rest of the day's are grouped (L1). */
export const BILL_REMINDERS_PER_DAY = 5;
export const nudgeDataKey = (date: string) => `nudge:${date}`;
/** FN-34b: one evening "belum ditutup" reminder per user and WIB date, whatever hour it was sent at. */
export const closeReminderDataKey = (date: string) => `close:${date}`;
export const weeklyDataKey = (weekStart: string) => `weekly:${weekStart}`;

// ---- WIB schedule ----

/** First and last WIB hour anything is sent (the jobs cron window, 06:00–23:59 WIB). */
const SEND_FROM_HOUR = 6;

/** 00:00–05:59 WIB: nothing is pushed (an in-app row may still be created, e.g. by the user's own write). */
export function isQuietHour(utcMs: number): boolean {
	return wibHour(utcMs) < SEND_FROM_HOUR;
}

/** Day of the week of a WIB date: 0 Sunday … 6 Saturday. */
export function wibWeekday(date: string): number {
	const { year, month, day } = wibDateParts(date);
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Monday (WIB) of the week containing `date`. */
export function weekStart(date: string): string {
	return addDays(date, -((wibWeekday(date) + 6) % 7));
}

/** Monday to Sunday (WIB) of the week before the one containing `date`. */
export function lastWeekRange(date: string): { from: string; to: string } {
	const from = addDays(weekStart(date), -7);
	return { from, to: addDays(from, 6) };
}

/** The daily nudge starts on the 07:00 WIB tick (owner decision 3); later ticks finish a large pass. */
const NUDGE_HOUR = 7;
/**
 * FN-34b evening reminder: the WIB hours a user may pick, exactly the hours the jobs cron ticks on (06–23), and
 * the default when no hour is stored (owner decision D).
 */
export const CLOSE_REMINDER_HOURS = [
	6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23
] as const;
export const CLOSE_REMINDER_DEFAULT_HOUR = 20;

/** A reminder hour from a form: a whole hour in CLOSE_REMINDER_HOURS, else null (refused, never clamped). */
export function parseReminderHour(raw: string): number | null {
	if (!/^\d{1,2}$/.test(raw)) return null;
	const hour = Number(raw);
	return (CLOSE_REMINDER_HOURS as readonly number[]).includes(hour) ? hour : null;
}

/** The weekly summary starts on Monday's first tick, 06:00 WIB (owner decision 2); later Monday ticks finish it. */
const WEEKLY_HOUR = 6;

/**
 * Which walks one cron tick at `utcMs` may run: budgets every tick; the nudge from 07:00 WIB and the weekly
 * summary on Monday from 06:00 WIB (the jobs cron keeps a stored position, so each pass runs once per day/week);
 * nothing at all in quiet hours.
 */
export function tickPlan(utcMs: number): {
	today: string;
	budgets: boolean;
	/** FN-26 bill reminders: every open tick, like budgets (the reminder window spans days; keys dedupe). */
	bills: boolean;
	/** FN-36 recurring instances: every open tick (each instance is created once per series and WIB date). */
	recurring: boolean;
	nudge: boolean;
	/** FN-34b: every open tick (each user's own hour is checked inside the guarded insert). */
	closeReminder: boolean;
	/** FN-34b: yesterday's budget-streak verdicts, once per day from the first open tick (06:00 WIB). */
	budgetStreak: boolean;
	weekly: boolean;
} {
	const today = wibDateString(utcMs);
	const hour = wibHour(utcMs);
	const open = !isQuietHour(utcMs);
	return {
		today,
		budgets: open,
		bills: open,
		recurring: open,
		nudge: open && hour >= NUDGE_HOUR,
		closeReminder: open,
		budgetStreak: open,
		weekly: open && hour >= WEEKLY_HOUR && wibWeekday(today) === 1
	};
}
