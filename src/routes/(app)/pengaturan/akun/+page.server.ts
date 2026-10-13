import { fail, redirect } from '@sveltejs/kit';
import {
	CHANGED_MEANWHILE,
	KEY_INVALID,
	KEY_STALE,
	KEY_UNSUPPORTED,
	PASSWORD_MISMATCH
} from '#lib/server/account-keys/messages';
import {
	accountKeyMaterial,
	activateAccountKey,
	getAccountKey,
	getAccountKeyStatus,
	keyCheckMatches,
	rewrapAccountKey
} from '#lib/server/account-keys/repo';
import { readAccountKeyForm, readKeyVersion } from '#lib/server/account-keys/validation';
import { changePassword } from '#lib/server/auth/change-password';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { proveCurrentPassword } from '#lib/server/auth/prove-password';
import { DELETE_CONFIRM_REQUIRED, INVALID_CREDENTIALS } from '#lib/server/auth/messages';
import {
	checkPasswordStrength,
	PASSWORD_ERRORS,
	PASSWORD_MAX_LENGTH,
	signInWithPassword
} from '#lib/server/auth/password';
import { clearSessionCookie, revokeSession } from '#lib/server/auth/session';
import { claimHashes } from '#lib/server/billing/claims';
import { getEnv } from '#lib/server/env';
import { googleClient } from '#lib/server/gmail/google';
import { revokeGmailToken } from '#lib/server/gmail/oauth';
import { readFormBody, textField } from '#lib/server/forms';
import { sweepSoon } from '#lib/server/photos/store';
import { clearSpaceCookie } from '#lib/server/spaces/access';
import type { Actions, PageServerLoad } from './$types';

// hooks.server.ts (auth/gate.ts) answers every signed-out request to this (app) route before it gets here;
// the checks below only narrow the type and fail closed if that ever changes.

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) redirect(303, '/masuk?next=%2Fpengaturan%2Fakun');
	const key = await getAccountKeyStatus(locals.db, user.id);
	return {
		account: { name: user.name, email: user.email, createdAt: user.createdAt },
		// Whether a key exists and whether it still opens with the current password; never wrapped material.
		accountKey: { exists: key !== null, stale: key?.stale ?? false }
	};
};

