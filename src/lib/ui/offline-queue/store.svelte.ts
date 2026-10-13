import { QUEUE_MAX_ITEMS, type QueueItem } from '#lib/shared/offline-queue';
import type { Locale } from '#lib/shared/i18n';
import type { QueueDb } from './db';

/** Tabs of this browser tell each other the queue changed (each then re-reads IndexedDB). */
export const QUEUE_CHANNEL = 'financer-queue';

/**
 * What a new item needs from the page; the store fills in the bookkeeping fields. `locale` is required here
 * (FN-47): every new item records the UI language its amounts were typed in.
 */
export type NewQueueItem = Omit<
	QueueItem,
	| 'accountId'
	| 'createdAt'
	| 'keptAt'
	| 'attempts'
	| 'nextAttemptAt'
	| 'status'
	| 'lastError'
	| 'locale'
> & { locale: Locale };

interface Channel {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', listener: () => void): void;
	close(): void;
}

/**
 * The signed-in account's queued writes on this device, reactive for the badge and the pending sheet. Only
 * `accountId`'s items are ever listed, sent or shown; items of another account are discarded on start
 * (`discardOtherAccounts`, an account switch on a shared device). No networking here: the drain loop (sync.ts)
 * calls the mark* methods.
 */
export class OfflineQueue {
	items = $state<QueueItem[]>([]);
	/** The server answered 401: every pending item waits for the user to sign in again. */
	sessionEnded = $state(false);
	/** Items the server confirmed since the page last showed it (the "Tersimpan" note). */
	confirmed = $state(0);

	constructor(
		private readonly db: QueueDb,
		readonly accountId: string,
		private readonly now: () => number = Date.now,
		private readonly channel: Channel | null = null
	) {
		channel?.addEventListener('message', () => void this.refresh());
	}

	async refresh(): Promise<void> {
		this.items = await this.db.list(this.accountId);
	}

	private async changed(): Promise<void> {
		await this.refresh();
		this.channel?.postMessage('changed');
	}

	/**
	 * Stores a new item for this account (status `pending`). `full` when the account already has
	 * QUEUE_MAX_ITEMS queued: the caller shows QUEUE_FULL, nothing is dropped silently.
	 */
	async enqueue(item: NewQueueItem): Promise<'queued' | 'full'> {
		const at = this.now();
		const stored: QueueItem = {
			...item,
			accountId: this.accountId,
			createdAt: at,
			keptAt: at,
			attempts: 0,
			nextAttemptAt: 0,
			status: 'pending'
		};
		const added = await this.db.addCapped(stored, QUEUE_MAX_ITEMS);
		if (added) await this.changed();
		return added ? 'queued' : 'full';
	}

	list(): Promise<QueueItem[]> {
		return this.db.list(this.accountId);
	}

	/** The server confirmed it: the item leaves the queue. */
	async confirm(clientId: string): Promise<void> {
		await this.db.delete([clientId]);
		this.confirmed++;
		await this.changed();
	}

	/** The user dismissed it (the transaction itself is never touched). */
	async remove(clientId: string): Promise<void> {
		await this.db.delete([clientId]);
		await this.changed();
	}

	async markSending(clientId: string): Promise<void> {
		await this.db.update(clientId, (i) => ({ ...i, status: 'sending' }));
		await this.changed();
	}

	/** Back to `pending` after a network failure: one more attempt, retried no earlier than `nextAttemptAt`. */
	async markPending(clientId: string, nextAttemptAt: number): Promise<void> {
		await this.db.update(clientId, (i) => ({
			...i,
			status: 'pending',
			attempts: i.attempts + 1,
			nextAttemptAt
		}));
		await this.changed();
	}

	/** Not retried automatically; `reason` is a message id shown with the item. */
	async markFailed(clientId: string, reason: string): Promise<void> {
		await this.db.update(clientId, (i) => ({ ...i, status: 'failed', lastError: reason }));
		await this.changed();
	}

	/** "Kirim lagi": the user keeps a failed or stale item; it is sent again from now on. */
	async retry(clientId: string): Promise<void> {
		const at = this.now();
		await this.db.update(clientId, (i) => ({
			...i,
			status: 'pending',
			lastError: undefined,
			keptAt: at,
			nextAttemptAt: 0
		}));
		await this.changed();
	}

	/** Every item of this account (sign-out, after the user confirmed). */
	async clear(): Promise<void> {
		await this.db.delete((await this.db.list(this.accountId)).map((i) => i.clientId));
		await this.changed();
	}

	/**
	 * Items another account left on this device (its session ended without sign-out, then someone else signed
	 * in): never shown or sent to this account. Deleted; returns how many.
	 */
	async discardOtherAccounts(): Promise<number> {
		const others = (await this.db.all()).filter((i) => i.accountId !== this.accountId);
		await this.db.delete(others.map((i) => i.clientId));
		if (others.length > 0) this.channel?.postMessage('changed');
		return others.length;
	}

	close(): void {
		this.channel?.close();
	}
}
