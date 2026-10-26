import { describe, expect, it } from 'vitest';
import {
	isStaleItem,
	pushBody,
	PUSH_PAYLOAD_MAX_FIELDS,
	QUEUE_KINDS,
	QUEUE_STALE_MS,
	queueTarget,
	type QueueItem
} from './offline-queue';
import { parsePushRequest, parseQueueItem } from './offline-queue-schema';

const CLIENT = '0b9c5b8e-3f4a-4d6b-9a51-2f1c7e0d8a11';
const SPACE = '6a1f0c2e-8b3d-4e5f-9a0b-1c2d3e4f5a6b';

function item(over: Partial<QueueItem> = {}): QueueItem {
	return {
		clientId: CLIENT,
		spaceId: SPACE,
		kind: 'transaction.create',
		payload: [
			['type', 'expense'],
			['amount', '25.000']
		],
		accountId: 'user-1',
		spaceName: 'Pribadi',
		createdAt: 1_800_000_000_000,
		keptAt: 1_800_000_000_000,
		attempts: 0,
		nextAttemptAt: 0,
		status: 'pending',
		summary: { title: 'Kopi', amountMinor: 2_500_000, currency: 'IDR', count: 1 },
		...over
	};
}

describe('queue kinds (spec §2: create, edit, delete, voice save and "Catat lagi")', () => {
	it('is exactly the five queued kinds', () => {
		expect([...QUEUE_KINDS]).toEqual([
			'transaction.create',
			'transaction.update',
			'transaction.delete',
			'voice.save',
			'voice.recordAgain'
		]);
	});
});

describe('parseQueueItem', () => {
	it('round-trips a valid item', () => {
		const valid = item();
		expect(parseQueueItem(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
	});
	it('rejects an unknown kind', () => {
		expect(parseQueueItem({ ...item(), kind: 'wallet.create' })).toBeNull();
		expect(parseQueueItem({ ...item(), kind: 'auth.signOut' })).toBeNull();
	});
	it('rejects a clientId that is not a UUID', () => {
		expect(parseQueueItem(item({ clientId: 'abc' }))).toBeNull();
		expect(parseQueueItem(item({ clientId: `${CLIENT}x` }))).toBeNull();
	});
	it('rejects an oversized payload (too many fields or a too-long value)', () => {
		const many = Array.from(
			{ length: PUSH_PAYLOAD_MAX_FIELDS + 1 },
			(_, i) => [`f${i}`, 'x'] as [string, string]
		);
		expect(parseQueueItem(item({ payload: many }))).toBeNull();
		expect(parseQueueItem(item({ payload: [['title', 'x'.repeat(5000)]] }))).toBeNull();
	});
	it('rejects float money in the summary', () => {
		expect(
			parseQueueItem(
				item({ summary: { title: 'Kopi', amountMinor: 25.5, currency: 'IDR', count: 1 } })
			)
		).toBeNull();
	});
});

describe('parsePushRequest', () => {
	it('accepts a create without target', () => {
		const r = parsePushRequest({
			clientId: CLIENT,
			accountId: 'user-1',
			spaceId: SPACE,
			kind: 'transaction.create',
			payload: []
		});
		expect(r?.kind).toBe('transaction.create');
	});
	it('needs a target and the loaded updatedAt on an edit or delete', () => {
		const base = { clientId: CLIENT, accountId: 'user-1', spaceId: SPACE, payload: [] };
		expect(parsePushRequest({ ...base, kind: 'transaction.update' })).toBeNull();
		expect(parsePushRequest({ ...base, kind: 'transaction.delete', targetId: 'tx-1' })).toBeNull();
		expect(
			parsePushRequest({
				...base,
				kind: 'transaction.delete',
				targetId: 'tx-1',
				expectedUpdatedAt: 1_800_000_000_000
			})
		).not.toBeNull();
	});
	it('needs the WIB date the voice entry was made on', () => {
		const base = { clientId: CLIENT, accountId: 'user-1', spaceId: SPACE, payload: [] };
		expect(parsePushRequest({ ...base, kind: 'voice.save' })).toBeNull();
		expect(parsePushRequest({ ...base, kind: 'voice.save', occurredOn: '2026-02-30' })).toBeNull();
		expect(
			parsePushRequest({ ...base, kind: 'voice.save', occurredOn: '2026-10-08' })
		).not.toBeNull();
	});
	it('is prototype-safe: payload is a list of pairs, a __proto__ name is just a name', () => {
		const r = parsePushRequest(
			JSON.parse(
				`{"clientId":"${CLIENT}","accountId":"user-1","spaceId":"${SPACE}","kind":"transaction.create","payload":[["__proto__","x"]]}`
			)
		);
		expect(r?.payload).toEqual([['__proto__', 'x']]);
		expect(({} as Record<string, unknown>).x).toBeUndefined();
	});
	it('keeps the queuing account (checked against the session) and drops device-only fields', () => {
		const r = parsePushRequest(item());
		expect(r?.accountId).toBe('user-1');
		expect(r && ('status' in r || 'summary' in r)).toBe(false);
	});
	it('refuses a request without the queuing account (red team L1)', () => {
		const rest: Record<string, unknown> = { ...item() };
		delete rest.accountId;
		expect(parsePushRequest(rest)).toBeNull();
	});
	it('FN-47: keeps the language the item was typed in; an old item without one still parses', () => {
		expect(parsePushRequest(item({ locale: 'en' }))?.locale).toBe('en');
		expect(pushBody(item({ locale: 'id' })).locale).toBe('id');
		expect(parseQueueItem(item())?.locale).toBeUndefined();
		expect(parsePushRequest(item())).not.toBeNull();
		expect(parsePushRequest({ ...item(), locale: 'de' })).toBeNull();
		expect(parseQueueItem({ ...item(), locale: 'EN' })).toBeNull();
	});
	it('refuses non-objects', () => {
		expect(parsePushRequest(null)).toBeNull();
		expect(parsePushRequest('x')).toBeNull();
		expect(parsePushRequest([])).toBeNull();
	});
});

describe('queueTarget (FIFO per target row)', () => {
	it('is the target row for an edit or delete and the item itself otherwise', () => {
		expect(queueTarget(item())).toBe(CLIENT);
		expect(
			queueTarget(item({ kind: 'transaction.update', targetId: 'tx-1', expectedUpdatedAt: 1 }))
		).toBe('tx-1');
		expect(
			queueTarget(item({ kind: 'transaction.delete', targetId: 'tx-1', expectedUpdatedAt: 1 }))
		).toBe('tx-1');
	});
});

describe('isStaleItem (7 days, owner default)', () => {
	it('is stale only after 7 days since the user last kept it', () => {
		const kept = 1_800_000_000_000;
		expect(isStaleItem(item({ keptAt: kept }), kept + QUEUE_STALE_MS)).toBe(false);
		expect(isStaleItem(item({ keptAt: kept }), kept + QUEUE_STALE_MS + 1)).toBe(true);
		expect(QUEUE_STALE_MS).toBe(7 * 24 * 60 * 60 * 1000);
	});
});
