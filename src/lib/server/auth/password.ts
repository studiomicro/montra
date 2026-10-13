import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { msg } from '#lib/shared/i18n';
import type { Db } from '../db';
import { userPasswords, users } from '../db/schema';

/**
 * Password sign-in, ported from the earlier project (`src/lib/server/auth/password.ts`) without its Admin-set
 * ("must change") passwords: every Montra password is self-chosen at sign-up.
 *
 * PBKDF2-HMAC-SHA256 is the only key derivation Workers' WebCrypto offers. The earlier project measured 100,000
 * iterations at about 8 ms CPU in workerd, above the Workers Free 10 ms budget once the rest of a request
 * is added, hence the Workers Paid prerequisite (docs/TASKS.md).
 */
export const PBKDF2_ITERATIONS = 100_000;
/**
 * The most iterations deployed Workers derive: above it WebCrypto throws `NotSupportedError` (workerd
 * `DEFAULT_MAX_PBKDF2_ITERATIONS`). Local workerd/Node does not enforce it, so password.test.ts pins
 * `PBKDF2_ITERATIONS <= PBKDF2_MAX_ITERATIONS` and `derive` refuses a count outside 1..max itself.
 */
export const PBKDF2_MAX_ITERATIONS = 100_000;
export const PASSWORD_ALGO = 'pbkdf2-sha256';
/** Owner decision C (2026-10-07): 8 characters, not the earlier project's 12. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;
/** Wrong attempts in a row before the account is locked for LOCKOUT_MS. */
export const PASSWORD_MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

const enc = new TextEncoder();
export const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A count this Worker can derive: a whole number within 1..PBKDF2_MAX_ITERATIONS. */
const derivable = (iterations: number) =>
	Number.isInteger(iterations) && iterations >= 1 && iterations <= PBKDF2_MAX_ITERATIONS;

/** Throws, before calling WebCrypto, for a count outside 1..PBKDF2_MAX_ITERATIONS. */
export async function derive(password: string, salt: Uint8Array, iterations: number) {
	if (!derivable(iterations))
		throw new RangeError(`Unsupported PBKDF2 iteration count ${iterations}`);
	const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
		'deriveBits'
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
		key,
		256
	);
	return b64(bits);
}

