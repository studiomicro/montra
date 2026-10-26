import { describe, expect, it } from 'vitest';
import { agentEnabled, canUseSharedSpaces, gmailLookbackMaxDays } from '#lib/server/billing/gate';
import { formatCreditDelta, formatCredits, MAX_LEDGER_DELTA } from './credits';
import {
	effectivePlan,
	isPaidPlan,
	PLAN_CATALOGUE,
	PLANS,
	planRank,
	STARTER_CREDITS
} from './plans';

describe('plan catalogue', () => {
	it('has Gratis, Pro and Agen in rank order, all IDR integer placeholder prices', () => {
		expect(PLANS).toEqual(['gratis', 'pro', 'agen']);
		for (const plan of PLANS) {
			const entry = PLAN_CATALOGUE[plan];
			expect(entry.id).toBe(plan);
			expect(entry.currency).toBe('IDR');
			expect(Number.isSafeInteger(entry.priceMinor)).toBe(true);
			expect(entry.priceMinor).toBeGreaterThanOrEqual(0);
		}
		expect(planRank('gratis')).toBeLessThan(planRank('pro'));
		expect(planRank('pro')).toBeLessThan(planRank('agen'));
	});

	it('grants a non-zero whole number of credits per paid period (a zero ledger row is refused)', () => {
		for (const plan of ['pro', 'agen'] as const) {
			const grant = PLAN_CATALOGUE[plan].monthlyCreditGrant;
			expect(Number.isSafeInteger(grant) && grant > 0 && grant <= MAX_LEDGER_DELTA).toBe(true);
		}
		expect(STARTER_CREDITS).toBe(300);
	});

	it('recognises paid plan ids only', () => {
		expect(isPaidPlan('gratis')).toBe(false);
		expect(isPaidPlan('agen')).toBe(true);
		expect(isPaidPlan('__proto__')).toBe(false);
	});
});

describe('gate helpers, table-driven over every plan', () => {
	const table = [
		{ plan: 'gratis', shared: false, lookback: 7, agent: false },
		{ plan: 'pro', shared: true, lookback: 365, agent: false },
		{ plan: 'agen', shared: true, lookback: 365, agent: true }
	] as const;
	it.each(table)('$plan', ({ plan, shared, lookback, agent }) => {
		expect(canUseSharedSpaces(plan)).toBe(shared);
		expect(gmailLookbackMaxDays(plan)).toBe(lookback);
		expect(gmailLookbackMaxDays(plan)).toBe(PLAN_CATALOGUE[plan].gmailLookbackMaxDays);
		expect(agentEnabled(plan)).toBe(agent);
	});
});

describe('effectivePlan', () => {
	const now = 1_800_000_000_000;
	it('is Gratis without state, on Gratis, and once a paid period has ended', () => {
		expect(effectivePlan(null, now)).toBe('gratis');
		expect(effectivePlan({ plan: 'gratis', currentPeriodEnd: null }, now)).toBe('gratis');
		expect(effectivePlan({ plan: 'pro', currentPeriodEnd: now }, now)).toBe('gratis');
		expect(effectivePlan({ plan: 'pro', currentPeriodEnd: null }, now)).toBe('gratis');
	});
	it('is the paid plan while its period runs', () => {
		expect(effectivePlan({ plan: 'agen', currentPeriodEnd: now + 1 }, now)).toBe('agen');
	});
});

describe('credit formatting (credits are not money)', () => {
	it('groups digits per locale with no currency symbol', () => {
		expect(formatCredits(1250, 'id')).toBe('1.250');
		expect(formatCredits(1250, 'en')).toBe('1,250');
		expect(formatCredits(0, 'id')).toBe('0');
		expect(formatCredits(-20, 'id')).toBe('−20');
		expect(formatCredits(300, 'id')).not.toMatch(/Rp|IDR/);
	});
	it('signs ledger deltas with + and U+2212', () => {
		expect(formatCreditDelta(300, 'id')).toBe('+300');
		expect(formatCreditDelta(-1000, 'en')).toBe('−1,000');
	});
});
