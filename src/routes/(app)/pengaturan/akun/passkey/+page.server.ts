import { fail, redirect } from '@sveltejs/kit';
import {
	PASSKEY_HOST_UNAVAILABLE,
	PASSKEY_LIMIT,
	PASSKEY_NOT_FOUND,
	PASSKEY_REGISTER_FAILED,
	TOO_MANY_ATTEMPTS
} from '#lib/server/auth/messages';
import {
	passkeyOrigin,
	passkeyRpId,
	readRegistrationForm,
	registrationOptions,
	verifyRegistrationFor
} from '#lib/server/auth/passkey-flow';
import { listPasskeys, removePasskey } from '#lib/server/auth/passkeys';
import { proveCurrentPassword } from '#lib/server/auth/prove-password';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { ID_MAX_LENGTH, readFormBody, textField } from '#lib/server/forms';
import { errorLabel } from '#lib/server/util';
import { formatShortDate, wibDateString } from '#lib/shared/dates';
import { msg } from '#lib/shared/i18n';
import { PASSKEY_MAX_PER_USER, PASSKEY_NAME_MAX_LENGTH } from '#lib/shared/passkeys';
import type { Actions, PageServerLoad } from './$types';

// FN-50 passkey management. Account-level like /pengaturan/api: every load and action works on locals.user only
// (the session's user, never an id from the form). Adding a passkey re-proves the current password (a passkey
// outlives the session that made it); removing one does too. The page data never carries a public key or a
// credential id. hooks.server.ts (auth/gate.ts) answers every signed-out request before it gets here.

const LOAD_FAILED = msg('Daftar passkey tidak bisa dimuat. Muat ulang halaman.');

function signedIn(locals: App.Locals) {
	const user = locals.user;
	if (!user) redirect(303, '/masuk?next=%2Fpengaturan%2Fakun%2Fpasskey');
	return user;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = signedIn(locals);
	const base = {
		maxPasskeys: PASSKEY_MAX_PER_USER,
		nameMaxLength: PASSKEY_NAME_MAX_LENGTH,
		// A host that cannot be an rpId (an IP, a preview address) shows why passkeys are unavailable here.
		hostOk: passkeyRpId(url) !== null
	};
	try {
		return { ...base, passkeys: await listPasskeys(locals.db, user.id), loadError: null };
	} catch (e) {
		console.error('pengaturan/akun/passkey: load failed', errorLabel(e));
		return { ...base, passkeys: [], loadError: LOAD_FAILED };
	}
};

export const actions: Actions = {
	/** "Tambah passkey", step 1: the password re-proven, the cap checked, a `register` challenge issued. */
	registerOptions: async (event) => {
		const { request, locals, url } = event;
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const rpId = passkeyRpId(url);
		if (!rpId) return fail(400, { error: PASSKEY_HOST_UNAVAILABLE });
		const now = Date.now();
		if (await overUserAttemptLimit(locals.db, user.id, now, 'passkey-manage'))
			return fail(429, { error: TOO_MANY_ATTEMPTS });
		const proof = await proveCurrentPassword(event, textField(form, 'password'));
		if (!proof.ok) return fail(proof.status, { error: proof.error });
		const result = await registrationOptions(locals.db, user, rpId, now);
		if (!result.ok) return fail(400, { error: PASSKEY_LIMIT });
		return { options: result.options };
	},

	/** Step 2: the authenticator's response verified against this request's origin and rpId, the row written. */
	register: async ({ request, locals, url }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const rpId = passkeyRpId(url);
		if (!rpId) return fail(400, { error: PASSKEY_HOST_UNAVAILABLE });
		const now = Date.now();
		if (await overUserAttemptLimit(locals.db, user.id, now, 'passkey-manage'))
			return fail(429, { error: TOO_MANY_ATTEMPTS });
		const fields = readRegistrationForm(form);
		// Default name: "Passkey <WIB date>", in the page's language (Owner decisions: editable in the sheet only).
		const defaultName = `Passkey ${formatShortDate(wibDateString(now), locals.locale)}`;
		const result = await verifyRegistrationFor(
			locals.db,
			user,
			fields,
			{ origin: passkeyOrigin(url), rpId },
			defaultName,
			now
		);
		if (!result.ok) {
			// A reason label only: never the credential id, challenge or any field.
			console.warn('passkey registration refused', result.reason);
			return fail(400, { error: PASSKEY_REGISTER_FAILED });
		}
		return { registered: true as const };
	},

	/** "Hapus": the password re-proven, the row tombstoned and every session that passkey created revoked. */
	remove: async (event) => {
		const { request, locals } = event;
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const passkeyId = textField(form, 'passkeyId');
		const now = Date.now();
		if (await overUserAttemptLimit(locals.db, user.id, now, 'passkey-manage'))
			return fail(429, { error: TOO_MANY_ATTEMPTS });
		const proof = await proveCurrentPassword(event, textField(form, 'password'));
		if (!proof.ok) return fail(proof.status, { error: proof.error });
		const removed =
			passkeyId.length > 0 &&
			passkeyId.length <= ID_MAX_LENGTH &&
			(await removePasskey(locals.db, user.id, passkeyId, locals.sessionToken ?? '', now));
		if (!removed) return fail(404, { error: PASSKEY_NOT_FOUND });
		return { removed: true as const };
	}
};
