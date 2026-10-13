import { error } from '@sveltejs/kit';
import { isAdminAccount } from '#lib/server/admin';
import { isAiGatewayConfigured } from '#lib/server/ai-keys/anthropic';
import { isAiKeysConfigured } from '#lib/server/ai-keys/crypto';
import { countUsersWithKey } from '#lib/server/ai-keys/repo';
import { isClaimHashConfigured } from '#lib/server/billing/claims';
import { pendingRefunds } from '#lib/server/billing/refunds';
import { isConnectedAppsConfigured } from '#lib/server/connected-apps/crypto';
import { getEnv } from '#lib/server/env';
import { turnstileState, type TurnstileEnv } from '#lib/server/auth/turnstile';
import { isPushConfigured } from '#lib/server/push/vapid';
import { errorLabel } from '#lib/server/util';
import type { PageServerLoad } from './$types';

// FN-41 admin status view: which app-wide secrets are configured, as names and booleans only (never a value, a
// partial value or a hash of one), a count of users with a personal AI key and the pending refund obligations
// (FN-30 hardening: provider, reference, amount, reason and date; nothing that identifies a person). Read-only: no
// actions.
//
// Deliberately outside the `(app)` group: the auth gate does not redirect it, so a signed-out visitor, a signed-in
// account whose id is not listed in ADMIN_ACCOUNT_IDS and every visitor while ADMIN_ACCOUNT_IDS is unset get the
// same answer: the root 404 page, as for a path that does not exist (the route's existence is not an oracle).

/** A secret's presence: set to something other than whitespace. Its value is never read further. */
const present = (value: string | undefined) => (value ?? '').trim() !== '';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	const env = getEnv() as Env & { APP_ENV?: string };
	const user = locals.user;
	if (!user || !(await isAdminAccount(env, user.id))) error(404, 'Not Found');
	setHeaders({ 'cache-control': 'no-store' });
	const vapid = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter(present);
	let keyCount: number | null = null;
	try {
		keyCount = await countUsersWithKey(locals.db, 'anthropic');
	} catch (e) {
		console.error('pengaturan/integrasi/admin: count failed', errorLabel(e));
	}
	let refunds: Awaited<ReturnType<typeof pendingRefunds>> | null = null;
	try {
		refunds = await pendingRefunds(locals.db);
	} catch (e) {
		console.error('pengaturan/integrasi/admin: refunds failed', errorLabel(e));
	}
	return {
		// "all three or none" (RUNBOOK › Web Push): complete, partly set, or not set.
		webPush: isPushConfigured(env) ? 'ok' : vapid.length > 0 ? 'partial' : 'missing',
		// FN-50 "both or none": the bot check is on only with both values; one value is partial (behaves as unset).
		turnstile: turnstileState(env as TurnstileEnv),
		connectedApps: {
			configured: isConnectedAppsConfigured(env),
			previous: present(env.CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS)
		},
		aiKeys: {
			configured: isAiKeysConfigured(env),
			previous: present(env.AI_KEYS_ENCRYPTION_KEY_PREVIOUS)
		},
		claimHash: {
			configured: isClaimHashConfigured(env),
			previous: present(env.CLAIM_HASH_KEY_PREVIOUS)
		},
		supportEmail: present(env.SUPPORT_EMAIL),
		aiGateway: isAiGatewayConfigured(env),
		billingMock: {
			enabled: env.BILLING_MOCK_ENABLED === '1',
			webhookSecret: present(env.MOCK_PAYMENT_WEBHOOK_SECRET)
		},
		// Not a secret: the deployment's name, so the owner can see the billing mock is never on in production.
		appEnv: env.APP_ENV?.trim().slice(0, 32) || null,
		keyCount,
		refunds
	} as const;
};
