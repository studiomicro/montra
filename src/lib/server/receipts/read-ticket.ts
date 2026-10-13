import type { AiKeysEnv } from '../ai-keys/crypto';
import { openValue, sealValue, type Sealed } from '../server-seal';

/**
 * FN-15 red team L3: proof that a `save` follows a real `read` of the same photo. `read` hands the page a ticket
 * sealed (server-seal.ts, AES-256-GCM) with the AI-keys secret under its own labels, bound to the user, the space
 * and the photo's dedupe-key prefix; its plaintext is only the expiry. `save` refuses rows tagged `receipt`
 * without a ticket that opens for the same user, space and photo bytes before it expires. A read needs a
 * personal key, which needs that secret, so a ticket can always be issued when a read succeeded. Rotation keeps
 * `_PREVIOUS`, so a ticket issued just before a rotation still opens.
 */

/** How long a review may stay open before "Simpan" needs a fresh read. */
export const READ_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

/** Longest ticket accepted from a form (a real one is about 110 characters). */
export const READ_TICKET_MAX_LENGTH = 256;

const LABELS = {
	aad: 'montra/receipts/read-ticket/v1',
	keyId: 'montra/receipts/read-ticket/key-id/v1'
};

export interface ReadTicketBinding {
	userId: string;
	spaceId: string;
	/** `receiptKeyPrefix` of the photo bytes. */
	keyPrefix: string;
}

const keys = (env: AiKeysEnv | undefined) => ({
	current: env?.AI_KEYS_ENCRYPTION_KEY,
	previous: env?.AI_KEYS_ENCRYPTION_KEY_PREVIOUS
});
const bound = (b: ReadTicketBinding) => [b.userId, b.spaceId, b.keyPrefix];

/** A ticket for `binding` valid until `now + READ_TICKET_TTL_MS`; null without a configured secret. */
export async function issueReadTicket(
	env: AiKeysEnv | undefined,
	binding: ReadTicketBinding,
	now: number
): Promise<string | null> {
	const sealed = await sealValue(
		keys(env),
		LABELS,
		String(now + READ_TICKET_TTL_MS),
		bound(binding),
		32
	);
	return sealed ? `${sealed.keyId}.${sealed.nonce}.${sealed.ciphertext}` : null;
}

/** Whether `ticket` opens for `binding` and has not expired at `now` (fails closed on anything else). */
export async function checkReadTicket(
	env: AiKeysEnv | undefined,
	ticket: string,
	binding: ReadTicketBinding,
	now: number
): Promise<boolean> {
	if (ticket.length === 0 || ticket.length > READ_TICKET_MAX_LENGTH) return false;
	const parts = ticket.split('.');
	if (parts.length !== 3) return false;
	const [keyId, nonce, ciphertext] = parts as [string, string, string];
	const sealed: Sealed = { keyId, nonce, ciphertext };
	const opened = await openValue(keys(env), LABELS, sealed, bound(binding));
	if (opened === null || !/^\d{1,16}$/.test(opened)) return false;
	return now < Number(opened);
}
