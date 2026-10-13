import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { SESSION_ENDED } from '#lib/server/auth/gate';
import {
	REFS_GONE,
	TRANSACTION_CHANGED,
	TRANSACTION_LIMIT,
	TRANSACTION_NOT_FOUND
} from '#lib/server/transactions/messages';
import { archiveWallet } from '#lib/server/wallets/repo';
import { addDays } from '#lib/shared/dates';
import {
	PUSH_BODY_MAX_BYTES,
	QUEUE_ONLINE_ONLY,
	QUEUE_SPACE_GONE,
	type PushRequest as WireRequest
} from '#lib/shared/offline-queue';

/** A wire body as the tests write it; `push` adds the queuing account like the device does. */
type PushRequest = Omit<WireRequest, 'accountId'> & { accountId?: string };
import { pushQueuedWrite } from '#lib/server/sync/push';
import { createTransactionOnce } from '#lib/server/transactions/client-id';
import {
	createTransaction,
	deleteTransaction,
	getTransaction
} from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const route = await import('../../src/routes/api/v1/sync/push/+server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function person(name = 'Uji') {
	const email = `antrean${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name, createdAt: 0 } };
}
type Person = Awaited<ReturnType<typeof person>>;

async function setup(who?: Person, space?: string) {
	const p = who ?? (await person());
	const spaceId = (await resolveCurrentSpace(db, p.user.id, space))!.id;
	await ensurePresetCategories(db, spaceId);
	const scope = { spaceId, userId: p.user.id };
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
	const cats = await listCategories(db, spaceId);
	const cat = (key: string) => cats.find((c) => c.tileKey === key)!.id;
	return { p, spaceId, scope, bca: w.id, kopi: cat('kopi'), gaji: cat('gaji') };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const input = (s: Setup, o: Partial<TransactionInput> = {}): TransactionInput => ({
	type: 'expense',
	amountMinor: 2_500_000,
	currency: 'IDR',
	walletId: s.bca,
	transferToWalletId: null,
	categoryId: s.kopi,
	title: 'Kopi susu',
	note: null,
	occurredOn: wibTodayString(),
	occurredTime: null,
	...o
});

const countRows = async (spaceId: string) =>
	(
		await db.all<{ n: number }>(
			sql`select count(*) as n from transactions where space_id = ${spaceId}`
		)
	)[0]!.n;

describe('createTransactionOnce (task 2: caller-supplied id, idempotent)', () => {
	it('inserts one row with the given id', async () => {
		const s = await setup();
		const id = crypto.randomUUID();
		expect(await createTransactionOnce(db, s.scope, id, input(s), Date.now())).toEqual({
			ok: true,
			id
		});
		expect((await getTransaction(db, s.spaceId, id))?.amountMinor).toBe(2_500_000);
		expect(await countRows(s.spaceId)).toBe(1);
	});

	it('a resend with the same id and fields is ok and writes nothing', async () => {
		const s = await setup();
		const id = crypto.randomUUID();
		await createTransactionOnce(db, s.scope, id, input(s), Date.now());
		expect(await createTransactionOnce(db, s.scope, id, input(s), Date.now())).toEqual({
			ok: true,
			id
		});
		expect(await countRows(s.spaceId)).toBe(1);
	});

	it('a resend with different fields is ok, but the first write stays authoritative', async () => {
		const s = await setup();
		const id = crypto.randomUUID();
		await createTransactionOnce(db, s.scope, id, input(s), Date.now());
		const again = await createTransactionOnce(
			db,
			s.scope,
			id,
			input(s, { amountMinor: 99_900, title: 'Diubah' }),
			Date.now()
		);
		expect(again).toEqual({ ok: true, id });
		const row = await getTransaction(db, s.spaceId, id);
		expect([row?.amountMinor, row?.title]).toEqual([2_500_000, 'Kopi susu']);
		expect(await countRows(s.spaceId)).toBe(1);
	});

	it('20 concurrent identical creates: exactly one row, every answer ok (pre-handoff probe)', async () => {
		const s = await setup();
		const id = crypto.randomUUID();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => createTransactionOnce(db, s.scope, id, input(s), Date.now()))
		);
		expect(results.every((r) => r.ok && r.id === id)).toBe(true);
		expect(await countRows(s.spaceId)).toBe(1);
	});

	it('a deleted row is never recreated by a resend of its create', async () => {
		const s = await setup();
		const id = crypto.randomUUID();
		await createTransactionOnce(db, s.scope, id, input(s), Date.now());
		const row = await getTransaction(db, s.spaceId, id);
		expect(await deleteTransaction(db, s.scope, id, row!.updatedAt, Date.now())).toBe('ok');
		expect(await createTransactionOnce(db, s.scope, id, input(s), Date.now())).toEqual({
			ok: true,
			id
		});
		expect(await getTransaction(db, s.spaceId, id)).toBeNull();
		expect(await countRows(s.spaceId)).toBe(1);
	});

	it("an id taken in another space is refused as gone and leaves that space's row alone", async () => {
		const a = await setup();
		const b = await setup();
		const taken = await createTransaction(db, a.scope, input(a), Date.now());
		if (!taken.ok) throw new Error('setup');
		expect(await createTransactionOnce(db, b.scope, taken.id, input(b), Date.now())).toEqual({
			ok: false,
			reason: 'gone'
		});
		expect(await countRows(b.spaceId)).toBe(0);
		expect((await getTransaction(db, a.spaceId, taken.id))?.title).toBe('Kopi susu');
	});

	it('existing callers without an id still mint a fresh one', async () => {
		const s = await setup();
		const a = await createTransaction(db, s.scope, input(s), Date.now());
		const b = await createTransaction(db, s.scope, input(s), Date.now());
		expect(a.ok && b.ok && a.id !== b.id).toBe(true);
	});
});

/** A POST to the push endpoint as the browser's queue sends it (same-origin JSON) unless `opts` says otherwise. */
async function push(
	who: Person | null,
	body: unknown,
	opts: {
		origin?: string | null;
		contentType?: string;
		raw?: string;
		currentSpace?: string;
		locale?: 'id' | 'en';
	} = {}
) {
	const { event } = fakeEvent({
		url: 'http://localhost/api/v1/sync/push',
		db,
		user: who?.user ?? null,
		locale: opts.locale
	});
	const headers = new Headers({ 'content-type': opts.contentType ?? 'application/json' });
	if (opts.origin !== null) headers.set('origin', opts.origin ?? 'http://localhost');
	const request = new Request('http://localhost/api/v1/sync/push', {
		method: 'POST',
		headers,
		body:
			opts.raw ??
			JSON.stringify(
				body && typeof body === 'object' && !Array.isArray(body) && who && !('accountId' in body)
					? { accountId: who.user.id, ...body }
					: body
			)
	});
	Object.assign(event, { request });
	// The current space never decides where an item goes (spec §10): set it to something else on purpose.
	if (opts.currentSpace && who)
		event.locals.space = await resolveCurrentSpace(db, who.user.id, opts.currentSpace);
	try {
		const res = await route.POST(event as never);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	} catch (e) {
		const err = e as { status?: number };
		if (typeof err.status === 'number') return { status: err.status, body: {} };
		throw e;
	}
}

const createForm = (s: Setup, o: Record<string, string> = {}): [string, string][] =>
	Object.entries({
		type: 'expense',
		amount: '25.000',
		walletId: s.bca,
		transferToWalletId: '',
		categoryId: s.kopi,
		title: 'Kopi susu',
		note: '',
		occurredOn: wibTodayString(),
		occurredTime: '',
		...o
	});

const createItem = (s: Setup, o: Partial<PushRequest> = {}): PushRequest => ({
	clientId: crypto.randomUUID(),
	spaceId: s.spaceId,
	kind: 'transaction.create',
	payload: createForm(s),
	...o
});

const voiceForm = (s: Setup, key: string, rows = 1): [string, string][] => {
	const out: [string, string][] = [
		['key', key],
		['count', String(rows)]
	];
	for (let i = 0; i < rows; i++)
		out.push(
			[`type.${i}`, 'expense'],
			[`amount.${i}`, '5.000'],
			[`walletId.${i}`, s.bca],
			[`categoryId.${i}`, s.kopi],
			[`title.${i}`, `parkir ${i}`]
		);
	return out;
};

async function sharedSpace() {
	const owner = await person('Pemilik');
	const member = await person('Anggota');
	const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
	const invite = (await createInvite(
		db,
		{ spaceId, userId: owner.user.id, replaces: '' },
		Date.now()
	))!;
	await acceptInvite(db, invite.token, member.user.id, Date.now());
	const s = await setup(owner, spaceId);
	const remove = async () => {
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
	};
	return { owner, member, spaceId, s, remove };
}

describe('/api/v1/sync/push: gates before any database work (task 3)', () => {
	it('refuses a cross-origin POST with 403 and writes nothing', async () => {
		const s = await setup();
		const item = createItem(s);
		const res = await push(s.p, item, { origin: 'https://evil.example' });
		expect(res.status).toBe(403);
		expect(await getTransaction(db, s.spaceId, item.clientId)).toBeNull();
	});
	it('refuses a POST without Origin (403)', async () => {
		const s = await setup();
		expect((await push(s.p, createItem(s), { origin: null })).status).toBe(403);
	});
	it('a request without a session gets 401 `session` with the sign-in-again message', async () => {
		const s = await setup();
		expect(await push(null, createItem(s))).toEqual({
			status: 401,
			body: { clientId: null, result: 'session', message: SESSION_ENDED }
		});
	});
	it('a form or text body is 415, malformed JSON 400, an oversized body 413 (never 500)', async () => {
		const s = await setup();
		expect((await push(s.p, null, { contentType: 'text/plain', raw: '{}' })).status).toBe(415);
		expect(
			(
				await push(s.p, null, {
					contentType: 'application/x-www-form-urlencoded',
					raw: 'a=1'
				})
			).status
		).toBe(415);
		expect(await push(s.p, null, { raw: '{"clientId":' })).toEqual({
			status: 400,
			body: { clientId: null, result: 'invalid' }
		});
		expect((await push(s.p, null, { raw: 'x'.repeat(PUSH_BODY_MAX_BYTES + 1) })).status).toBe(413);
	});
	it('an unknown kind, a non-UUID clientId or a missing target is 400 invalid', async () => {
		const s = await setup();
		for (const bad of [
			{ ...createItem(s), kind: 'wallet.create' },
			{ ...createItem(s), kind: 'auth.signOut' },
			{ ...createItem(s), clientId: 'not-a-uuid' },
			{ ...createItem(s), kind: 'transaction.update' }
		])
			expect((await push(s.p, bad)).body).toMatchObject({ result: 'invalid' });
	});
});

describe('/api/v1/sync/push: each kind through the existing write path (tasks 3 and 4)', () => {
	it('create → ok, the row has the clientId; a resend is ok with no second row', async () => {
		const s = await setup();
		const item = createItem(s);
		expect(await push(s.p, item)).toEqual({
			status: 200,
			body: { clientId: item.clientId, result: 'ok' }
		});
		expect(await push(s.p, item)).toMatchObject({ status: 200, body: { result: 'ok' } });
		expect(await countRows(s.spaceId)).toBe(1);
		const row = await getTransaction(db, s.spaceId, item.clientId);
		expect([row?.amountMinor, row?.source, row?.title]).toEqual([2_500_000, 'manual', 'Kopi susu']);
	});

	it('20 concurrent identical pushes of one create: exactly one row (criterion 2)', async () => {
		const s = await setup();
		const item = createItem(s);
		const all = await Promise.all(Array.from({ length: 20 }, () => push(s.p, item)));
		expect(all.map((r) => r.status)).toEqual(Array(20).fill(200));
		expect(await countRows(s.spaceId)).toBe(1);
	});

	it('create with a field error → 400 invalid with that field message, nothing written', async () => {
		const s = await setup();
		const res = await push(s.p, createItem(s, { payload: createForm(s, { amount: '12,50' }) }));
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ result: 'invalid' });
		expect(typeof res.body.message).toBe('string');
		expect(await countRows(s.spaceId)).toBe(0);
	});

	it('create never writes a balance adjustment (FN-37 stays online-only)', async () => {
		const s = await setup();
		const res = await push(s.p, createItem(s, { payload: createForm(s, { type: 'adjustment' }) }));
		expect(res.body).toMatchObject({ result: 'invalid' });
		expect(await countRows(s.spaceId)).toBe(0);
	});

	it("create whose wallet was archived meanwhile → 400 invalid, the form's own field error", async () => {
		const s = await setup();
		const w = await db.all<{ updated_at: number }>(
			sql`select updated_at from wallets where id = ${s.bca}`
		);
		await archiveWallet(db, s.scope, s.bca, w[0]!.updated_at, Date.now());
		const res = await push(s.p, createItem(s));
		expect(res.status).toBe(400);
		// An archived wallet is not a usable choice: the same field error the form gives.
		expect(res.body).toMatchObject({ result: 'invalid' });
	});

	it("create whose clientId is another space's row id → 409 gone, that row untouched", async () => {
		const a = await setup();
		const b = await setup();
		const taken = await createTransaction(db, b.scope, input(b), Date.now());
		if (!taken.ok) throw new Error('setup');
		expect(await push(a.p, createItem(a, { clientId: taken.id }))).toMatchObject({
			status: 409,
			body: { result: 'gone', message: REFS_GONE }
		});
		expect((await getTransaction(db, b.spaceId, taken.id))?.title).toBe('Kopi susu');
	});

	it('create and voice.save in a full space → 409 limit with the limit message', async () => {
		const s = await setup();
		await d1
			.prepare(
				`with recursive n(i) as (select 1 union all select i + 1 from n where i < 100000)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					occurred_on, occurred_at, created_at, updated_at, seq)
				select lower(hex(randomblob(16))), ?, 'expense', 100, 'IDR', ?, ?, '2026-10-08', 0, 0, 0, 1 from n`
			)
			.bind(s.spaceId, s.kopi, s.bca)
			.run();
		expect(await push(s.p, createItem(s))).toMatchObject({
			status: 409,
			body: { result: 'limit', message: TRANSACTION_LIMIT }
		});
		const voice: PushRequest = {
			clientId: crypto.randomUUID(),
			spaceId: s.spaceId,
			kind: 'voice.save',
			occurredOn: wibTodayString(),
			payload: voiceForm(s, crypto.randomUUID())
		};
		expect(await push(s.p, voice)).toMatchObject({ status: 409, body: { result: 'limit' } });
	});

	it('update with the loaded updatedAt → ok; with an older one → 409 stale, row unchanged (criterion 4)', async () => {
		const s = await setup();
		const created = await createTransaction(db, s.scope, input(s), Date.now());
		if (!created.ok) throw new Error('setup');
		const loaded = (await getTransaction(db, s.spaceId, created.id))!.updatedAt;
		const edit = (amount: string): PushRequest => ({
			clientId: crypto.randomUUID(),
			spaceId: s.spaceId,
			kind: 'transaction.update',
			targetId: created.id,
			expectedUpdatedAt: loaded,
			payload: createForm(s, { amount })
		});
		expect(await push(s.p, edit('30.000'))).toMatchObject({ status: 200, body: { result: 'ok' } });
		// A second device's queued edit, loaded before the first landed.
		expect(await push(s.p, edit('99.000'))).toMatchObject({
			status: 409,
			body: { result: 'stale', message: TRANSACTION_CHANGED }
		});
		expect((await getTransaction(db, s.spaceId, created.id))?.amountMinor).toBe(3_000_000);
	});

	it('update or delete of an unknown or other-space id → 404 missing, one answer', async () => {
		const a = await setup();
		const b = await setup();
		const other = await createTransaction(db, b.scope, input(b), Date.now());
		if (!other.ok) throw new Error('setup');
		const at = (await getTransaction(db, b.spaceId, other.id))!.updatedAt;
		const answers = [];
		for (const targetId of [other.id, crypto.randomUUID()])
			for (const kind of ['transaction.update', 'transaction.delete'] as const)
				answers.push(
					await push(a.p, {
						clientId: crypto.randomUUID(),
						spaceId: a.spaceId,
						kind,
						targetId,
						expectedUpdatedAt: at,
						payload: createForm(a)
					})
				);
		for (const r of answers)
			expect(r).toMatchObject({
				status: 404,
				body: { result: 'missing', message: TRANSACTION_NOT_FOUND }
			});
		expect((await getTransaction(db, b.spaceId, other.id))?.amountMinor).toBe(2_500_000);
	});

	it('delete → ok (tombstone); a stale delete → 409 stale; a resent delete → ok, nothing written', async () => {
		const s = await setup();
		const created = await createTransaction(db, s.scope, input(s), Date.now());
		if (!created.ok) throw new Error('setup');
		const loaded = (await getTransaction(db, s.spaceId, created.id))!.updatedAt;
		const del = (expectedUpdatedAt: number): PushRequest => ({
			clientId: crypto.randomUUID(),
			spaceId: s.spaceId,
			kind: 'transaction.delete',
			targetId: created.id,
			expectedUpdatedAt,
			payload: []
		});
		expect(await push(s.p, del(loaded - 1))).toMatchObject({
			status: 409,
			body: { result: 'stale' }
		});
		expect(await push(s.p, del(loaded))).toMatchObject({ status: 200, body: { result: 'ok' } });
		expect(await getTransaction(db, s.spaceId, created.id)).toBeNull();
		const tombstone = async () =>
			(
				await db.all<{ updated_at: number; seq: number }>(
					sql`select updated_at, seq from transactions where id = ${created.id}`
				)
			)[0];
		const before = await tombstone();
		// The first answer was lost: the device sends the same delete again, and any stale one too.
		for (const expected of [loaded, loaded - 1])
			expect(await push(s.p, del(expected))).toMatchObject({ status: 200, body: { result: 'ok' } });
		expect(await tombstone()).toEqual(before);
		// Another space's member resending it still gets the one "not found" answer.
		const b = await setup();
		expect(await push(b.p, { ...del(loaded), spaceId: b.spaceId })).toMatchObject({
			status: 404,
			body: { result: 'missing' }
		});
	});

	it('an adjustment is never changed or deleted through the queue', async () => {
		const s = await setup();
		const { createBalanceAdjustment } = await import('#lib/server/transactions/adjustment');
		const adj = await createBalanceAdjustment(
			db,
			s.scope,
			{
				walletId: s.bca,
				balance: '50.000',
				negative: false,
				locale: 'id' as const,
				title: null,
				note: null,
				occurredOn: wibTodayString(),
				occurredTime: null
			},
			Date.now()
		);
		if (!adj.ok) throw new Error('setup');
		const [row] = await db.all<{ id: string; updated_at: number }>(
			sql`select id, updated_at from transactions where space_id = ${s.spaceId} and type = 'adjustment'`
		);
		for (const kind of ['transaction.update', 'transaction.delete'] as const)
			expect(
				await push(s.p, {
					clientId: crypto.randomUUID(),
					spaceId: s.spaceId,
					kind,
					targetId: row!.id,
					expectedUpdatedAt: row!.updated_at,
					payload: createForm(s)
				})
			).toMatchObject({ status: 400, body: { result: 'invalid', message: QUEUE_ONLINE_ONLY } });
		expect((await getTransaction(db, s.spaceId, row!.id))?.type).toBe('adjustment');
	});

	it('voice.save → ok with source voice on the WIB day it was made; a resend is ok, no new rows', async () => {
		const s = await setup();
		const key = crypto.randomUUID();
		const yesterday = addDays(wibTodayString(), -1);
		const item: PushRequest = {
			clientId: crypto.randomUUID(),
			spaceId: s.spaceId,
			kind: 'voice.save',
			occurredOn: yesterday,
			payload: voiceForm(s, key, 2)
		};
		expect(await push(s.p, item)).toMatchObject({ status: 200, body: { result: 'ok' } });
		// `duplicate` on the dedupe key: the first attempt was applied, so ok (never a second copy).
		expect(await push(s.p, item)).toMatchObject({ status: 200, body: { result: 'ok' } });
		const rows = await db.all<{ source: string; occurred_on: string; dedupe_key: string }>(
			sql`select source, occurred_on, dedupe_key from transactions where space_id = ${s.spaceId} order by dedupe_key`
		);
		expect(rows).toEqual([
			{ source: 'voice', occurred_on: yesterday, dedupe_key: `${key}:0` },
			{ source: 'voice', occurred_on: yesterday, dedupe_key: `${key}:1` }
		]);
	});

	it('voice.save dated in the future (a device clock ahead) counts on today (WIB)', async () => {
		const s = await setup();
		const item: PushRequest = {
			clientId: crypto.randomUUID(),
			spaceId: s.spaceId,
			kind: 'voice.save',
			occurredOn: addDays(wibTodayString(), 3),
			payload: voiceForm(s, crypto.randomUUID())
		};
		expect((await push(s.p, item)).status).toBe(200);
		const [row] = await db.all<{ occurred_on: string }>(
			sql`select occurred_on from transactions where space_id = ${s.spaceId}`
		);
		expect(row?.occurred_on).toBe(wibTodayString());
	});

	it('voice.save with a bad row → 400 invalid; without a key → 400 invalid; nothing written', async () => {
		const s = await setup();
		const bad = voiceForm(s, crypto.randomUUID()).map(([k, v]): [string, string] =>
			k === 'walletId.0' ? [k, crypto.randomUUID()] : [k, v]
		);
		const base = { spaceId: s.spaceId, kind: 'voice.save' as const, occurredOn: wibTodayString() };
		expect(await push(s.p, { ...base, clientId: crypto.randomUUID(), payload: bad })).toMatchObject(
			{ status: 400, body: { result: 'invalid' } }
		);
		expect(
			await push(s.p, {
				...base,
				clientId: crypto.randomUUID(),
				payload: voiceForm(s, 'no-key')
			})
		).toMatchObject({ status: 400, body: { result: 'invalid' } });
		expect(await countRows(s.spaceId)).toBe(0);
	});

	it('voice.recordAgain whose source category is hidden now → 409 gone (REFS_GONE)', async () => {
		const s = await setup();
		const src = await createTransaction(db, s.scope, input(s), Date.now());
		if (!src.ok) throw new Error('setup');
		await d1.prepare('update categories set is_hidden = 1 where id = ?').bind(s.kopi).run();
		expect(
			await push(s.p, {
				clientId: crypto.randomUUID(),
				spaceId: s.spaceId,
				kind: 'voice.recordAgain',
				occurredOn: wibTodayString(),
				payload: [
					['id', src.id],
					['key', crypto.randomUUID()]
				]
			})
		).toMatchObject({ status: 409, body: { result: 'gone', message: REFS_GONE } });
	});

	it('voice.recordAgain → ok; the same tap resent → ok, one copy; an unknown source → 404 missing', async () => {
		const s = await setup();
		const src = await createTransaction(db, s.scope, input(s), Date.now());
		if (!src.ok) throw new Error('setup');
		const item: PushRequest = {
			clientId: crypto.randomUUID(),
			spaceId: s.spaceId,
			kind: 'voice.recordAgain',
			occurredOn: wibTodayString(),
			payload: [
				['id', src.id],
				['key', crypto.randomUUID()]
			]
		};
		expect(await push(s.p, item)).toMatchObject({ status: 200, body: { result: 'ok' } });
		expect(await push(s.p, item)).toMatchObject({ status: 200, body: { result: 'ok' } });
		expect(await countRows(s.spaceId)).toBe(2);
		expect(
			await push(s.p, {
				...item,
				clientId: crypto.randomUUID(),
				payload: [
					['id', crypto.randomUUID()],
					['key', crypto.randomUUID()]
				]
			})
		).toMatchObject({ status: 404, body: { result: 'missing' } });
	});
});

describe('/api/v1/sync/push: space re-authorisation per item (criteria 5 and 10)', () => {
	it("another user's space and a space that does not exist get the same 404 no-access", async () => {
		const a = await setup();
		const b = await setup();
		const foreign = await push(a.p, createItem(a, { spaceId: b.spaceId, payload: createForm(b) }));
		const ghost = await push(a.p, createItem(a, { spaceId: crypto.randomUUID() }));
		expect(foreign.status).toBe(404);
		expect(ghost.status).toBe(404);
		expect({ ...foreign.body, clientId: null }).toEqual({ ...ghost.body, clientId: null });
		expect(foreign.body).toMatchObject({ result: 'no-access', message: QUEUE_SPACE_GONE });
		expect(await countRows(b.spaceId)).toBe(0);
	});

	it('a member removed while offline: their queued create and edit are 404 no-access, nothing written', async () => {
		const { member, spaceId, s, remove } = await sharedSpace();
		const tx = await createTransaction(db, s.scope, input(s), Date.now());
		if (!tx.ok) throw new Error('setup');
		const at = (await getTransaction(db, spaceId, tx.id))!.updatedAt;
		await remove();
		const create = await push(member, createItem(s));
		const edit = await push(member, {
			clientId: crypto.randomUUID(),
			spaceId,
			kind: 'transaction.update',
			targetId: tx.id,
			expectedUpdatedAt: at,
			payload: createForm(s, { amount: '1.000' })
		});
		expect([create.status, edit.status]).toEqual([404, 404]);
		expect(create.body).toMatchObject({ result: 'no-access' });
		expect(await countRows(spaceId)).toBe(1);
		expect((await getTransaction(db, spaceId, tx.id))?.amountMinor).toBe(2_500_000);
	});

	it('an item made in the shared space is applied there even after switching to the personal space', async () => {
		const { member, spaceId, s } = await sharedSpace();
		const personal = (await resolveCurrentSpace(db, member.user.id, undefined))!.id;
		const item = createItem(s);
		expect(await push(member, item, { currentSpace: personal })).toMatchObject({ status: 200 });
		expect(await getTransaction(db, spaceId, item.clientId)).not.toBeNull();
		expect(await getTransaction(db, personal, item.clientId)).toBeNull();
	});
});

describe('voice day across WIB month boundaries (checklist vectors)', () => {
	const at = (iso: string) => Date.parse(iso);
	const voice = (s: Setup, occurredOn: string): PushRequest => ({
		clientId: crypto.randomUUID(),
		spaceId: s.spaceId,
		kind: 'voice.save',
		occurredOn,
		payload: voiceForm(s, crypto.randomUUID()),
		accountId: s.p.user.id
	});
	const dayOf = async (s: Setup, clientKey: string) =>
		(
			await db.all<{ occurred_on: string }>(
				sql`select occurred_on from transactions where space_id = ${s.spaceId} and dedupe_key like ${clientKey + ':%'}`
			)
		)[0]?.occurred_on;

	it('made 23:30 WIB on 31 Oct, sent 00:30 WIB on 1 Nov: counts on 31 Oct', async () => {
		const s = await setup();
		const item = voice(s, '2026-10-31');
		const key = item.payload[0]![1];
		const r = await pushQueuedWrite(db, s.p.user.id, item, at('2026-10-31T17:30:00Z'), 'id');
		expect(r.status).toBe(200);
		expect(await dayOf(s, key)).toBe('2026-10-31');
	});

	it('a device dated 1 Nov while the server is still at 23:30 WIB on 31 Oct: counts on 31 Oct', async () => {
		const s = await setup();
		const item = voice(s, '2026-11-01');
		const key = item.payload[0]![1];
		await pushQueuedWrite(db, s.p.user.id, item, at('2026-10-31T16:30:00Z'), 'id');
		expect(await dayOf(s, key)).toBe('2026-10-31');
	});
});

describe('FN-36 recurring rows through the queue', () => {
	async function occurrence(s: Setup) {
		const { createSeries, runDueSeries } = await import('#lib/server/recurring/repo');
		const NOW = Date.parse('2026-10-12T03:00:00Z');
		const r = await createSeries(
			db,
			s.scope,
			{
				type: 'expense',
				amountMinor: 150_000_000,
				currency: 'IDR',
				walletId: s.bca,
				categoryId: s.kopi,
				title: 'Sewa kos',
				note: null,
				schedule: { frequency: 'monthly', day: 12 },
				startOn: '2026-10-01',
				endOn: null
			},
			'2026-10-12',
			NOW
		);
		if (!r.ok) throw new Error('series');
		expect((await runDueSeries(db, s.spaceId, '2026-10-12', NOW)).created).toBe(1);
		const [row] = await db.all<{ id: string; updated_at: number }>(
			sql`select id, updated_at from transactions where recurring_series_id = ${r.id}`
		);
		return { seriesId: r.id, id: row!.id, updatedAt: row!.updated_at };
	}

	it('a queued edit of a generated occurrence changes that row only and keeps its series link', async () => {
		const s = await setup();
		const o = await occurrence(s);
		const res = await push(s.p, {
			clientId: crypto.randomUUID(),
			spaceId: s.spaceId,
			kind: 'transaction.update',
			targetId: o.id,
			expectedUpdatedAt: o.updatedAt,
			payload: createForm(s, { amount: '1.400.000', title: 'Sewa kos', occurredOn: '2026-10-12' })
		});
		expect(res).toMatchObject({ status: 200, body: { result: 'ok' } });
		const [row] = await db.all<{ amount_minor: number; recurring_series_id: string | null }>(
			sql`select amount_minor, recurring_series_id from transactions where id = ${o.id}`
		);
		expect(row).toEqual({ amount_minor: 140_000_000, recurring_series_id: o.seriesId });
		const [series] = await db.all<{ amount_minor: number }>(
			sql`select amount_minor from recurring_transactions where id = ${o.seriesId}`
		);
		expect(series?.amount_minor).toBe(150_000_000);
	});

	it('a queued create never sets recurring_series_id, even when the payload names one', async () => {
		const s = await setup();
		const o = await occurrence(s);
		const item = createItem(s, {
			payload: [...createForm(s), ['recurringSeriesId', o.seriesId]]
		});
		expect((await push(s.p, item)).status).toBe(200);
		const [row] = await db.all<{ recurring_series_id: string | null }>(
			sql`select recurring_series_id from transactions where id = ${item.clientId}`
		);
		expect(row?.recurring_series_id).toBeNull();
	});
});

describe('cycle 2: red team L1 — the queuing account must be the session account', () => {
	it("an item queued by account A sent with B's session → 401 session, nothing written", async () => {
		const { member, owner, spaceId, s } = await sharedSpace();
		const item = createItem(s);
		const res = await push(member, { ...item, accountId: owner.user.id });
		expect(res).toMatchObject({ status: 401, body: { result: 'session' } });
		expect(await getTransaction(db, spaceId, item.clientId)).toBeNull();
	});
	it('a body without accountId is invalid (400)', async () => {
		const s = await setup();
		expect(await push(s.p, null, { raw: JSON.stringify(createItem(s)) })).toMatchObject({
			status: 400,
			body: { result: 'invalid' }
		});
	});
});

describe('cycle 2: red team L2 — voice day bounded like the online action', () => {
	const voiceAt = async (s: Setup, occurredOn: string, now = Date.now()) => {
		const key = crypto.randomUUID();
		const r = await pushQueuedWrite(
			db,
			s.p.user.id,
			{
				clientId: crypto.randomUUID(),
				spaceId: s.spaceId,
				kind: 'voice.save',
				occurredOn,
				payload: voiceForm(s, key),
				accountId: s.p.user.id
			},
			now,
			'id'
		);
		expect(r.status).toBe(200);
		const [row] = await db.all<{ occurred_on: string }>(
			sql`select occurred_on from transactions where dedupe_key = ${key + ':0'}`
		);
		return row?.occurred_on;
	};
	it('a backdated day (2000-01-01) counts on today (WIB), as the online action', async () => {
		const s = await setup();
		expect(await voiceAt(s, '2000-01-01')).toBe(wibTodayString());
	});
	it('8 days back is kept; 9 days back counts on today', async () => {
		const s = await setup();
		const today = wibTodayString();
		expect(await voiceAt(s, addDays(today, -8))).toBe(addDays(today, -8));
		expect(await voiceAt(s, addDays(today, -9))).toBe(today);
	});
});

describe('cycle 2: red team L4 — per-user rate limit', () => {
	it('past the window budget → 429 with Retry-After, nothing written', async () => {
		const s = await setup();
		const { SYNC_PUSH_MAX_PER_WINDOW } = await import('#lib/server/sync/push');
		const { sha256Hex } = await import('#lib/server/util');
		const { THROTTLE_WINDOW_MS } = await import('#lib/server/auth/throttle');
		const now = Date.now();
		await d1
			.prepare('insert into auth_attempts (client_hash, window_start, count) values (?, ?, ?)')
			.bind(
				await sha256Hex(`sync-push:user:${s.p.user.id}`),
				now - (now % THROTTLE_WINDOW_MS),
				SYNC_PUSH_MAX_PER_WINDOW
			)
			.run();
		const item = createItem(s);
		const { event } = fakeEvent({ url: 'http://localhost/api/v1/sync/push', db, user: s.p.user });
		Object.assign(event, {
			request: new Request('http://localhost/api/v1/sync/push', {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: 'http://localhost' },
				body: JSON.stringify({ ...item, accountId: s.p.user.id })
			})
		});
		const res = await route.POST(event as never);
		expect(res.status).toBe(429);
		const after = Number(res.headers.get('retry-after'));
		expect(after).toBeGreaterThan(0);
		expect(after).toBeLessThanOrEqual(THROTTLE_WINDOW_MS / 1000);
		expect(await getTransaction(db, s.spaceId, item.clientId)).toBeNull();
	});
	it('another user is not limited by the first one', async () => {
		const s = await setup();
		expect((await push(s.p, createItem(s))).status).toBe(200);
	});
});

describe('cycle 2: QA 1 — an edit that landed but whose answer was lost', () => {
	it('the identical resend is ok (already applied), not "changed meanwhile"', async () => {
		const s = await setup();
		const created = await createTransaction(db, s.scope, input(s), Date.now());
		if (!created.ok) throw new Error('setup');
		const loaded = (await getTransaction(db, s.spaceId, created.id))!.updatedAt;
		const edit: PushRequest = {
			clientId: crypto.randomUUID(),
			spaceId: s.spaceId,
			kind: 'transaction.update',
			targetId: created.id,
			expectedUpdatedAt: loaded,
			payload: createForm(s, { amount: '30.000', title: 'Kopi besar' })
		};
		expect(await push(s.p, edit)).toMatchObject({ status: 200, body: { result: 'ok' } });
		expect(await push(s.p, edit)).toMatchObject({ status: 200, body: { result: 'ok' } });
		// A different edit with the same stale updatedAt is still refused.
		expect(
			await push(s.p, {
				...edit,
				clientId: crypto.randomUUID(),
				payload: createForm(s, { amount: '31.000', title: 'Kopi besar' })
			})
		).toMatchObject({ status: 409, body: { result: 'stale' } });
		expect((await getTransaction(db, s.spaceId, created.id))?.amountMinor).toBe(3_000_000);
	});
});

describe('FN-47 red team L1: a queued amount is read in the language it was typed in', () => {
	async function usdSetup() {
		const s = await setup();
		const w = await createWallet(
			db,
			s.scope,
			{
				name: 'Wise USD',
				type: 'bank',
				currency: 'USD',
				openingBalanceMinor: 0,
				isFavourite: false,
				lastFour: null
			},
			Date.now()
		);
		if (!w.ok) throw new Error('wallet failed');
		return { ...s, usd: w.id };
	}

	it('en `12.50` USD queued, drained after a switch to Bahasa Indonesia: stored as 1250', async () => {
		const s = await usdSetup();
		const item = createItem(s, {
			payload: createForm(s, { walletId: s.usd, amount: '12.50' }),
			locale: 'en'
		});
		const r = await push(s.p, item, { locale: 'id' });
		expect(r).toEqual({ status: 200, body: { clientId: item.clientId, result: 'ok' } });
		const row = await getTransaction(db, s.spaceId, item.clientId);
		expect([row?.amountMinor, row?.currency]).toEqual([1250, 'USD']);
	});

	it('id `12,50` queued, drained under English: stored as 1250', async () => {
		const s = await usdSetup();
		const item = createItem(s, {
			payload: createForm(s, { walletId: s.usd, amount: '12,50' }),
			locale: 'id'
		});
		expect((await push(s.p, item, { locale: 'en' })).body.result).toBe('ok');
		expect((await getTransaction(db, s.spaceId, item.clientId))?.amountMinor).toBe(1250);
	});

	it('an edit keeps its queued language too', async () => {
		const s = await usdSetup();
		const created = await createTransaction(
			db,
			s.scope,
			input(s, { walletId: s.usd, currency: 'USD', amountMinor: 100 }),
			Date.now()
		);
		if (!created.ok) throw new Error('setup');
		const row = await getTransaction(db, s.spaceId, created.id);
		const item: PushRequest = {
			clientId: crypto.randomUUID(),
			spaceId: s.spaceId,
			kind: 'transaction.update',
			targetId: created.id,
			expectedUpdatedAt: row!.updatedAt,
			payload: createForm(s, { walletId: s.usd, amount: '1,234.56' }),
			locale: 'en'
		};
		expect((await push(s.p, item, { locale: 'id' })).body.result).toBe('ok');
		expect((await getTransaction(db, s.spaceId, created.id))?.amountMinor).toBe(123_456);
	});

	it('an item queued before FN-47 cycle 2 (no locale) is read with the session language and fails closed', async () => {
		const s = await usdSetup();
		const item = createItem(s, { payload: createForm(s, { walletId: s.usd, amount: '12.50' }) });
		const r = await push(s.p, item, { locale: 'id' });
		expect([r.status, r.body.result]).toEqual([400, 'invalid']);
		expect(await getTransaction(db, s.spaceId, item.clientId)).toBeNull();
		expect((await push(s.p, item, { locale: 'en' })).body.result).toBe('ok');
		expect((await getTransaction(db, s.spaceId, item.clientId))?.amountMinor).toBe(1250);
	});

	it('a locale outside id/en makes the item invalid, never read some other way', async () => {
		const s = await usdSetup();
		const item = {
			...createItem(s, { payload: createForm(s, { walletId: s.usd, amount: '12.50' }) }),
			locale: 'de'
		};
		expect(await push(s.p, item)).toEqual({
			status: 400,
			body: { clientId: null, result: 'invalid', message: expect.any(String) }
		});
	});
});
