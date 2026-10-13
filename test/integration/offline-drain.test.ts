import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { createTransaction, getTransaction } from '#lib/server/transactions/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { TRANSACTION_CHANGED } from '#lib/server/transactions/messages';
import { QueueDb } from '#lib/ui/offline-queue/db';
import { drainLock } from '#lib/ui/offline-queue/lock';
import { OfflineQueue, type NewQueueItem } from '#lib/ui/offline-queue/store.svelte';
import { Drainer } from '#lib/ui/offline-queue/sync';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { fakeLocks } from '../helpers/locks';

/**
 * FN-02 end to end without a browser: the device side (IndexedDB queue + drain loop) against the real push
 * endpoint and local D1. `fetch` is the route handler; `online` decides whether it is reachable.
 */
Object.assign(globalThis, { IDBKeyRange });

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const route = await import('../../src/routes/api/v1/sync/push/+server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function setup() {
	const email = `kuras${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const user = { id: r.userId, email, name: 'Uji', createdAt: 0 };
	const spaceId = (await resolveCurrentSpace(db, user.id, undefined))!.id;
	await ensurePresetCategories(db, spaceId);
	const scope = { spaceId, userId: user.id };
	const w = await createWallet(
		db,
		scope,
		{
			name: 'BCA',
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		Date.now()
	);
	if (!w.ok) throw new Error('wallet');
	const kopi = (await listCategories(db, spaceId)).find((c) => c.tileKey === 'kopi')!.id;
	return { user, spaceId, scope, bca: w.id, kopi };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** The device's network: `online` false makes every request fail like fetch does offline. */
function device(s: Setup) {
	const net = { online: false, signedIn: true, calls: 0 };
	const fetch = (async (url: string, init: RequestInit) => {
		if (!net.online) throw new TypeError('Failed to fetch');
		net.calls++;
		const { event } = fakeEvent({
			url: `http://localhost${url}`,
			db,
			user: net.signedIn ? s.user : null
		});
		const headers = new Headers(init.headers as Record<string, string>);
		headers.set('origin', 'http://localhost');
		Object.assign(event, {
			request: new Request(`http://localhost${url}`, {
				method: 'POST',
				headers,
				body: init.body as string
			})
		});
		return route.POST(event as never);
	}) as unknown as typeof globalThis.fetch;
	return { net, fetch };
}

function createItem(s: Setup, amount = '25.000'): NewQueueItem {
	return {
		clientId: crypto.randomUUID(),
		spaceId: s.spaceId,
		kind: 'transaction.create',
		locale: 'id',
		payload: [
			['type', 'expense'],
			['amount', amount],
			['walletId', s.bca],
			['categoryId', s.kopi],
			['title', 'Kopi'],
			['occurredOn', wibTodayString()]
		],
		spaceName: 'Pribadi',
		summary: { title: 'Kopi', amountMinor: 2_500_000, currency: 'IDR', count: 1 }
	};
}

const rows = async (spaceId: string) =>
	(
		await db.all<{ n: number }>(
			sql`select count(*) as n from transactions where space_id = ${spaceId} and deleted_at is null`
		)
	)[0]!.n;

/** One browser tab: its own store and drain loop over the browser's one IndexedDB. */
async function tab(
	factory: IDBFactory,
	s: Setup,
	fetch: typeof globalThis.fetch,
	lock = drainLock(undefined)
) {
	const queue = new OfflineQueue(await QueueDb.open(factory), s.user.id);
	await queue.refresh();
	return { queue, drainer: new Drainer({ queue, fetch, lock, schedule: () => () => {} }) };
}

describe('offline → online replay (probe)', () => {
	it('queued offline survive a reload, then drain once online: rows written, queue empty', async () => {
		const s = await setup();
		const factory = new IDBFactory();
		const { net, fetch } = device(s);
		const a = await tab(factory, s, fetch);
		await a.queue.enqueue(createItem(s));
		await a.queue.enqueue(createItem(s, '10.000'));
		await a.drainer.drain();
		expect(await rows(s.spaceId)).toBe(0);
		expect(a.queue.items.map((i) => i.status)).toEqual(['pending', 'pending']);
		// Reload while offline: a new tab over the same IndexedDB still has both.
		const reloaded = await tab(factory, s, fetch);
		expect(reloaded.queue.items).toHaveLength(2);
		net.online = true;
		await reloaded.drainer.drain(true);
		expect(await rows(s.spaceId)).toBe(2);
		expect(reloaded.queue.items).toEqual([]);
		expect(reloaded.queue.confirmed).toBe(2);
	});
});

describe('duplicate replay (probe)', () => {
	it('an item whose first attempt was applied but unanswered is sent again: still one row', async () => {
		const s = await setup();
		const { net, fetch } = device(s);
		// The server applies the write, then the answer is lost on the way back.
		let lose = true;
		const lossy = (async (url: string, init: RequestInit) => {
			const res = await fetch(url, init);
			if (lose) {
				lose = false;
				throw new TypeError('Failed to fetch');
			}
			return res;
		}) as unknown as typeof globalThis.fetch;
		net.online = true;
		const a = await tab(new IDBFactory(), s, lossy);
		await a.queue.enqueue(createItem(s));
		await a.drainer.drain();
		expect(a.queue.items).toMatchObject([{ status: 'pending', attempts: 1 }]);
		expect(await rows(s.spaceId)).toBe(1);
		await a.drainer.drain(true);
		expect(a.queue.items).toEqual([]);
		expect(await rows(s.spaceId)).toBe(1);
	});
});

