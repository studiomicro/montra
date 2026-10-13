import { dev } from '$app/env';
import { error } from '@sveltejs/kit';
import { getAccountKeyStatus } from '#lib/server/account-keys/repo';
import { devRoutesEnabled } from '#lib/server/dev';
import { getEnv } from '#lib/server/env';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!devRoutesEnabled(getEnv() as { DEV_ROUTES?: string }, dev)) error(404);
	// The seal/unseal demonstration (FN-21) seals to the signed-in user's own public key: the only key data
	// this page gets, and only the user's own.
	const key = locals.user ? await getAccountKeyStatus(locals.db, locals.user.id) : null;
	return { accountPublicKey: key?.publicKey ?? null };
};
