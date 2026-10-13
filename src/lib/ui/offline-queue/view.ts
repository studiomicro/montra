import { amountFractionDigits } from '#lib/shared/amount-input';
import { msg } from '#lib/shared/i18n';
import {
	isStaleItem,
	QUEUE_FAILED_GENERIC,
	QUEUE_STALE,
	QUEUE_WAITING,
	type QueueItem,
	type QueueKind
} from '#lib/shared/offline-queue';

/** How one queued item reads in the pending-changes sheet. */
export type ItemState = 'failed' | 'stale' | 'session' | 'sending' | 'waiting';

/** The same phrase as the server's SESSION_ENDED (src/lib/server/auth/gate.ts): one English entry. */
export const QUEUE_SESSION_ENDED = msg('Sesi berakhir. Silakan masuk kembali.');
const QUEUE_SENDING = msg('Mengirim…');

export const QUEUE_KIND_LABELS: Readonly<Record<QueueKind, string>> = {
	'transaction.create': msg('Transaksi baru'),
	'transaction.update': msg('Ubah transaksi'),
	'transaction.delete': msg('Hapus transaksi'),
	'voice.save': msg('Suara'),
	'voice.recordAgain': msg('Catat lagi')
};

export function itemState(item: QueueItem, ctx: { sessionEnded: boolean; now: number }): ItemState {
	if (item.status === 'failed') return 'failed';
	if (isStaleItem(item, ctx.now)) return 'stale';
	if (ctx.sessionEnded) return 'session';
	return item.status === 'sending' ? 'sending' : 'waiting';
}

/** The message id shown for a state (a failed item shows the server's own reason). */
export function itemStateText(state: ItemState, item: QueueItem): string {
	switch (state) {
		case 'failed':
			return item.lastError ?? QUEUE_FAILED_GENERIC;
		case 'stale':
			return QUEUE_STALE;
		case 'session':
			return QUEUE_SESSION_ENDED;
		case 'sending':
			return QUEUE_SENDING;
		case 'waiting':
			return QUEUE_WAITING;
	}
}

/**
 * The edit page to open instead of resending a failed edit or delete: the row as it is on the server now
 * (spec §7 — never a blind resubmit of a payload the server refused).
 */
export function reopenHref(item: QueueItem): string | null {
	if (item.status !== 'failed' || !item.targetId) return null;
	if (item.kind !== 'transaction.update' && item.kind !== 'transaction.delete') return null;
	return `/riwayat/${encodeURIComponent(item.targetId)}/edit`;
}

/** Shown on the page right after a write was queued instead of sent (never "Tersimpan"). */
export const QUEUE_QUEUED_HERE = msg('Menunggu koneksi. Dikirim otomatis saat perangkat online.');
/**
 * The same phrases as the server's AMOUNT_INVALID and AMOUNT_INVALID_CENTS: a queued create without an amount is
 * not queued, and the refusal names the rule of the wallet's currency (FN-47 follow-up: a USD amount was told
 * "angka bulat, tanpa sen").
 */
export const QUEUE_AMOUNT_MISSING = msg('Isi jumlah lebih dari 0 dengan angka bulat, tanpa sen.');
export const QUEUE_AMOUNT_MISSING_CENTS = msg(
	'Isi jumlah lebih dari 0, maksimal 2 angka di belakang koma.'
);

/** The queued-create refusal for an amount in `currency`. */
export function queueAmountMissing(currency: string): string {
	return amountFractionDigits(currency) > 0 ? QUEUE_AMOUNT_MISSING_CENTS : QUEUE_AMOUNT_MISSING;
}
/** The same phrase the pages already show for a failed request. */
export const QUEUE_NETWORK = msg('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
