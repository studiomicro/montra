import { sql, type SQL } from 'drizzle-orm';
import { base64urlEncode } from '#lib/shared/base64url';
import { normalizeEmail } from '../auth/password';
import type { ClaimMarkerKind } from '../db/schema';
import { keyBytes } from '../server-seal';

/**
 * Re-claim protection (FN-30 hardening, red team L4). Deleting an account and signing up again with the same
 * address must not grant the 300 starter credits or a per-person voucher a second time, and no raw address may
 * outlive the deletion. At deletion an HMAC of the canonical address is kept in `claim_markers` (no user link);
 * sign-up and voucher redemption refuse the claim when a marker with that HMAC exists.
 *
 * The key is the Worker secret CLAIM_HASH_KEY (32 bytes, base64url, the format of the sealing keys); during a
 * rotation the old one stays in CLAIM_HASH_KEY_PREVIOUS so markers written under it still match. Unset or
 * malformed: no marker is written or checked (fail open: credits are granted as before), and the admin page
 * says "Belum dikonfigurasi". Never a default key. Rotating without _PREVIOUS forgets every earlier marker.
 */

export interface ClaimKeyEnv {
	CLAIM_HASH_KEY?: string;
	CLAIM_HASH_KEY_PREVIOUS?: string;
}

/** The marker HMACs of one address: under the current key, and under the previous key during a rotation. */
export interface ClaimHashes {
	current: string;
	previous: string | null;
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const LABEL = 'montra-claim-v1\0';

/**
 * The address a claim is counted against: NFKC-folded (fullwidth `ａ` is `a`), trimmed and lower-cased, the
 * domain's trailing dots dropped (`gmail.com.` is the same mailbox in DNS), everything from the first `+` of the
 * local part dropped (every domain), and for gmail.com / googlemail.com every `.` of the local part dropped and
 * the domain mapped to gmail.com (red team L1). An address whose local part would end up empty keeps its normalised
 * form. Lookalikes from another script (Cyrillic `а`) stay distinct: only verifying the address closes those.
 */
export function canonicalClaimEmail(email: string): string {
	const normalized = normalizeEmail(email.slice(0, 1024).normalize('NFKC'));
	const at = normalized.lastIndexOf('@');
	if (at < 0) return normalized;
	let local = normalized.slice(0, at);
	let domain = normalized.slice(at + 1).replace(/\.+$/, '');
	const plus = local.indexOf('+');
	if (plus >= 0) local = local.slice(0, plus);
	if (GMAIL_DOMAINS.has(domain)) {
		local = local.replace(/\./g, '');
		domain = 'gmail.com';
	}
	return local === '' ? normalized : `${local}@${domain}`;
}

async function hmac(raw: Uint8Array<ArrayBuffer>, canonical: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign'
	]);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(LABEL + canonical));
	return base64urlEncode(mac);
}

/** The marker HMACs of `email` (43 base64url characters each), or null when CLAIM_HASH_KEY is unset or malformed. */
export async function claimHashes(
	env: ClaimKeyEnv | undefined,
	email: string
): Promise<ClaimHashes | null> {
	const current = keyBytes(env?.CLAIM_HASH_KEY);
	if (!current) return null;
	const canonical = canonicalClaimEmail(email);
	const previous = keyBytes(env?.CLAIM_HASH_KEY_PREVIOUS);
	return {
		current: await hmac(current, canonical),
		previous: previous ? await hmac(previous, canonical) : null
	};
}

/** True only for a well-formed CLAIM_HASH_KEY. */
export function isClaimHashConfigured(env: ClaimKeyEnv | undefined): boolean {
	return keyBytes(env?.CLAIM_HASH_KEY) !== null;
}

/**
 * SQL: no marker of `kind` (for `voucherId`, when a voucher) matches either hash. Joined into the guarded insert
 * of the claim itself, so the check and the grant are one statement in one batch.
 */
export function noClaimMarker(hashes: ClaimHashes, kind: ClaimMarkerKind, voucherId?: SQL): SQL {
	const either = sql`(m.email_hmac = ${hashes.current} or m.email_hmac = ${hashes.previous ?? hashes.current})`;
	const voucher = kind === 'voucher' ? sql`and m.voucher_id = ${voucherId}` : sql``;
	return sql`not exists (select 1 from claim_markers m where m.kind = ${kind} and ${either} ${voucher})`;
}
