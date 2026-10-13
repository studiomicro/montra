import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { QUEUE_FAILED_GENERIC, QUEUE_STALE_MS, type PushRequest } from '#lib/shared/offline-queue';
import { QueueDb } from './db';
import { drainLock } from './lock';
import { OfflineQueue, type NewQueueItem } from './store.svelte';
import { backoffCeiling, backoffDelay, classify, Drainer, pauseOnSignOut, PUSH_URL } from './sync';

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

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'network';

/** A fetch standing in for the push endpoint: answers from `answer(body)`, records every body in order. */
function fakeServer(answer: (body: PushRequest) => Answer | Promise<Answer>) {
	const calls: PushRequest[] = [];
	const fetch = (async (url: string, init: RequestInit) => {
		expect(url).toBe(PUSH_URL);
		expect(init.method).toBe('POST');
		const body = JSON.parse(String(init.body)) as PushRequest;
		calls.push(body);
		const a = await answer(body);
		if (a === 'network') throw new TypeError('Failed to fetch');
		return new Response(a.body === undefined ? '' : JSON.stringify(a.body), {
			status: a.status,
			headers: a.headers
		});
	}) as unknown as typeof globalThis.fetch;
	return { calls, fetch };
}

const ok = (b: PushRequest): Answer => ({
	status: 200,
	body: { clientId: b.clientId, result: 'ok' }
});

let clock: number;
let timers: { fn: () => void; ms: number }[];
let queue: OfflineQueue;

beforeEach(async () => {
	clock = 1_800_000_000_000;
	timers = [];
	queue = new OfflineQueue(await QueueDb.open(new IDBFactory()), 'user-a', () => clock);
});

function drainer(fetch: typeof globalThis.fetch, random = () => 0.5) {
	return new Drainer({
		queue,
		fetch,
		lock: drainLock(undefined),
		now: () => clock,
		random,
		schedule: (fn, ms) => {
			const t = { fn, ms };
			timers.push(t);
			return () => timers.splice(timers.indexOf(t), 1);
		}
	});
}

describe('backoff (2/4/8/16/30 s, full jitter)', () => {
	it('ceilings follow the schedule and stay at 30 s', () => {
		expect([1, 2, 3, 4, 5, 6, 50].map(backoffCeiling)).toEqual([
			2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000
		]);
	});
	it('a delay is within [0, ceiling]', () => {
		for (const attempts of [1, 3, 9]) {
			expect(backoffDelay(attempts, () => 0)).toBe(0);
			const top = backoffDelay(attempts, () => 0.999_999);
			expect(top).toBeLessThanOrEqual(backoffCeiling(attempts));
			expect(top).toBeGreaterThan(backoffCeiling(attempts) * 0.99);
		}
	});
});

describe('classify', () => {
	it('maps every answer the push endpoint can give', () => {
		expect(classify(null, null)).toEqual({ kind: 'retry' });
		for (const s of [0, 408, 429, 502, 503, 504])
			expect(classify(s, null)).toEqual({ kind: 'retry' });
		expect(classify(200, { result: 'ok' })).toEqual({ kind: 'ok' });
		// A captive portal's 200 page is not a confirmation.
		expect(classify(200, null)).toEqual({ kind: 'retry' });
		expect(classify(401, { result: 'session' })).toEqual({ kind: 'session' });
		expect(classify(409, { result: 'stale', message: 'Data ini sudah berubah.' })).toEqual({
			kind: 'failed',
			reason: 'Data ini sudah berubah.'
		});
		expect(classify(403, { message: 'Forbidden' })).toEqual({
			kind: 'failed',
			reason: 'Forbidden'
		});
		expect(classify(500, null)).toEqual({ kind: 'failed', reason: QUEUE_FAILED_GENERIC });
		expect(classify(413, { message: 'x'.repeat(301) })).toEqual({
			kind: 'failed',
			reason: QUEUE_FAILED_GENERIC
		});
	});
});

