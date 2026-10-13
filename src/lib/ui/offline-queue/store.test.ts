import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { QUEUE_MAX_ITEMS } from '#lib/shared/offline-queue';
import { QueueDb } from './db';
import { OfflineQueue, type NewQueueItem } from './store.svelte';

// db.ts uses the global IDBKeyRange, as in the browser.
Object.assign(globalThis, { IDBKeyRange });

const SPACE = '6a1f0c2e-8b3d-4e5f-9a0b-1c2d3e4f5a6b';

const newItem = (o: Partial<NewQueueItem> = {}): NewQueueItem => ({
	clientId: crypto.randomUUID(),
	spaceId: SPACE,
	kind: 'transaction.create',
	payload: [['amount', '25.000']],
	spaceName: 'Pribadi',
	locale: 'id',
	summary: { title: 'Kopi', amountMinor: 2_500_000, currency: 'IDR', count: 1 },
	...o
});

let factory: IDBFactory;
let clock: number;
beforeEach(() => {
	factory = new IDBFactory();
	clock = 1_800_000_000_000;
});

async function queueFor(accountId: string) {
	return new OfflineQueue(await QueueDb.open(factory), accountId, () => clock);
}

describe('OfflineQueue store (task 5)', () => {
	it('an enqueued item survives a reload (a new store over the same IndexedDB)', async () => {
		const q = await queueFor('user-a');
		const item = newItem();
		expect(await q.enqueue(item)).toBe('queued');
		expect(q.items.map((i) => i.clientId)).toEqual([item.clientId]);
		const reloaded = await queueFor('user-a');
		await reloaded.refresh();
		expect(reloaded.items).toMatchObject([
			{
				clientId: item.clientId,
				accountId: 'user-a',
				status: 'pending',
				attempts: 0,
				createdAt: clock
			}
		]);
		expect(reloaded.items).toHaveLength(1);
	});

	it("items are scoped by account: B never lists A's items; B's start discards them", async () => {
		const a = await queueFor('user-a');
		await a.enqueue(newItem());
		await a.enqueue(newItem());
		const b = await queueFor('user-b');
		await b.refresh();
		expect(b.items).toEqual([]);
		expect(await b.list()).toEqual([]);
		await b.enqueue(newItem());
		expect(await b.discardOtherAccounts()).toBe(2);
		expect(await a.list()).toEqual([]);
		expect(await b.list()).toHaveLength(1);
	});

	it('status transitions: pending → sending → confirmed (removed), or → failed with a reason', async () => {
		const q = await queueFor('user-a');
		const one = newItem();
		const two = newItem();
		await q.enqueue(one);
		clock++;
		await q.enqueue(two);
		await q.markSending(one.clientId);
		expect(q.items.map((i) => i.status)).toEqual(['sending', 'pending']);
		await q.confirm(one.clientId);
		expect(q.items.map((i) => i.clientId)).toEqual([two.clientId]);
		expect(q.confirmed).toBe(1);
		await q.markSending(two.clientId);
		await q.markFailed(two.clientId, 'Transaksi tidak ditemukan.');
		expect(q.items).toMatchObject([{ status: 'failed', lastError: 'Transaksi tidak ditemukan.' }]);
		expect(q.items.map((i) => i.status)).toEqual(['failed']);
	});

	it('a network failure puts it back to pending with one more attempt and its retry time', async () => {
		const q = await queueFor('user-a');
		const item = newItem();
		await q.enqueue(item);
		await q.markSending(item.clientId);
		await q.markPending(item.clientId, clock + 4000);
		expect(q.items).toMatchObject([
			{ status: 'pending', attempts: 1, nextAttemptAt: clock + 4000 }
		]);
	});

	it('retry keeps a failed item: pending again, error cleared, kept from now', async () => {
		const q = await queueFor('user-a');
		const item = newItem();
		await q.enqueue(item);
		await q.markFailed(item.clientId, 'x');
		clock += 10_000;
		await q.retry(item.clientId);
		expect(q.items[0]).toMatchObject({ status: 'pending', keptAt: clock, nextAttemptAt: 0 });
		expect(q.items[0]?.lastError).toBeUndefined();
	});

	it('remove and clear delete only the queue items of this account', async () => {
		const a = await queueFor('user-a');
		const b = await queueFor('user-b');
		const x = newItem();
		await a.enqueue(x);
		await a.enqueue(newItem());
		await b.enqueue(newItem());
		await a.remove(x.clientId);
		expect(a.items).toHaveLength(1);
		await a.clear();
		expect(a.items).toEqual([]);
		expect(await b.list()).toHaveLength(1);
	});

	it('the same item id twice is refused (the store never holds a duplicate)', async () => {
		const q = await queueFor('user-a');
		const item = newItem();
		await q.enqueue(item);
		await expect(q.enqueue(item)).rejects.toBeTruthy();
		expect(await q.list()).toHaveLength(1);
	});
});

describe('queue cap (task 6: 200 items, owner default)', () => {
	it('the 201st enqueue on an account is refused with `full`; nothing is dropped', async () => {
		const q = await queueFor('user-a');
		for (let i = 0; i < QUEUE_MAX_ITEMS; i++) expect(await q.enqueue(newItem())).toBe('queued');
		expect(await q.enqueue(newItem())).toBe('full');
		expect(await q.list()).toHaveLength(QUEUE_MAX_ITEMS);
		// Another account on the device has its own cap.
		const b = await queueFor('user-b');
		expect(await b.enqueue(newItem())).toBe('queued');
	});

	it('the cap holds exactly under 20 concurrent enqueues at 190 (two tabs at once)', async () => {
		const q = await queueFor('user-a');
		const other = await queueFor('user-a');
		for (let i = 0; i < QUEUE_MAX_ITEMS - 10; i++) await q.enqueue(newItem());
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) => (i % 2 ? q : other).enqueue(newItem()))
		);
		expect(results.filter((r) => r === 'queued')).toHaveLength(10);
		expect(await q.list()).toHaveLength(QUEUE_MAX_ITEMS);
	});
});
