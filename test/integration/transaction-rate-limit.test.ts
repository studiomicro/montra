import { isActionFailure, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { TRANSACTION_CREATES_MAX } from '#lib/server/transactions/create-limit';
import { TRANSACTION_RATE_LIMITED } from '#lib/server/transactions/messages';
import { createTransaction } from '#lib/server/transactions/repo';
import { sha256Hex } from '#lib/server/util';
import { createWallet } from '#lib/server/wallets/repo';
import { TEMPLATE_COLUMNS } from '#lib/shared/csv';
import { wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const baru = await import('../../src/routes/(app)/riwayat/baru/+page.server');
const suara = await import('../../src/routes/(app)/riwayat/suara/+page.server');
const impor = await import('../../src/routes/(app)/impor/+page.server');
const push = await import('../../src/routes/api/v1/sync/push/+server');

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
	const email = `batas${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const user = { id: r.userId, email, name: 'Uji', createdAt: 0 };
	const space = (await resolveCurrentSpace(db, user.id, undefined))!;
	const scope = { spaceId: space.id, userId: user.id };
	await ensurePresetCategories(db, space.id);
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
	if (!w.ok) throw new Error('wallet failed');
	const kopi = (await listCategories(db, space.id)).find((c) => c.tileKey === 'kopi')!.id;
	return { user, space, scope, bca: w.id, kopi };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const counterKey = (userId: string) => sha256Hex(`transaction-create:user:${userId}`);

/** Puts `userId`'s creation counter of the current window at `count`. */
async function setCount(userId: string, count: number) {
	const now = Date.now();
	await d1
		.prepare(
			`insert into auth_attempts (client_hash, window_start, count) values (?, ?, ?)
			on conflict (client_hash) do update set window_start = excluded.window_start, count = excluded.count`
		)
		.bind(await counterKey(userId), now - (now % THROTTLE_WINDOW_MS), count)
		.run();
}
async function count(userId: string) {
	const row = await d1
		.prepare('select count from auth_attempts where client_hash = ?')
		.bind(await counterKey(userId))
		.first<{ count: number }>();
	return row?.count ?? 0;
}
async function liveRows(spaceId: string) {
	const row = await d1
		.prepare('select count(*) as n from transactions where space_id = ? and deleted_at is null')
		.bind(spaceId)
		.first<{ n: number }>();
	return row!.n;
}

type Handler = (event: never) => unknown;
async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return { kind: 'fail' as const, status: value.status, data: value.data as unknown };
		return { kind: 'ok' as const, value };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status };
		throw e;
	}
}
const formAction = (
	actions: unknown,
	name: string,
	s: Setup,
	url: string,
	form: Record<string, string> | [string, string][]
) =>
	run(() =>
		(actions as Record<string, Handler>)[name]!(
			fakeEvent({ url: `http://localhost${url}`, db, user: s.user, space: s.space, form })
				.event as never
		)
	);

const expense = (s: Setup) => ({
	type: 'expense',
	amount: '25.000',
	walletId: s.bca,
	categoryId: s.kopi,
	title: 'Kopi susu',
	note: '',
	occurredOn: wibTodayString(),
	occurredTime: ''
});
const voiceRows = (s: Setup, key: string, rows: number): [string, string][] => [
	['key', key],
	['count', String(rows)],
	...Array.from({ length: rows }, (_, i): [string, string][] => [
		[`type.${i}`, 'expense'],
		[`amount.${i}`, '5.000'],
		[`walletId.${i}`, s.bca],
		[`categoryId.${i}`, s.kopi],
		[`title.${i}`, `parkir ${i}`]
	]).flat()
];

async function importCsvRows(s: Setup, rows: number) {
	const csv = [
		TEMPLATE_COLUMNS.join(','),
		...Array.from({ length: rows }, (_, i) =>
			TEMPLATE_COLUMNS.map(
				(c) =>
					({
						date: '2026-10-01',
						type: 'expense',
						merchant: `Toko ${i}`,
						amount: String(1000 + i),
						wallet_source: 'Tunai'
					})[c as string] ?? ''
			).join(',')
		)
	].join('\n');
	const { event } = fakeEvent({
		url: 'http://localhost/impor?/import',
		routeId: '/(app)/impor',
		db,
		user: s.user,
		space: s.space
	});
	const body = new FormData();
	body.append('file', new File([csv], 'uji.csv', { type: 'text/csv' }));
	body.append('format', '');
	const encoded = new Request('http://localhost/', { method: 'POST', body });
	(event as unknown as { request: Request }).request = new Request(
		'http://localhost/impor?/import',
		{
			method: 'POST',
			headers: { 'content-type': encoded.headers.get('content-type')! },
			body: await encoded.arrayBuffer()
		}
	);
	return run(() => (impor.actions as Record<string, Handler>).import!(event as never));
}