describe('Drainer (task 7)', () => {
	it('ok: the item leaves the queue only after the server answered ok', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const server = fakeServer(async (b) => {
			await gate;
			return ok(b);
		});
		await queue.enqueue(newItem());
		const running = drainer(server.fetch).drain();
		await new Promise((r) => setTimeout(r, 20));
		expect(queue.items).toMatchObject([{ status: 'sending' }]);
		expect(queue.confirmed).toBe(0);
		release();
		await running;
		expect(queue.items).toEqual([]);
		expect(queue.confirmed).toBe(1);
	});

	it('FN-47: the item is sent with the language it was typed in, kept in IndexedDB', async () => {
		const server = fakeServer(ok);
		await queue.enqueue(newItem({ locale: 'en', payload: [['amount', '12.50']] }));
		await drainer(server.fetch).drain();
		expect(server.calls).toMatchObject([{ locale: 'en', payload: [['amount', '12.50']] }]);
	});

	it('a network error keeps the item pending and retries it after the backoff', async () => {
		let online = false;
		const server = fakeServer((b) => (online ? ok(b) : 'network'));
		await queue.enqueue(newItem());
		const d = drainer(server.fetch, () => 0.5);
		await d.drain();
		expect(queue.items).toMatchObject([
			{ status: 'pending', attempts: 1, nextAttemptAt: clock + 1_000 }
		]);
		expect(timers.map((t) => t.ms)).toEqual([1_000]);
		// Not due yet: nothing is sent.
		await d.drain();
		expect(server.calls).toHaveLength(1);
		// Second failure: the ceiling doubles.
		clock += 1_000;
		await d.drain();
		expect(queue.items).toMatchObject([{ attempts: 2, nextAttemptAt: clock + 2_000 }]);
		online = true;
		clock += 2_000;
		timers.at(-1)!.fn();
		await new Promise((r) => setTimeout(r, 20));
		expect(queue.items).toEqual([]);
		expect(server.calls).toHaveLength(3);
	});

	it('force (the online event) sends at once, ignoring the backoff wait', async () => {
		let online = false;
		const server = fakeServer((b) => (online ? ok(b) : 'network'));
		await queue.enqueue(newItem());
		const d = drainer(server.fetch);
		await d.drain();
		online = true;
		await d.drain(true);
		expect(queue.items).toEqual([]);
	});

	it('409 stale: failed at once with the reason, never retried on its own', async () => {
		const server = fakeServer(() => ({
			status: 409,
			body: { result: 'stale', message: 'Data ini sudah berubah.' }
		}));
		await queue.enqueue(newItem());
		const d = drainer(server.fetch);
		await d.drain();
		await d.drain(true);
		expect(server.calls).toHaveLength(1);
		expect(queue.items).toMatchObject([{ status: 'failed', lastError: 'Data ini sudah berubah.' }]);
		expect(timers).toEqual([]);
	});

	it('401 pauses the whole queue (session ended); items stay queued; nothing else is sent', async () => {
		const server = fakeServer(() => ({ status: 401, body: { result: 'session' } }));
		await queue.enqueue(newItem());
		clock++;
		await queue.enqueue(newItem());
		clock++;
		await queue.enqueue(newItem());
		const d = drainer(server.fetch);
		await d.drain();
		expect(queue.sessionEnded).toBe(true);
		// Up to 4 targets may have been in flight at once; after the 401 nothing more starts.
		const sent = server.calls.length;
		await d.drain(true);
		expect(server.calls).toHaveLength(sent);
		expect(queue.items.map((i) => i.status)).toEqual(['pending', 'pending', 'pending']);
		expect(timers).toEqual([]);
	});

	it('items of one target go strictly in order; other targets may overlap', async () => {
		const pending = new Map<string, () => void>();
		const order: string[] = [];
		const server = fakeServer(
			(b) =>
				new Promise<Answer>((resolve) => {
					order.push(`start ${b.clientId}`);
					pending.set(b.clientId, () => {
						order.push(`end ${b.clientId}`);
						resolve(ok(b));
					});
				})
		);
		const edit = newItem({ kind: 'transaction.update', targetId: 'tx-1', expectedUpdatedAt: 5 });
		const del = newItem({ kind: 'transaction.delete', targetId: 'tx-1', expectedUpdatedAt: 5 });
		const create = newItem();
		await queue.enqueue(edit);
		clock++;
		await queue.enqueue(del);
		clock++;
		await queue.enqueue(create);
		const running = drainer(server.fetch).drain();
		await new Promise((r) => setTimeout(r, 30));
		// The edit and the unrelated create are in flight together; the delete waits for the edit.
		expect(new Set(pending.keys())).toEqual(new Set([edit.clientId, create.clientId]));
		pending.get(create.clientId)!();
		await new Promise((r) => setTimeout(r, 30));
		expect(pending.has(del.clientId)).toBe(false);
		pending.get(edit.clientId)!();
		await new Promise((r) => setTimeout(r, 30));
		pending.get(del.clientId)!();
		await running;
		expect(order.indexOf(`start ${del.clientId}`)).toBeGreaterThan(
			order.indexOf(`end ${edit.clientId}`)
		);
		expect(queue.items).toEqual([]);
	});

	it('at most 4 targets are in flight at once', async () => {
		let inFlight = 0;
		let most = 0;
		const server = fakeServer(async (b) => {
			inFlight++;
			most = Math.max(most, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return ok(b);
		});
		for (let i = 0; i < 10; i++) await queue.enqueue(newItem());
		await drainer(server.fetch).drain();
		expect(most).toBe(4);
		expect(server.calls).toHaveLength(10);
	});

	it('an item not kept for 7 days waits for the user; after "Kirim lagi" it is sent', async () => {
		const server = fakeServer(ok);
		const item = newItem();
		await queue.enqueue(item);
		clock += QUEUE_STALE_MS + 1;
		const d = drainer(server.fetch);
		await d.drain(true);
		expect(server.calls).toEqual([]);
		await queue.retry(item.clientId);
		await d.drain();
		expect(queue.items).toEqual([]);
	});

	it('a drain asked for during a drain runs once more instead of twice at once', async () => {
		const server = fakeServer(ok);
		await queue.enqueue(newItem());
		const d = drainer(server.fetch);
		const first = d.drain();
		await queue.enqueue(newItem());
		await d.drain();
		await first;
		expect(server.calls).toHaveLength(2);
		expect(queue.items).toEqual([]);
	});

	it('the body sent is only the wire fields, with the queuing account (no status or summary)', async () => {
		const server = fakeServer(ok);
		await queue.enqueue(newItem());
		await drainer(server.fetch).drain();
		expect(server.calls[0]?.accountId).toBe('user-a');
		expect(Object.keys(server.calls[0]!).sort()).toEqual([
			'accountId',
			'clientId',
			'kind',
			'locale',
			'payload',
			'spaceId'
		]);
	});
});

