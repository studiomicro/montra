/**
 * FN-50 passkeys (WebAuthn): the values the management page, the sign-in page and the server share. Owner
 * decisions 2026-10-12 (PRD defaults accepted): at most 10 live passkeys per account, names of at most 40
 * characters, attestation `none`, ES256 and RS256 only, challenges valid for 5 minutes.
 */

/** Most live (not soft-deleted) passkeys one account holds. */
export const PASSKEY_MAX_PER_USER = 10;
/** Longest passkey name (a label the user gives it; cleaned with cleanText). */
export const PASSKEY_NAME_MAX_LENGTH = 40;
/** How long an issued registration or sign-in challenge may be answered. */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** COSE algorithm identifiers accepted: ES256 (-7) and RS256 (-257). */
export const PASSKEY_ALGORITHMS = [-7, -257] as const;
export type PasskeyAlgorithm = (typeof PASSKEY_ALGORITHMS)[number];

/** What a challenge row was issued for. */
export const PASSKEY_CHALLENGE_KINDS = ['register', 'sign_in'] as const;
export type PasskeyChallengeKind = (typeof PASSKEY_CHALLENGE_KINDS)[number];

/** Content-free sign-in events kept 90 days (`auth_events`): never an IP, user agent or credential material. */
export const AUTH_EVENT_KINDS = [
	'passkey_added',
	'passkey_removed',
	'passkey_sign_in',
	'passkey_refused',
	'passkey_counter_rollback'
] as const;

/** Authenticator transports the browser may report (WebAuthn Level 3); anything else is dropped. */
const PASSKEY_TRANSPORTS = ['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal'] as const;
export type PasskeyTransport = (typeof PASSKEY_TRANSPORTS)[number];

export function isPasskeyAlgorithm(value: number): value is PasskeyAlgorithm {
	return (PASSKEY_ALGORITHMS as readonly number[]).includes(value);
}

/** The transports of a browser's `getTransports()` answer, unknown values dropped, at most six, de-duplicated. */
export function cleanTransports(value: unknown): PasskeyTransport[] {
	if (!Array.isArray(value)) return [];
	const out = new Set<PasskeyTransport>();
	for (const item of value.slice(0, 12))
		if (typeof item === 'string' && (PASSKEY_TRANSPORTS as readonly string[]).includes(item))
			out.add(item as PasskeyTransport);
	return [...out];
}
