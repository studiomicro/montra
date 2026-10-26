import { z } from 'zod';
import { isDateString } from './dates.ts';
import {
	CLIENT_ID_PATTERN,
	PUSH_PAYLOAD_MAX_FIELDS,
	QUEUE_KINDS,
	QUEUE_STATUSES
} from './offline-queue.ts';

/** FN-02 offline write queue: the zod shapes of a queued item and of one push body (see offline-queue.ts). */

/** Longest field name and value read from a payload (a note is at most 500 characters). */
const FIELD_NAME_MAX = 40;
const FIELD_VALUE_MAX = 2048;
/** Ids are UUIDs; anything longer cannot match (same bound as the forms' ID_MAX_LENGTH). */
const ID_MAX = 64;
const EPOCH_MS_MAX = 999_999_999_999_999;

const pushShape = z.object({
	/** Minted once at enqueue (crypto.randomUUID, UUIDv4): the idempotency key end to end. */
	clientId: z.string().regex(CLIENT_ID_PATTERN),
	/**
	 * The signed-in account the item was queued for. The server refuses it (401 `session`) unless it is the
	 * session's own user, so a stale tab of one account never writes under another account's cookie.
	 */
	accountId: z.string().min(1).max(ID_MAX),
	/** The space that was current when the item was made: always pushed there, re-checked by the server. */
	spaceId: z.string().min(1).max(ID_MAX),
	kind: z.enum(QUEUE_KINDS),
	/** The form fields the matching page action reads, as name/value pairs (no object keys: prototype-safe). */
	payload: z
		.array(z.tuple([z.string().max(FIELD_NAME_MAX), z.string().max(FIELD_VALUE_MAX)]))
		.max(PUSH_PAYLOAD_MAX_FIELDS),
	/** The edited or deleted transaction. */
	targetId: z.string().min(1).max(ID_MAX).optional(),
	/** `updated_at` of the row as the form loaded it (edit, delete). */
	expectedUpdatedAt: z.number().int().min(0).max(EPOCH_MS_MAX).optional(),
	/** The WIB date a voice entry was made on (the server would otherwise date it the day it arrives). */
	occurredOn: z.string().refine(isDateString).optional(),
	/**
	 * FN-47 (red team L1): the UI language the form was typed in, so the server reads its amounts with that
	 * language's separators (`12.50` in en, `12,50` in id), not the one the session has when the queue drains.
	 * Absent on items queued before FN-47 cycle 2: the server then reads them with the session's language, as
	 * before. That fails closed: every wallet currency has 0 or 2 fraction digits, so a text read under the
	 * other language is refused (`invalid`, kept for the user to fix or discard), never stored as another amount.
	 */
	locale: z.enum(['id', 'en']).optional()
});

function needsFields(v: z.infer<typeof pushShape>): boolean {
	if (v.kind === 'transaction.update' || v.kind === 'transaction.delete')
		return v.targetId !== undefined && v.expectedUpdatedAt !== undefined;
	if (v.kind === 'voice.save' || v.kind === 'voice.recordAgain') return v.occurredOn !== undefined;
	return true;
}

const pushSchema = pushShape.refine(needsFields);
export type PushRequest = z.infer<typeof pushShape>;

/** One body of `/api/v1/sync/push`, or null. Unknown fields (a status, a summary) are dropped. */
export function parsePushRequest(value: unknown): PushRequest | null {
	const r = pushSchema.safeParse(value);
	return r.success ? r.data : null;
}

/** What the pending-changes sheet says about an item: integer minor units, shown with the shared formatter. */
const summarySchema = z.object({
	title: z.string().max(200),
	amountMinor: z.number().int().nullable(),
	currency: z.string().max(8),
	/** Rows in the item (a voice save may hold several). */
	count: z.number().int().min(0).max(PUSH_PAYLOAD_MAX_FIELDS)
});
export type QueueSummary = z.infer<typeof summarySchema>;

const itemSchema = pushShape
	.extend({
		spaceName: z.string().max(200),
		/** Device clock, display only; never sent. */
		createdAt: z.number().int().min(0),
		/** When the user last made or retried it (QUEUE_STALE_MS counts from here). */
		keptAt: z.number().int().min(0),
		attempts: z.number().int().min(0),
		/** Earliest automatic retry after a network failure (backoff). */
		nextAttemptAt: z.number().int().min(0),
		status: z.enum(QUEUE_STATUSES),
		/** A message id (translated on display), never a stack or a raw response. */
		lastError: z.string().max(300).optional(),
		summary: summarySchema
	})
	.refine(needsFields);
export type QueueItem = z.infer<typeof itemSchema>;

/** A stored item as read back from IndexedDB, or null when it is not one (never trusted blindly). */
export function parseQueueItem(value: unknown): QueueItem | null {
	const r = itemSchema.safeParse(value);
	return r.success ? r.data : null;
}
