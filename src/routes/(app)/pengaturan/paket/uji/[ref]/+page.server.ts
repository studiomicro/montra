import { error, fail, redirect } from '@sveltejs/kit';
import { getCheckout } from '#lib/server/billing/checkout';
import { planStateOf } from '#lib/server/billing/gate';
import {
	CHECKOUT_ALREADY_PAID,
	CHECKOUT_FAILED,
	CHECKOUT_NOT_APPLIED,
	CHECKOUT_NOT_FOUND
} from '#lib/server/billing/messages';
import { deliverMockEvent } from '#lib/server/billing/mock-provider';
import { activeProvider } from '#lib/server/billing/provider';
import { getEnv } from '#lib/server/env';
import { readFormBody } from '#lib/server/forms';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// FN-30 mock checkout ("mode uji"): charges nothing, calls no provider. Exists only while the mock provider is
// active (BILLING_MOCK_ENABLED); otherwise every request is the same 404 as an unknown page. A checkout is
// looked up with locals.user.id: another account's reference, an unknown one and an expired one are one 404.

function mock() {
	const active = activeProvider(getEnv());
	if (!active || !active.testMode) error(404, 'Not found');
	return active;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	const active = mock();
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	const checkout = await getCheckout(
		locals.db,
		active.provider.id,
		user.id,
		params.ref,
		Date.now()
	);
	if (!checkout) error(404, 'Not found');
	return { checkout };
};

async function deliver(event: RequestEvent, outcome: 'succeeded' | 'failed') {
	const active = mock();
	await readFormBody(event.request);
	const user = event.locals.user;
	if (!user) redirect(303, '/masuk');
	const db = event.locals.db;
	const now = Date.now();
	const checkout = await getCheckout(db, active.provider.id, user.id, event.params.ref, now);
	if (!checkout) return fail(404, { error: CHECKOUT_NOT_FOUND });
	if (checkout.paid) return fail(409, { error: CHECKOUT_ALREADY_PAID });
	const status = await deliverMockEvent(event.fetch, active.secret, checkout, outcome, now);
	// Verified but granted nothing (red team L1): never shown as success.
	if (outcome === 'succeeded' && status === 'ignored_paid')
		return fail(409, { error: CHECKOUT_NOT_APPLIED });
	const expected = outcome === 'succeeded' ? 'applied' : 'recorded';
	if (status !== expected) return fail(502, { error: CHECKOUT_FAILED });
	if (outcome === 'failed') return { result: 'failed' as const };
	// What the plan is now, read back after the webhook's write (never assumed from the button pressed).
	const state = await planStateOf(db, user.id, Date.now());
	return { result: 'paid' as const, plan: state.plan, periodEnd: state.currentPeriodEnd };
}

export const actions: Actions = {
	pay: (event) => deliver(event, 'succeeded'),
	fail: (event) => deliver(event, 'failed')
};