/** Length-independent comparison; the strings are base64 of a fixed-size digest. */
export function equalConstantTime(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** A fresh credential row's hash fields for `password`. */
export async function newCredential(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(password, salt, PBKDF2_ITERATIONS);
	return { algo: PASSWORD_ALGO, hash, salt: b64(salt), iterations: PBKDF2_ITERATIONS };
}

export type PasswordProblem = 'too_short' | 'too_long' | 'too_simple' | 'same_as_email';

/**
 * Passwords people actually pick (8+ characters, compared lower-cased). A starting list, ported from the earlier project's
 * and adapted to an Indonesian consumer app; extend it when a finding shows one missing.
 */
const COMMON = new Set([
	'password',
	'password1',
	'password123',
	'passw0rd',
	'12345678',
	'123456789',
	'1234567890',
	'12341234',
	'87654321',
	'qwertyui',
	'qwerty123',
	'qwertyuiop',
	'asdfghjk',
	'abc12345',
	'abcd1234',
	'iloveyou',
	'sayangku',
	'bismillah',
	'indonesia',
	'jakarta123',
	'financer',
	'montra',
	'katasandi',
	'rahasia123'
]);

/** Small, explainable rules: a length floor, an upper bound (CPU), no reuse of the e-mail, no common pick. */
export function checkPasswordStrength(password: string, email: string): PasswordProblem | null {
	if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
	if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
	const lower = password.toLowerCase();
	const mail = email.trim().toLowerCase();
	if (lower === mail || lower === mail.split('@')[0]) return 'same_as_email';
	if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return 'too_simple';
	return null;
}

/** One message per rejection reason (Indonesian key; English in i18n-en.ts). */
export const PASSWORD_ERRORS: Record<PasswordProblem, string> = {
	too_short: msg('Kata sandi minimal 8 karakter.'),
	too_long: msg('Kata sandi terlalu panjang (maks. 200 karakter).'),
	too_simple: msg('Kata sandi terlalu mudah ditebak.'),
	same_as_email: msg('Kata sandi tidak boleh sama dengan e-mail.')
};

export type SignInUser = typeof users.$inferSelect;
export type SignInResult =
	| { ok: true; user: SignInUser; hash: string }
	| { ok: false; error: 'invalid_credentials' | 'locked' };

/**
 * Verifies an e-mail and password. Every path costs one key derivation and one UPDATE statement, so a
 * missing account, a disabled one, a locked one and a wrong password take comparable work; the caller
 * answers 'locked' exactly like 'invalid_credentials' (no account-existence oracle).
 *
 * The lock rules live in one guarded UPDATE (checklist › Concurrent writes): the count, the comparison with
 * the limit and the write are one statement, so N concurrent wrong passwords count N; it applies only while
 * the account is unlocked when the statement runs, so a right password in flight while concurrent wrong
 * ones lock the account is refused; an expired lock is cleared, a live one never is.
 *
 * `hash` is the stored hash the password matched: a session is written only while it is still the
 * account's (`createPasswordSession`), and account deletion is guarded on it.
 */
export async function signInWithPassword(
	db: Db,
	email: string,
	password: string,
	now: number
): Promise<SignInResult> {
	const found = await db
		.select({ user: users, pw: userPasswords })
		.from(users)
		.leftJoin(userPasswords, eq(userPasswords.userId, users.id))
		.where(eq(users.email, normalizeEmail(email)))
		.get();
	const record = found?.pw ?? null;
	const pw =
		found?.user.status === 'active' && record !== null && derivable(record.iterations)
			? record
			: null;
	// A missing account derives against a random salt: same work as a real one.
	const candidate = await derive(
		password,
		pw ? unb64(pw.salt) : crypto.getRandomValues(new Uint8Array(16)),
		pw?.iterations ?? PBKDF2_ITERATIONS
	);
	const matched = pw !== null && equalConstantTime(candidate, pw.hash);
	const unlocked = or(isNull(userPasswords.lockedUntil), lte(userPasswords.lockedUntil, now));
	// Accepted only while the row still holds the hash the password was checked against. Bound, never spliced.
	const accept = sql`(${matched ? 1 : 0} = 1 and ${userPasswords.hash} = ${pw?.hash ?? ''})`;
	const failures = sql`case when ${userPasswords.lockedUntil} is not null and ${userPasswords.lockedUntil} <= ${now} then 1 else ${userPasswords.failedCount} + 1 end`;
	const reached = sql`${failures} >= ${PASSWORD_MAX_FAILURES}`;
	const [after] = await db
		.update(userPasswords)
		.set({
			failedCount: sql`case when ${accept} then 0 when ${reached} then 0 else ${failures} end`,
			lockedUntil: sql`case when ${accept} then null when ${reached} then ${now + LOCKOUT_MS} else null end`
		})
		// Without a usable password the UPDATE runs against no row ('' is no user id): same statement, no write.
		.where(and(eq(userPasswords.userId, pw?.userId ?? ''), unlocked))
		.returning({ failedCount: userPasswords.failedCount, lockedUntil: userPasswords.lockedUntil });
	if (!pw || !after) return { ok: false, error: pw ? 'locked' : 'invalid_credentials' };
	// An accepted row is left at 0 failures and no lock; every refusal leaves a failure or a lock.
	if (matched && after.failedCount === 0 && after.lockedUntil === null)
		return { ok: true, user: found!.user, hash: pw.hash };
	return { ok: false, error: after.lockedUntil !== null ? 'locked' : 'invalid_credentials' };
}

export const EMAIL_MAX_LENGTH = 254;

/** The stored form of an e-mail address: trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * A plausible address: one @, a dot in the domain, within RFC 5321's 254, and no whitespace, control (Cc),
 * format (Cf: zero-width, bidi) or separator characters, which would make a look-alike of another account
 * (red team L4). Refused rather than stripped, so one visible address is one account.
 */
export function isPlausibleEmail(email: string): boolean {
	const part = String.raw`[^\s@\p{Cc}\p{Cf}\p{Z}]+`;
	return (
		email.length <= EMAIL_MAX_LENGTH && new RegExp(`^${part}@${part}\\.${part}$`, 'u').test(email)
	);
}