export const actions: Actions = {
	/**
	 * The signed-in user's wrapped account key, after the current password is re-proven (FN-21): what a device
	 * needs to re-wrap it on a password change. Only already-encrypted material; the user's own row only.
	 */
	keyMaterial: async (event) => {
		const form = await readFormBody(event.request);
		const proof = await proveCurrentPassword(event, textField(form, 'password'));
		if (!proof.ok) return fail(proof.status, { keyError: proof.error });
		const key = await getAccountKey(event.locals.db, proof.user.id);
		return { material: key ? accountKeyMaterial(key) : null };
	},

	/**
	 * Changes the password (current + new + confirm). With JavaScript and X25519 the device re-wrapped the
	 * account key under the new password and sends it along: both are written in one guarded batch. Without
	 * it the password still changes and the key is left as it is, which the answer says (KEY_STALE).
	 */
	changePassword: async (event) => {
		const form = await readFormBody(event.request);
		const newPassword = textField(form, 'newPassword');
		const user = event.locals.user;
		if (!user) redirect(303, '/masuk');
		const problem = checkPasswordStrength(newPassword, user.email);
		if (problem) return fail(400, { passwordError: PASSWORD_ERRORS[problem] });
		if (textField(form, 'confirmPassword') !== newPassword)
			return fail(400, { passwordError: PASSWORD_MISMATCH });
		const key = await readAccountKeyForm(form);
		const version = readKeyVersion(form);
		if (key.kind === 'invalid' || (key.kind === 'present' && version === null))
			return fail(400, { passwordError: KEY_INVALID });
		const proof = await proveCurrentPassword(event, textField(form, 'password'));
		if (!proof.ok) return fail(proof.status, { passwordError: proof.error });
		if (
			key.kind === 'present' &&
			!(await keyCheckMatches(event.locals.db, user.id, key.keyCheckHash))
		)
			return fail(409, { passwordError: CHANGED_MEANWHILE });
		const rewrap =
			key.kind === 'present' && version !== null
				? { key: { fields: key.fields, keyCheckHash: key.keyCheckHash }, version }
				: null;
		// Every other session of the account is signed out with the change; this one stays (red team M1).
		const changed = await changePassword(
			event.locals.db,
			user.id,
			proof.hash,
			event.locals.sessionToken ?? '',
			newPassword,
			rewrap,
			Date.now()
		);
		if (!changed) return fail(409, { passwordError: CHANGED_MEANWHILE });
		const status = await getAccountKeyStatus(event.locals.db, user.id);
		return { passwordChanged: true, keyNotice: status?.stale ? KEY_STALE : undefined };
	},

	/** "Kunci dengan akunku": the first account key of an account without one (made on the device). */
	activateAccountKey: async (event) => {
		const form = await readFormBody(event.request);
		const key = await readAccountKeyForm(form);
		if (key.kind === 'absent') return fail(400, { keyError: KEY_UNSUPPORTED });
		if (key.kind === 'invalid') return fail(400, { keyError: KEY_INVALID });
		const proof = await proveCurrentPassword(event, textField(form, 'password'));
		if (!proof.ok) return fail(proof.status, { keyError: proof.error });
		const written = await activateAccountKey(
			event.locals.db,
			proof.user.id,
			proof.hash,
			{ fields: key.fields, keyCheckHash: key.keyCheckHash },
			Date.now()
		);
		if (!written) return fail(409, { keyError: CHANGED_MEANWHILE });
		return { keyActivated: true };
	},

	/**
	 * Re-wraps a stale key (wrapped under an earlier password) under the current one. The device opened it
	 * with the earlier password, which it never sends; the server proves only the current password.
	 */
	rewrapAccountKey: async (event) => {
		const form = await readFormBody(event.request);
		const key = await readAccountKeyForm(form);
		const version = readKeyVersion(form);
		if (key.kind === 'absent') return fail(400, { keyError: KEY_UNSUPPORTED });
		if (key.kind === 'invalid' || version === null) return fail(400, { keyError: KEY_INVALID });
		const proof = await proveCurrentPassword(event, textField(form, 'password'));
		if (!proof.ok) return fail(proof.status, { keyError: proof.error });
		if (!(await keyCheckMatches(event.locals.db, proof.user.id, key.keyCheckHash)))
			return fail(409, { keyError: CHANGED_MEANWHILE });
		const written = await rewrapAccountKey(
			event.locals.db,
			proof.user.id,
			proof.hash,
			version,
			{ fields: key.fields, keyCheckHash: key.keyCheckHash },
			Date.now()
		);
		if (!written) return fail(409, { keyError: CHANGED_MEANWHILE });
		return { keyRewrapped: true };
	},

	/** Signs out this device only: revokes the session of this cookie, other devices stay signed in. */
	signOut: async ({ request, locals, cookies }) => {
		await readFormBody(request);
		if (locals.sessionToken) await revokeSession(locals.db, locals.sessionToken, Date.now());
		clearSessionCookie(cookies, locals.secure);
		clearSpaceCookie(cookies, locals.secure);
		locals.clearSiteData = true;
		redirect(303, '/masuk');
	},

	/** Re-proves the password, then deletes the account (delete-account.ts) and signs the browser out. */
	deleteAccount: async ({ request, locals, cookies }) => {
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const form = await readFormBody(request);
		const password = textField(form, 'password');
		if (textField(form, 'confirm') !== 'on')
			return fail(400, { deleteError: DELETE_CONFIRM_REQUIRED });
		if (!password || password.length > PASSWORD_MAX_LENGTH)
			return fail(400, { deleteError: INVALID_CREDENTIALS });
		// Same proof as a sign-in: a wrong re-entry counts toward the account lockout.
		const proof = await signInWithPassword(locals.db, user.email, password, Date.now());
		if (!proof.ok || proof.user.id !== user.id)
			return fail(400, { deleteError: INVALID_CREDENTIALS });
		// FN-30: the address's re-claim marker key (null while CLAIM_HASH_KEY is unset; deletion goes ahead).
		const claim = await claimHashes(getEnv(), user.email);
		// FN-19 Gmail: the token is revoked at Google first, best effort (never blocks the deletion).
		await revokeGmailToken(locals.db, getEnv(), googleClient(), user.id);
		if (!(await deleteAccount(locals.db, user.id, proof.hash, Date.now(), claim?.current ?? null)))
			return fail(400, { deleteError: INVALID_CREDENTIALS });
		// The purged spaces' photos (FN-27): deleted from R2 now, or by the jobs Worker when that fails.
		await sweepSoon(getEnv(), locals.db, Date.now());
		clearSessionCookie(cookies, locals.secure);
		clearSpaceCookie(cookies, locals.secure);
		locals.clearSiteData = true;
		redirect(303, '/akun-dihapus');
	}
};