describe('two tabs (task 8, probe)', () => {
	it('with Web Locks: both tabs come online at once, each item is sent exactly once', async () => {
		const s = await setup();
		const factory = new IDBFactory();
		const { net, fetch } = device(s);
		const locks = fakeLocks();
		const a = await tab(factory, s, fetch, drainLock(locks));
		const b = await tab(factory, s, fetch, drainLock(locks));
		for (let i = 0; i < 5; i++) await a.queue.enqueue(createItem(s));
		net.online = true;
		await Promise.all([a.drainer.drain(true), b.drainer.drain(true)]);
		expect(net.calls).toBe(5);
		expect(await rows(s.spaceId)).toBe(5);
	});

	it('without Web Locks both tabs may send the same items, and the server still writes each once', async () => {
		const s = await setup();
		const factory = new IDBFactory();
		const { net, fetch } = device(s);
		const a = await tab(factory, s, fetch);
		const b = await tab(factory, s, fetch);
		for (let i = 0; i < 5; i++) await a.queue.enqueue(createItem(s));
		net.online = true;
		await Promise.all([a.drainer.drain(true), b.drainer.drain(true)]);
		// Both tabs really sent some items twice: the second copy was answered ok and wrote nothing.
		expect(net.calls).toBeGreaterThan(5);
		expect(await rows(s.spaceId)).toBe(5);
		expect(await a.queue.list()).toEqual([]);
	});
});

describe('session expired while offline (probe)', () => {
	it('401 pauses the queue with the items kept; after signing in again (a new page) they drain', async () => {
		const s = await setup();
		const factory = new IDBFactory();
		const { net, fetch } = device(s);
		const a = await tab(factory, s, fetch);
		await a.queue.enqueue(createItem(s));
		await a.queue.enqueue(createItem(s));
		net.online = true;
		net.signedIn = false;
		await a.drainer.drain(true);
		expect(a.queue.sessionEnded).toBe(true);
		expect(a.queue.items.map((i) => i.status)).toEqual(['pending', 'pending']);
		expect(await rows(s.spaceId)).toBe(0);
		net.signedIn = true;
		const again = await tab(factory, s, fetch);
		await again.drainer.drain(true);
		expect(await rows(s.spaceId)).toBe(2);
	});

	it('a different account signing in on the device never sends or sees the first account’s items', async () => {
		const s = await setup();
		const other = await setup();
		const factory = new IDBFactory();
		const first = device(s);
		const a = await tab(factory, s, first.fetch);
		await a.queue.enqueue(createItem(s));
		const second = device(other);
		second.net.online = true;
		const b = await tab(factory, other, second.fetch);
		expect(b.queue.items).toEqual([]);
		expect(await b.queue.discardOtherAccounts()).toBe(1);
		await b.drainer.drain(true);
		expect(second.net.calls).toBe(0);
		expect(await rows(s.spaceId)).toBe(0);
		expect(await rows(other.spaceId)).toBe(0);
	});
});

describe('stale edit conflict across two devices (probe)', () => {
	it('device 2 deletes online; device 1 replays an edit queued earlier: failed "changed", no resurrection', async () => {
		const s = await setup();
		const tx = await createTransaction(
			db,
			s.scope,
			{
				type: 'expense',
				amountMinor: 2_500_000,
				currency: 'IDR',
				walletId: s.bca,
				transferToWalletId: null,
				categoryId: s.kopi,
				title: 'Kopi',
				note: null,
				occurredOn: wibTodayString(),
				occurredTime: null
			},
			Date.now()
		);
		if (!tx.ok) throw new Error('setup');
		const loaded = (await getTransaction(db, s.spaceId, tx.id))!.updatedAt;
		const { net, fetch } = device(s);
		const d1Tab = await tab(new IDBFactory(), s, fetch);
		await d1Tab.queue.enqueue({
			...createItem(s, '30.000'),
			kind: 'transaction.update',
			targetId: tx.id,
			expectedUpdatedAt: loaded
		});
		// Device 2 edits online first.
		const other = device(s);
		other.net.online = true;
		const d2Tab = await tab(new IDBFactory(), s, other.fetch);
		await d2Tab.queue.enqueue({
			...createItem(s, '40.000'),
			kind: 'transaction.update',
			targetId: tx.id,
			expectedUpdatedAt: loaded
		});
		await d2Tab.drainer.drain(true);
		expect((await getTransaction(db, s.spaceId, tx.id))?.amountMinor).toBe(4_000_000);
		net.online = true;
		await d1Tab.drainer.drain(true);
		expect(d1Tab.queue.items).toMatchObject([{ status: 'failed', lastError: TRANSACTION_CHANGED }]);
		expect((await getTransaction(db, s.spaceId, tx.id))?.amountMinor).toBe(4_000_000);
	});
});
