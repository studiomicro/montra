import { fail, redirect } from '@sveltejs/kit';
import {
	TOKEN_LIFETIME_INVALID,
	TOKEN_LIMIT,
	TOKEN_NAME_REQUIRED,
	TOKEN_NOT_FOUND,
	TOKEN_SCOPE_INVALID,
	TOKEN_SPACE_UNAVAILABLE,
	TOKENS_LOAD_FAILED
} from '#lib/server/api/messages';
import { createApiToken, listApiTokens, revokeApiToken } from '#lib/server/auth/api-tokens';
import { CHANGED_MEANWHILE } from '#lib/server/account-keys/messages';
import { proveCurrentPassword } from '#lib/server/auth/prove-password';
import { readFormBody, textField } from '#lib/server/forms';
import { listSpaces } from '#lib/server/spaces/spaces';
import { errorLabel } from '#lib/server/util';
import {
	API_TOKEN_DEFAULT_LIFETIME_DAYS,
	API_TOKEN_LIFETIME_DAYS,
	API_TOKEN_MAX_PER_USER,
	API_TOKEN_NAME_MAX_LENGTH,
	isApiTokenLifetime,
	isApiTokenScope
} from '#lib/shared/api-tokens';
import { cleanText } from '#lib/shared/text';
import type { Actions, PageServerLoad } from './$types';

// FN-38 token management. Account-level, like /pengaturan/akun: every load and action works on locals.user only
// (the session's user, never an id from the form); creating a token re-proves the current password. A
// restricted token's space is checked inside the insert (createApiToken: a live membership), so a space the
// user left meanwhile is refused. The raw token is in the create action's response only; the page data never
// carries a token or its hash.

const ID_MAX_LENGTH = 64;

function signedIn(locals: App.Locals) {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	return user;
}

export const load: PageServerLoad = async ({ locals }) => {
	const user = signedIn(locals);
	const base = {
		maxTokens: API_TOKEN_MAX_PER_USER,
		nameMaxLength: API_TOKEN_NAME_MAX_LENGTH,
		lifetimes: [...API_TOKEN_LIFETIME_DAYS],
		defaultLifetime: API_TOKEN_DEFAULT_LIFETIME_DAYS
	};
	try {
		const [tokens, spaces] = await Promise.all([
			listApiTokens(locals.db, user.id, Date.now()),
			listSpaces(locals.db, user.id)
		]);
		return {
			...base,
			tokens,
			spaces: spaces.map(({ id, kind, name }) => ({ id, kind, name })),
			loadError: null
		};
	} catch (e) {
		console.error('pengaturan/api: load failed', errorLabel(e));
		return { ...base, tokens: [], spaces: [], loadError: TOKENS_LOAD_FAILED };
	}
};

export const actions: Actions = {
	/** "Buat token": the raw token is returned in this response only, shown once by the page. */
	create: async (event) => {
		const { request, locals } = event;
		const form = await readFormBody(request);
		signedIn(locals);
		const name = cleanText(textField(form, 'name'), API_TOKEN_NAME_MAX_LENGTH);
		const scope = textField(form, 'scope');
		const space = textField(form, 'space');
		const lifetime = Number(textField(form, 'lifetime'));
		const values = { name, scope, space, lifetime: String(lifetime) };
		if (!name) return fail(400, { error: TOKEN_NAME_REQUIRED, values });
		if (!isApiTokenScope(scope)) return fail(400, { error: TOKEN_SCOPE_INVALID, values });
		if (!isApiTokenLifetime(lifetime)) return fail(400, { error: TOKEN_LIFETIME_INVALID, values });
		if (space.length > ID_MAX_LENGTH) return fail(404, { error: TOKEN_SPACE_UNAVAILABLE, values });
		// Red team L2: a token outlives the session that made it, so making one re-proves the password.
		const proof = await proveCurrentPassword(event, textField(form, 'password'));
		if (!proof.ok) return fail(proof.status, { error: proof.error, values });
		const created = await createApiToken(
			locals.db,
			proof.user.id,
			{ name, scope, restrictedSpaceId: space || null, lifetimeDays: lifetime },
			proof.hash,
			Date.now()
		);
		if (!created.ok)
			return created.reason === 'limit'
				? fail(409, { error: TOKEN_LIMIT, values })
				: created.reason === 'credential'
					? fail(409, { error: CHANGED_MEANWHILE, values })
					: fail(404, { error: TOKEN_SPACE_UNAVAILABLE, values });
		return { created: { token: created.token, name, expiresAt: created.expiresAt } };
	},

	/** "Cabut": the token stops working on its next request. */
	revoke: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const tokenId = textField(form, 'tokenId');
		const revoked =
			tokenId.length <= ID_MAX_LENGTH &&
			(await revokeApiToken(locals.db, user.id, tokenId, Date.now()));
		if (!revoked) return fail(404, { error: TOKEN_NOT_FOUND });
		return { done: 'revoked' as const };
	}
};
