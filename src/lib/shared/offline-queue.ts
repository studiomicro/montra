import { msg } from './i18n.ts';
import type { PushRequest, QueueItem } from './offline-queue-schema.ts';

export type { PushRequest, QueueItem, QueueSummary } from './offline-queue-schema.ts';

/**
 * FN-02 offline write queue: what one queued write is, on the device (IndexedDB) and on the wire
 * (`/api/v1/sync/push`). Constants, helpers and message ids only: no zod, so client code that needs these does
 * not pull the schemas (offline-queue-schema.ts) into its bundle. Pure: no IndexedDB, DOM or server import, so the
 * browser and the Worker check the same shape. Only these writes ever queue (spec §2); auth, billing, invites, deletion, exports, AI capture and balance
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

/** Where a queued item stands: waiting, in flight, or refused and kept for the user. */
export const QUEUE_STATUSES = ['pending', 'sending', 'failed'] as const;

/** Most items one account may have queued on a device (owner default); the next enqueue is refused, never dropped. */
export const QUEUE_MAX_ITEMS = 200;
/** An item the user has not kept for this long needs their action (retry or discard) before it is sent. */
export const QUEUE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Largest push body: the voice form's own cap (24 KiB) plus the JSON envelope. */
export const PUSH_BODY_MAX_BYTES = 32 * 1024;
/** Most form fields one item carries: the voice review form's 5 × 20 rows plus key and count, with room. */
export const PUSH_PAYLOAD_MAX_FIELDS = 128;
/** A device-minted id: lowercase UUID. */
export const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A device-minted id (UUID, lowercase): the queue's clientId, also sent by the enhanced compose form. */
export function isClientId(value: string): boolean {
	return CLIENT_ID_PATTERN.test(value);
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
