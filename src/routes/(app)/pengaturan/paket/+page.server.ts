import { error, fail, redirect } from '@sveltejs/kit';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { startCheckout } from '#lib/server/billing/checkout';
import { claimHashes } from '#lib/server/billing/claims';
import { creditBalance, planStateOf } from '#lib/server/billing/gate';
import { ledgerCursorParam, listLedger, parseLedgerCursor } from '#lib/server/billing/ledger';
import {
	BILLING_LOAD_FAILED,
	PLAN_INVALID,
	PLAN_LOWER,
	VOUCHER_ALREADY_REDEEMED,
	VOUCHER_INVALID,
	VOUCHER_PLAN_HIGHER,
	BILLING_THROTTLED
} from '#lib/server/billing/messages';
import { activeProvider } from '#lib/server/billing/provider';
import { refundsForUser } from '#lib/server/billing/refunds';
import {
	redeemVoucher,
	voucherAttemptLimited,
	type RedeemResult
} from '#lib/server/billing/vouchers';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { isPaidPlan } from '#lib/shared/billing/plans';
import { normalizeVoucherCode } from '#lib/shared/billing/voucher-code';
import type { Actions, PageServerLoad } from './$types';

// FN-30 "Paket & kredit". Billing is account-scoped: every load and action reads and writes only
// locals.user.id's own plan, ledger, redemptions and refund obligations. No route here takes a user id, so another account's
// data is unreachable by construction. hooks.server.ts answers signed-out requests first; the checks below
// only narrow the type and fail closed.

const VOUCHER_REFUSALS: Record<Extract<RedeemResult, { ok: false }>['reason'], string> = {
	not_found: VOUCHER_INVALID,
	expired: VOUCHER_INVALID,
	used_up: VOUCHER_INVALID,
	already_redeemed: VOUCHER_ALREADY_REDEEMED,
	plan_higher: VOUCHER_PLAN_HIGHER
};

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user;
	if (!user) redirect(303, '/masuk?next=%2Fpengaturan%2Fpaket');
	// Absent (not merely hidden) without the flag: the page never renders an upgrade path that cannot work.
	const mockCheckout = activeProvider(getEnv()) !== null;
	const now = Date.now();
	const cursor = parseLedgerCursor(url.searchParams.get('sebelum'));
	try {
		const [state, balance, ledger, refunds] = await Promise.all([
			planStateOf(locals.db, user.id, now),
			creditBalance(locals.db, user.id),
			listLedger(locals.db, user.id, cursor),
			refundsForUser(locals.db, user.id)
		]);
		const last = ledger.rows.at(-1);
		return {
			state,
			balance,
			ledger: ledger.rows,
			olderCursor: ledger.more && last ? ledgerCursorParam(last) : null,
			paged: cursor !== null,
			refunds,
			mockCheckout,
			loadError: null
		};
	} catch (e) {
		console.error('pengaturan/paket: load failed', e instanceof Error ? e.name : 'unknown');
		return {
			state: null,
			balance: null,
			ledger: [],
			olderCursor: null,
			paged: cursor !== null,
			refunds: [],
			mockCheckout,
			loadError: BILLING_LOAD_FAILED
		};
	}
};

export const actions: Actions = {
	/** "Tukar voucher": codes nobody can redeem get one uniform answer; refusals about the user's own state stay specific. */
	redeem: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const typed = textField(form, 'code').slice(0, 100);
		const code = normalizeVoucherCode(typed);
		if (!code) return fail(400, { action: 'redeem' as const, code: typed, error: VOUCHER_INVALID });
		const now = Date.now();
		if (await voucherAttemptLimited(locals.db, request, user.id, now))
			return fail(429, { action: 'redeem' as const, code: typed, error: BILLING_THROTTLED });
		const claim = await claimHashes(getEnv(), user.email);
		const result = await redeemVoucher(locals.db, user.id, code, now, claim);
		if (!result.ok)
			return fail(VOUCHER_REFUSALS[result.reason] === VOUCHER_INVALID ? 404 : 409, {
				action: 'redeem' as const,
				code: typed,
				error: VOUCHER_REFUSALS[result.reason]
			});
		return {
			action: 'redeem' as const,
			redeemed: { credits: result.credits, plan: result.plan, days: result.days }
		};
	},

	/**
	 * "Upgrade" (mode uji): exists only while the mock provider is active. Without it a direct POST gets the
	 * same 404 as an unknown action: the upgrade path is unreachable, not merely hidden.
	 */
	checkout: async ({ request, locals }) => {
		const active = activeProvider(getEnv());
		if (!active) error(404, 'Not found');
		const form = await readFormBody(request);
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const plan = textField(form, 'plan');
		if (!isPaidPlan(plan)) return fail(400, { action: 'checkout' as const, error: PLAN_INVALID });
		const now = Date.now();
		if (await overUserAttemptLimit(locals.db, user.id, now, 'billing-checkout'))
			return fail(429, { action: 'checkout' as const, error: BILLING_THROTTLED });
		const started = await startCheckout(locals.db, active.provider, user.id, plan, now);
		if (!started.ok) return fail(409, { action: 'checkout' as const, error: PLAN_LOWER });
		redirect(303, started.checkoutUrl);
	}
};