describe('cycle 2 (red team L4, L1)', () => {
	it('429 keeps the item pending and waits at least Retry-After before the next attempt', async () => {
		let limited = true;
		const server = fakeServer((b) =>
			limited
				? { status: 429, body: { message: 'Too many requests' }, headers: { 'retry-after': '120' } }
				: ok(b)
		);
		await queue.enqueue(newItem());
		const d = drainer(server.fetch, () => 0);
		await d.drain();
		expect(queue.items).toMatchObject([{ status: 'pending', attempts: 1 }]);
		expect(queue.items[0]!.nextAttemptAt).toBeGreaterThanOrEqual(clock + 120_000);
		clock += 60_000;
		await d.drain();
		expect(server.calls).toHaveLength(1);
		limited = false;
		clock += 60_000;
		await d.drain();
		expect(queue.items).toEqual([]);
	});

	it('a sign-out broadcast from another tab pauses this queue; nothing more is sent', async () => {
		const server = fakeServer(ok);
		const here = new BroadcastChannel('financer-session-test');
		const other = new BroadcastChannel('financer-session-test');
		const stop = pauseOnSignOut(here, queue);
		other.postMessage('signed-out');
		await new Promise((r) => setTimeout(r, 30));
		expect(queue.sessionEnded).toBe(true);
		await queue.enqueue(newItem());
		await drainer(server.fetch).drain(true);
		expect(server.calls).toEqual([]);
		expect(queue.items).toHaveLength(1);
		stop();
		other.close();
	});
});
