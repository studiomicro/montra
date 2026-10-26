import { z } from 'zod';
import { isDateString } from './dates.ts';
import { msg } from './i18n.ts';

/**
 * FN-02 offline write queue: what one queued write is, on the device (IndexedDB) and on the wire
 * (`/api/v1/sync/push`). Pure: no IndexedDB, DOM or server import, so the browser and the Worker check the same
 * shape. Only these writes ever queue (spec §2); auth, billing, invites, deletion, exports, AI capture and balance
 * adjustments (FN-37) stay online-only.
 */
export const QUEUE_KINDS = [
	'transaction.create',
	'transaction.update',
	'transaction.delete',
	'voice.save',
	'voice.recordAgain'
] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/** Most items one account may have queued on a device (owner default); the next enqueue is refused, never dropped. */
export const QUEUE_MAX_ITEMS = 200;
/** An item the user has not kept for this long needs their action (retry or discard) before it is sent. */
export const QUEUE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Largest push body: the voice form's own cap (24 KiB) plus the JSON envelope. */
export const PUSH_BODY_MAX_BYTES = 32 * 1024;
/** Most form fields one item carries: the voice review form's 5 × 20 rows plus key and count, with room. */
export const PUSH_PAYLOAD_MAX_FIELDS = 128;
/** Longest field name and value read from a payload (a note is at most 500 characters). */
const FIELD_NAME_MAX = 40;
const FIELD_VALUE_MAX = 2048;
/** Ids are UUIDs; anything longer cannot match (same bound as the forms' ID_MAX_LENGTH). */
const ID_MAX = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EPOCH_MS_MAX = 999_999_999_999_999;

/** A device-minted id (UUID, lowercase): the queue's clientId, also sent by the enhanced compose form. */
export function isClientId(value: string): boolean {
	return UUID.test(value);
}

const pushShape = z.object({
	/** Minted once at enqueue (crypto.randomUUID, UUIDv4): the idempotency key end to end. */
	clientId: z.string().regex(UUID),
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

const QUEUE_STATUSES = ['pending', 'sending', 'failed'] as const;

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

/** The wire body of an item: only the PushRequest fields. */
export function pushBody(item: QueueItem): PushRequest {
	const {
		clientId,
		accountId,
		spaceId,
		kind,
		payload,
		targetId,
		expectedUpdatedAt,
		occurredOn,
		locale
	} = item;
	return {
		clientId,
		accountId,
		spaceId,
		kind,
		payload,
		targetId,
		expectedUpdatedAt,
		occurredOn,
		locale
	};
}

/** Items with the same target are sent strictly in order: the edited/deleted row, else the item itself. */
export function queueTarget(item: Pick<QueueItem, 'kind' | 'clientId' | 'targetId'>): string {
	return (item.kind === 'transaction.update' || item.kind === 'transaction.delete') && item.targetId
		? item.targetId
		: item.clientId;
}

export function isStaleItem(item: Pick<QueueItem, 'keptAt'>, now: number): boolean {
	return now - item.keptAt > QUEUE_STALE_MS;
}

/** How the push endpoint answered one item. `ok` also covers an item that was already applied before. */
export const PUSH_RESULTS = [
	'ok',
	'invalid',
	'missing',
	'stale',
	'limit',
	'gone',
	'no-access',
	'session'
] as const;
export type PushResult = (typeof PUSH_RESULTS)[number];

export interface PushResponse {
	clientId: string | null;
	result: PushResult;
	/** A message id for the failed-state UI (translated there with tr()). */
	message?: string;
}

/** The space of a queued item is gone or the user left it (same answer either way: no oracle). */
export const QUEUE_SPACE_GONE = msg('Ruang ini sudah tidak bisa diakses.');
/** A balance adjustment (FN-37) is never queued and never changed through the queue. */
export const QUEUE_ONLINE_ONLY = msg('Perubahan ini hanya bisa dikirim saat online.');
export const QUEUE_INVALID = msg(
	'Perubahan ini tidak bisa disimpan. Buka lagi lalu periksa isinya.'
);
export const QUEUE_WAITING = msg('Menunggu koneksi');
export const QUEUE_FULL = msg(
	'Terlalu banyak perubahan menunggu. Sambungkan ke internet dulu, lalu coba lagi.'
);
export const QUEUE_STALE = msg('Ketinggalan sinkron. Kirim lagi atau buang.');
export const QUEUE_FAILED_GENERIC = msg('Server menolak perubahan ini.');
