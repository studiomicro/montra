import { parseQueueItem, type QueueItem } from '#lib/shared/offline-queue';

/**
 * FN-02: the offline queue's IndexedDB store (`financer-queue` v1, store `items` keyed by `clientId`, index
 * `byAccount`). Plain transaction field values only: no session token, password or account-key material. Not
 * encrypted (owner default: a short-lived retry buffer on the user's own signed-in device). Sign-out's
 * `Clear-Site-Data: "storage"` removes the whole database.
 */
const QUEUE_DB_NAME = 'financer-queue';
const STORE = 'items';
const BY_ACCOUNT = 'byAccount';

const done = (request: IDBRequest) =>
	new Promise<unknown>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

const committed = (tx: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		const fail = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
		tx.onerror = fail;
		tx.onabort = fail;
	});

export class QueueDb {
	constructor(private readonly db: IDBDatabase) {}

	/** Opens (and on first use creates) the database through `factory` (the browser's `indexedDB`). */
	static open(factory: IDBFactory): Promise<QueueDb> {
		return new Promise((resolve, reject) => {
			const request = factory.open(QUEUE_DB_NAME, 1);
			request.onupgradeneeded = () => {
				const store = request.result.createObjectStore(STORE, { keyPath: 'clientId' });
				store.createIndex(BY_ACCOUNT, 'accountId');
			};
			request.onsuccess = () => {
				const db = request.result;
				// Another tab upgrading later must not be blocked by this one.
				db.onversionchange = () => db.close();
				resolve(new QueueDb(db));
			};
			request.onerror = () => reject(request.error);
		});
	}

	/** Every stored item of any account (malformed records are skipped, never trusted). */
	async all(): Promise<QueueItem[]> {
		const tx = this.db.transaction(STORE, 'readonly');
		const rows = (await done(tx.objectStore(STORE).getAll())) as unknown[];
		return rows.map(parseQueueItem).filter((r): r is QueueItem => r !== null);
	}

	/** This account's items in the order they were made. */
	async list(accountId: string): Promise<QueueItem[]> {
		const tx = this.db.transaction(STORE, 'readonly');
		const rows = (await done(
			tx.objectStore(STORE).index(BY_ACCOUNT).getAll(IDBKeyRange.only(accountId))
		)) as unknown[];
		return rows
			.map(parseQueueItem)
			.filter((r): r is QueueItem => r !== null && r.accountId === accountId)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	/**
	 * Adds `item` unless its account already has `max` items: count and add in one readwrite transaction, which
	 * IndexedDB runs one at a time across tabs, so the cap holds exactly. False when refused.
	 */
	async addCapped(item: QueueItem, max: number): Promise<boolean> {
		const tx = this.db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const finished = committed(tx);
		const count = (await done(
			store.index(BY_ACCOUNT).count(IDBKeyRange.only(item.accountId))
		)) as number;
		if (count >= max) {
			tx.abort();
			await finished.catch(() => {});
			return false;
		}
		store.add(item);
		await finished;
		return true;
	}

	/** Applies `change` to the stored item (read and write in one transaction); no-op when it is gone. */
	async update(clientId: string, change: (item: QueueItem) => QueueItem): Promise<void> {
		const tx = this.db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const finished = committed(tx);
		const item = parseQueueItem(await done(store.get(clientId)));
		if (item) store.put(change(item));
		await finished;
	}

	async delete(clientIds: readonly string[]): Promise<void> {
		if (clientIds.length === 0) return;
		const tx = this.db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		for (const id of clientIds) store.delete(id);
		await committed(tx);
	}

	close(): void {
		this.db.close();
	}
}