async function pushItem(s: Setup, item: Record<string, unknown>) {
	const { event } = fakeEvent({ url: 'http://localhost/api/v1/sync/push', db, user: s.user });
	Object.assign(event, {
		request: new Request('http://localhost/api/v1/sync/push', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'http://localhost' },
			body: JSON.stringify({ accountId: s.user.id, spaceId: s.space.id, ...item })
		})
	});
	const res = await push.POST(event as never);
	return {
		status: res.status,
		retryAfter: res.headers.get('retry-after'),
		body: (await res.json()) as Record<string, unknown>
	};
}

const LIMITED = { kind: 'fail', status: 429, data: { error: TRANSACTION_RATE_LIMITED } };

describe('per-user transaction creation limit (FN-05 red team L2)', () => {
	it('at the limit every creating path answers 429 with the message and writes nothing', async () => {
		const s = await setup();
		const earlier = await createTransaction(
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
		if (!earlier.ok) throw new Error('setup failed');
		await setCount(s.user.id, TRANSACTION_CREATES_MAX);

		expect(
			await formAction(baru.actions, 'create', s, '/riwayat/baru?/create', expense(s))
		).toMatchObject({ ...LIMITED, data: { ...LIMITED.data, values: { title: 'Kopi susu' } } });
		expect(
			await formAction(baru.actions, 'adjust', s, '/riwayat/baru?/adjust', {
				walletId: s.bca,
				balance: '1.500.000',
				title: '',
				note: '',
				occurredOn: wibTodayString(),
				occurredTime: ''
			})
		).toMatchObject(LIMITED);
		expect(
			await formAction(
				suara.actions,
				'save',
				s,
				'/riwayat/suara?/save',
				voiceRows(s, crypto.randomUUID(), 3)
			)
		).toMatchObject({ ...LIMITED, data: { ...LIMITED.data, action: 'save' } });
		expect(
			await formAction(suara.actions, 'catatLagi', s, '/riwayat/suara?/catatLagi', {
				id: earlier.id,
				key: crypto.randomUUID()
			})
		).toMatchObject({ ...LIMITED, data: { ...LIMITED.data, action: 'catatLagi' } });
		expect(await importCsvRows(s, 4)).toMatchObject(LIMITED);

		const queued = await pushItem(s, {
			clientId: crypto.randomUUID(),
			kind: 'transaction.create',
			payload: Object.entries({ ...expense(s), transferToWalletId: '' })
		});
		expect(queued).toMatchObject({
			status: 429,
			body: { result: 'limit', message: TRANSACTION_RATE_LIMITED }
		});
		expect(Number(queued.retryAfter)).toBeGreaterThan(0);
		expect(Number(queued.retryAfter)).toBeLessThanOrEqual(THROTTLE_WINDOW_MS / 1000);
		expect(
			await pushItem(s, {
				clientId: crypto.randomUUID(),
				kind: 'voice.save',
				occurredOn: wibTodayString(),
				payload: voiceRows(s, crypto.randomUUID(), 2)
			})
		).toMatchObject({ status: 429 });

		expect(await liveRows(s.space.id)).toBe(1);
		// Edits and deletes are not creations: an edit through the queue still goes through.
		const edited = await pushItem(s, {
			clientId: crypto.randomUUID(),
			kind: 'transaction.update',
			targetId: earlier.id,
			expectedUpdatedAt: -1,
			payload: Object.entries({ ...expense(s), transferToWalletId: '' })
		});
		expect(edited.status).not.toBe(429);
	});

	it('below the limit each action counts once: a 3-row voice save and a 4-row import are one each', async () => {
		const s = await setup();
		expect(
			await formAction(baru.actions, 'create', s, '/riwayat/baru?/create', expense(s))
		).toMatchObject({ kind: 'redirect', status: 303 });
		expect(await count(s.user.id)).toBe(1);
		expect(
			await formAction(
				suara.actions,
				'save',
				s,
				'/riwayat/suara?/save',
				voiceRows(s, crypto.randomUUID(), 3)
			)
		).toMatchObject({ kind: 'ok', value: { saved: 3 } });
		expect(await count(s.user.id)).toBe(2);
		expect(await importCsvRows(s, 4)).toMatchObject({
			kind: 'ok',
			value: { done: 'imported', counts: { imported: 4 } }
		});
		expect(await count(s.user.id)).toBe(3);
		expect(await liveRows(s.space.id)).toBe(8);
	});

	it('one user at the limit does not limit another', async () => {
		const a = await setup();
		const b = await setup();
		await setCount(a.user.id, TRANSACTION_CREATES_MAX);
		expect(
			await formAction(baru.actions, 'create', b, '/riwayat/baru?/create', expense(b))
		).toMatchObject({ kind: 'redirect', status: 303 });
	});

	it('20 concurrent creates with 5 left in the budget write exactly 5 rows', async () => {
		const s = await setup();
		await setCount(s.user.id, TRANSACTION_CREATES_MAX - 5);
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				formAction(baru.actions, 'create', s, '/riwayat/baru?/create', expense(s))
			)
		);
		expect(results.filter((r) => r.kind === 'redirect')).toHaveLength(5);
		expect(results.filter((r) => r.kind === 'fail' && r.status === 429)).toHaveLength(15);
		expect(await liveRows(s.space.id)).toBe(5);
	});
});
