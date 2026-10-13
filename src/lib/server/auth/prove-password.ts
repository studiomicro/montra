import { redirect, type RequestEvent } from '@sveltejs/kit';
import { INVALID_CREDENTIALS, TOO_MANY_ATTEMPTS } from './messages';
import { PASSWORD_MAX_LENGTH, signInWithPassword } from './password';
import { overAttemptLimit, overUserAttemptLimit } from './throttle';

export type Proof =
	| { ok: true; user: NonNullable<App.Locals['user']>; hash: string }
	| { ok: false; status: 400 | 429; error: string };

/**
 * The signed-in user and the stored hash the re-entered current password matched (same proof as a sign-in:
 * a wrong re-entry counts toward the account lockout). Counted first against a per-client and a per-user
 * budget (red team L3), so a flood costs one row write, not a key derivation. Used by the account page
 * (/pengaturan/akun) and to create an API token (FN-38 red team L2).
 */
export async function proveCurrentPassword(
	event: Pick<RequestEvent, 'locals' | 'request'>,
	password: string
): Promise<Proof> {
	const user = event.locals.user;
	if (!user) redirect(303, '/masuk');
	const { db } = event.locals;
	const now = Date.now();
	const overClient = await overAttemptLimit(db, event.request, now, 'account-password');
	const overUser = await overUserAttemptLimit(db, user.id, now, 'account-password');
	if (overClient || overUser) return { ok: false, status: 429, error: TOO_MANY_ATTEMPTS };
	const refused = { ok: false, status: 400, error: INVALID_CREDENTIALS } as const;
	if (!password || password.length > PASSWORD_MAX_LENGTH) return refused;
	const proof = await signInWithPassword(db, user.email, password, now);
	if (!proof.ok || proof.user.id !== user.id) return refused;
	return { ok: true, user, hash: proof.hash };
}
