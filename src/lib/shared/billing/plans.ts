import { msg } from '../i18n.ts';

/**
 * FN-30 plan catalogue: a plain data module (like subscriptions-catalogue.ts), changed by code review, never by
 * an admin screen. Plan names are generic tier words (Gratis / Pro / Agen), not any reference product's brand
 * terms. Every `priceMinor` is a PLACEHOLDER the owner has not approved: it is always shown behind the
 * "harga sementara" badge and never charged (only the mock provider exists, FN-30 scope item 4).
 *
 * Order matters: a plan later in PLANS ranks higher (planRank). Adding a plan needs a migration (the
 * `user_plan_state.plan` CHECK).
 */
export const PLANS = ['gratis', 'pro', 'agen'] as const;
export type Plan = (typeof PLANS)[number];
export const PAID_PLANS = ['pro', 'agen'] as const satisfies readonly Plan[];
export type PaidPlan = (typeof PAID_PLANS)[number];

export const BILLING_PERIODS = ['weekly', 'monthly'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/** Length of one paid period. A month is 30 days: a plan period is a duration, not a calendar month. */
export const PERIOD_DAYS: Record<BillingPeriod, number> = { weekly: 7, monthly: 30 };
export const DAY_MS = 86_400_000;

export interface PlanEntry {
	id: Plan;
	label: string;
	/** Placeholder price in IDR minor units (2 decimals): never final, always badged "harga sementara". */
	priceMinor: number;
	currency: 'IDR';
	billingPeriod: BillingPeriod;
	/** Credits granted with each paid period (FEATURES.md FN-30: Pro 1,000 a month). */
	monthlyCreditGrant: number;
	/** Longest Gmail look-back the plan allows (FEATURES.md: Free 7 days, Pro up to 12 months). */
	gmailLookbackMaxDays: number;
	/** Most spaces the account may be in, the personal one included (Free: the personal space only). */
	maxSpaces: number;
	agentEnabled: boolean;
}

export const PLAN_CATALOGUE: Record<Plan, PlanEntry> = {
	gratis: {
		id: 'gratis',
		label: msg('Gratis'),
		priceMinor: 0,
		currency: 'IDR',
		billingPeriod: 'monthly',
		monthlyCreditGrant: 0,
		gmailLookbackMaxDays: 7,
		maxSpaces: 1,
		agentEnabled: false
	},
	pro: {
		id: 'pro',
		label: msg('Pro'),
		priceMinor: 4_900_000,
		currency: 'IDR',
		billingPeriod: 'monthly',
		monthlyCreditGrant: 1_000,
		gmailLookbackMaxDays: 365,
		maxSpaces: 10,
		agentEnabled: false
	},
	agen: {
		id: 'agen',
		label: msg('Agen'),
		priceMinor: 9_900_000,
		currency: 'IDR',
		billingPeriod: 'monthly',
		monthlyCreditGrant: 1_000,
		gmailLookbackMaxDays: 365,
		maxSpaces: 10,
		agentEnabled: true
	}
};

/** What each plan adds, for the comparison cards (i18n phrases). */
export const PLAN_FEATURES: Record<Plan, readonly string[]> = {
	gratis: [
		msg('Catat manual, suara, struk dan mutasi'),
		msg('Anggaran dan laporan'),
		msg('Gmail: lihat ke belakang 7 hari'),
		msg('300 kredit awal')
	],
	pro: [
		msg('Semua di Gratis'),
		msg('1.000 kredit tiap periode'),
		msg('Gmail: lihat ke belakang sampai 12 bulan'),
		msg('Lebih banyak ruang, termasuk ruang bersama')
	],
	agen: [msg('Semua di Pro'), msg('Agen (beta)')]
};

/** Credits every new account starts with (FEATURES.md FN-30, owner decision 3). */
export const STARTER_CREDITS = 300;

export function isPlan(value: string): value is Plan {
	return (PLANS as readonly string[]).includes(value);
}

export function isPaidPlan(value: string): value is PaidPlan {
	return (PAID_PLANS as readonly string[]).includes(value);
}

/** 0 for Gratis, higher for a higher tier. */
export function planRank(plan: Plan): number {
	return PLANS.indexOf(plan);
}

/**
 * The plan in force at `now`: a paid plan whose period has ended (or never had one) is Gratis again. Its
 * features stop; the account's data stays (FEATURES.md FN-30).
 */
export function effectivePlan(
	state: { plan: Plan; currentPeriodEnd: number | null } | null,
	now: number
): Plan {
	if (!state || state.plan === 'gratis') return 'gratis';
	return state.currentPeriodEnd !== null && state.currentPeriodEnd > now ? state.plan : 'gratis';
}
