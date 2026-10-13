import { constantTimeEqual } from './auth/api-tokens';
import { sha256Hex } from './util';

/**
 * FN-41 admin gate, by account id (FN-30 hardening, FN-41 red team L1): a signed-in user is an admin when their
 * `users.id` is listed in the Worker secret ADMIN_ACCOUNT_IDS (comma-separated; no D1 admin role). An e-mail is
 * never trusted here: sign-up does not verify one, so whoever registered a listed address first would be admitted.
 * Entries are trimmed and lower-cased; an entry that is not a UUID (`crypto.randomUUID`, util.ts) is dropped. Every
 * listed id is compared, as a SHA-256, in constant time and without stopping at a match, so the time taken does not
 * tell which entry matched or how much of one did. Unset or empty: nobody is an admin (the route answers 404).
 */

/** Most entries read from ADMIN_ACCOUNT_IDS: the list is a handful of owner accounts. */
const ADMIN_ACCOUNT_IDS_MAX = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function isAdminAccount(
	env: { ADMIN_ACCOUNT_IDS?: string } | undefined,
	userId: string
): Promise<boolean> {
	const listed = (env?.ADMIN_ACCOUNT_IDS ?? '')
		.split(',')
		.slice(0, ADMIN_ACCOUNT_IDS_MAX)
		.map((e) => e.trim().toLowerCase())
		.filter((e) => UUID.test(e));
	const own = userId.trim().toLowerCase();
	if (listed.length === 0 || !UUID.test(own)) return false;
	const mine = await sha256Hex(own);
	const hashes = await Promise.all(listed.map((e) => sha256Hex(e)));
	let match = false;
	for (const h of hashes) match = constantTimeEqual(h, mine) || match;
	return match;
}
