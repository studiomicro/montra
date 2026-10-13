import { msg } from '#lib/shared/i18n';
import { cleanText } from '#lib/shared/text';
import { insertAccountKey, type KeyWrite } from '../account-keys/repo';
import type { ClaimHashes } from '../billing/claims';
import { signUpBillingSteps } from '../billing/plan-state';
import type { Db } from '../db';
import { consentInserts } from '../privacy/repo';
import { sessions, spaceMembers, spaces, userPasswords, users } from '../db/schema';
import { isUniqueViolation, newId } from '../util';
import {
	checkPasswordStrength,
	isPlausibleEmail,
	newCredential,
	normalizeEmail,
	PASSWORD_ERRORS
} from './password';
import { newSession } from './session';

export const NAME_MAX_LENGTH = 80;
/** Stored name of every personal space; the UI shows `kind = 'personal'` through tr('Pribadi'). */
export const PERSONAL_SPACE_NAME = 'Pribadi';

export const SIGN_UP_ERRORS = {
	nameRequired: msg('Isi namamu.'),
	emailInvalid: msg('Masukkan alamat e-mail yang benar.'),
	emailTaken: msg('E-mail sudah terdaftar.'),
	adultRequired: msg('Centang konfirmasi usia untuk melanjutkan.'),
	consentRequired: msg('Centang persetujuan ketentuan dan kebijakan privasi untuk melanjutkan.')
} as const;

export type SignUpField = 'name' | 'email' | 'password' | 'adult' | 'consent';
export type SignUpErrors = Partial<Record<SignUpField, string>>;

export interface SignUpInput {
	name: string;
	email: string;
	password: string;
	adultConfirmed: boolean;
	/** The terms, privacy policy and cross-border notice box (FN-31); required like `adultConfirmed`. */
	consentAccepted: boolean;
	/** The account key made and wrapped on the device (FN-21); absent without JavaScript or X25519. */
	accountKey?: KeyWrite | null;
	/**
	 * The address's re-claim HMACs (billing/claims.ts `claimHashes`); null or absent while CLAIM_HASH_KEY is
	 * not configured, and the starter credits are then granted unconditionally.
	 */
	claimHashes?: ClaimHashes | null;
}

/** The cleaned fields, or one message per invalid field. No database access. */
export function validateSignUp(input: SignUpInput) {
	const name = cleanText(input.name, NAME_MAX_LENGTH);
	const email = normalizeEmail(input.email);
	const errors: SignUpErrors = {};
	if (!name) errors.name = SIGN_UP_ERRORS.nameRequired;
	if (!isPlausibleEmail(email)) errors.email = SIGN_UP_ERRORS.emailInvalid;
	const problem = checkPasswordStrength(input.password, email);
	if (problem) errors.password = PASSWORD_ERRORS[problem];
	if (!input.adultConfirmed) errors.adult = SIGN_UP_ERRORS.adultRequired;
	if (!input.consentAccepted) errors.consent = SIGN_UP_ERRORS.consentRequired;
	return { name, email, errors };
}

export type SignUpResult =
	| { ok: true; userId: string; token: string; expiresAt: number }
	| { ok: false; errors: SignUpErrors };

/**
 * Creates an account: `users`, `user_passwords`, the personal `spaces` row, its owner `space_members` row
 * the first session, the Gratis plan state with the 300 starter credits (FN-30; none when a deleted account of
 * the same address already had them, `claimHashes`), the three consent records (FN-31)
 * and, when the device sent one, the account key (FN-21), all in one `db.batch` (one D1 transaction), so a
 * failure leaves nothing behind.
 * The `users.email` unique index decides concurrent sign-ups with one address: exactly one batch commits,
 * the others fail as a whole and answer "E-mail sudah terdaftar".
 */
export async function signUp(db: Db, input: SignUpInput, now: number): Promise<SignUpResult> {
	const { name, email, errors } = validateSignUp(input);
	if (Object.keys(errors).length) return { ok: false, errors };
	const userId = newId();
	const spaceId = newId();
	const credential = await newCredential(input.password);
	const { token, row: session } = await newSession(userId, now);
	try {
		await db.batch([
			db.insert(users).values({
				id: userId,
				email,
				name,
				status: 'active',
				adultConfirmedAt: now,
				createdAt: now,
				lastLoginAt: now
			}),
			db.insert(userPasswords).values({ userId, ...credential, failedCount: 0, updatedAt: now }),
			db.insert(spaces).values({
				id: spaceId,
				kind: 'personal',
				name: PERSONAL_SPACE_NAME,
				createdAt: now,
				updatedAt: now
			}),
			db.insert(spaceMembers).values({
				id: newId(),
				spaceId,
				userId,
				role: 'owner',
				createdAt: now,
				updatedAt: now
			}),
			db.insert(sessions).values(session),
			...signUpBillingSteps(db, userId, now, input.claimHashes ?? null),
			consentInserts(db, userId, now),
			...(input.accountKey ? [insertAccountKey(db, userId, input.accountKey, now)] : [])
		]);
	} catch (e) {
		if (isUniqueViolation(e)) return { ok: false, errors: { email: SIGN_UP_ERRORS.emailTaken } };
		throw e;
	}
	return { ok: true, userId, token, expiresAt: session.expiresAt };
}
