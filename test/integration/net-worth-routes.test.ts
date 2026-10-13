import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import {
	NW_CHANGED,
	NW_LOAD_FAILED,
	NW_NOT_FOUND,
	NW_QUANTITY_PRECISION,
	NW_SYMBOL_UNKNOWN,
	NW_VALUE_REQUIRED
} from '#lib/server/net-worth/messages';
import { COLLECTIBLE_DEMO_READONLY } from '#lib/server/collectibles/messages';
import { KV_FX, KV_GOLD, KV_INDODAX } from '#lib/server/net-worth/prices';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { SPACE_COOKIE } from '#lib/server/spaces/access';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { fakeKv } from '../helpers/kv';

const binding: { DB?: D1Database; CACHE?: KVNamespace } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
// Lets one test make the net-worth read fail as if D1 were unavailable.
const failItems = { on: false };
vi.mock('#lib/server/net-worth/repo', async (original) => {
	const real = await original<typeof import('#lib/server/net-worth/repo')>();
	return {
		...real,
		listNetWorthItems: (...args: Parameters<typeof real.listNetWorthItems>) => {
			if (failItems.on) throw new Error('D1_ERROR: no such table');
			return real.listNetWorthItems(...args);
		}
	};
});

const page = await import('../../src/routes/(app)/kekayaan/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const ROUTE = '/(app)/kekayaan';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());
beforeEach(() => {
	binding.CACHE = fakeKv().kv;
});
afterEach(() => vi.restoreAllMocks());

type Action = (event: never) => unknown;
const act = (name: string) => (page.actions as Record<string, Action>)[name] as Action;

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail' as const,
				status: value.status,
				data: value.data as unknown as Record<string, unknown>
			};
		return { kind: 'ok' as const, value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

let n = 0;
async function person(name = 'Uji') {
	const email = `nw-route${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name, createdAt: 0 } };
}
type Person = Awaited<ReturnType<typeof person>>;

async function ev(
	who: Person | null,
	opts: { path?: string; form?: Record<string, string>; spaceCookie?: string } = {}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	return fakeEvent({
		url: `http://localhost${opts.path ?? '/kekayaan'}`,
		routeId: ROUTE,
		db,
		user: who?.user ?? null,
		space,
		form: opts.form,
		cookies: opts.spaceCookie ? { [SPACE_COOKIE]: opts.spaceCookie } : undefined
	}).event as never;
}
const load = async (who: Person | null, path = '/kekayaan', spaceCookie?: string) =>
	run(async () => page.load(await ev(who, { path, spaceCookie })));
const post = async (
	who: Person,
	name: string,
	form: Record<string, string>,
	spaceCookie?: string
) => run(async () => act(name)(await ev(who, { form, spaceCookie })));

interface NetWorthData {
	summary: {
		totalMinor: number | null;
		missingCount: number;
		items: {
			id: string;
			name: string;
			updatedAt: number;
			valueMinor: number | null;
			basis: string | null;
			stale: boolean;
		}[];
		classes: { cls: string; minor: number | null }[];
	} | null;
	change: unknown;
	error: string | null;
}
async function netWorthOf(who: Person, spaceCookie?: string) {
	const r = await load(who, '/kekayaan', spaceCookie);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.netWorth as NetWorthData;
}

const house = (over: Record<string, string> = {}) => ({
	kind: 'property',
	name: 'Rumah',
	currency: 'IDR',
	priceSource: 'manual',
	manualValue: '1.250.000.000',
	...over
});
const bitcoin = (over: Record<string, string> = {}) => ({
	kind: 'investment_crypto',
	name: 'Bitcoin',
	priceSource: 'indodax',
	symbol: 'BTC',
	quantity: '0,015',
	manualValue: '',
	...over
});

describe('/kekayaan net worth: load', () => {
	it('signed out → /masuk; a new space shows a zero total, no items and no change yet', async () => {
		expect(await load(null)).toMatchObject({ kind: 'redirect', location: '/masuk' });
		const p = await person();
		const nw = await netWorthOf(p);
		expect(nw).toMatchObject({
			summary: { totalMinor: 0, items: [], missingCount: 0 },
			change: null,
			error: null
		});
	});

	it('uses cached prices from KV; a KV outage falls back to manual values instead of failing the page', async () => {
		const p = await person();
		await post(p, 'createItem', bitcoin({ manualValue: '20.000.000' }));
		const kv = fakeKv();
		const now = Date.now();
		kv.store.set(
			KV_INDODAX,
			JSON.stringify({ v: 1, entries: { btc: { price: '1493387000', at: now } } })
		);
		binding.CACHE = kv.kv;
		let [item] = (await netWorthOf(p)).summary!.items;
		expect(item).toMatchObject({ valueMinor: 22_400_805_00, basis: 'price', stale: false });

		kv.state.failing = true;
		const nw = await netWorthOf(p);
		[item] = nw.summary!.items;
		expect(item).toMatchObject({ valueMinor: 20_000_000_00, basis: 'fallback' });
		expect(nw.summary?.totalMinor).toBe(20_000_000_00);
	});

	it('a hostile cached value is ignored, never shown as a price', async () => {
		const p = await person();
		await post(p, 'createItem', bitcoin());
		const kv = fakeKv();
		kv.store.set(
			KV_INDODAX,
			JSON.stringify({ v: 1, entries: { btc: { price: '-1e99', at: Date.now() } } })
		);
		kv.store.set(KV_GOLD, '{"v":1,"price":"<script>","at":0}');
		kv.store.set(KV_FX, 'null');
		binding.CACHE = kv.kv;
		const nw = await netWorthOf(p);
		expect(nw.summary?.items[0]).toMatchObject({ valueMinor: null, basis: null });
		expect(nw.summary?.missingCount).toBe(1);
	});

	it("a failing D1 read becomes the section's error state; the other sections still load", async () => {
		const p = await person();
		failItems.on = true;
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const r = await load(p);
			expect(r).toMatchObject({
				kind: 'ok',
				value: {
					netWorth: { summary: null, error: NW_LOAD_FAILED },
					belongings: { failed: false },
					collectibles: { failed: false }
				}
			});
			expect(err).toHaveBeenCalled();
		} finally {
			failItems.on = false;
		}
	});

	it('opens the add or edit form from the URL for the no-JavaScript path', async () => {
		const p = await person();
		expect(await load(p, '/kekayaan?aset=baru')).toMatchObject({ value: { openItem: 'baru' } });
	});
});

describe('/kekayaan net worth: actions', () => {
	it('create → survives a reload and counts; edit; stale edit refused; delete', async () => {
		const p = await person();
		expect(await post(p, 'createItem', house())).toEqual({
			kind: 'ok',
			value: { nwSaved: 'created' }
		});
		expect(
			await post(p, 'createItem', house({ kind: 'debt', name: 'KPR', manualValue: '250.000.000' }))
		).toMatchObject({ kind: 'ok' });
		let nw = await netWorthOf(p);
		expect(nw.summary?.totalMinor).toBe(1_000_000_000_00);
		const item = nw.summary!.items.find((i) => i.name === 'Rumah')!;

		expect(
			await post(p, 'updateItem', {
				...house({ name: 'Rumah Bekasi' }),
				itemId: item.id,
				updatedAt: String(item.updatedAt)
			})
		).toEqual({ kind: 'ok', value: { nwSaved: 'updated' } });
		expect(
			await post(p, 'updateItem', {
				...house({ name: 'Tab lama' }),
				itemId: item.id,
				updatedAt: String(item.updatedAt)
			})
		).toEqual({ kind: 'fail', status: 409, data: { nwError: NW_CHANGED } });
		nw = await netWorthOf(p);
		const fresh = nw.summary!.items.find((i) => i.id === item.id)!;
		expect(fresh.name).toBe('Rumah Bekasi');

		expect(
			await post(p, 'deleteItem', { itemId: fresh.id, updatedAt: String(fresh.updatedAt) })
		).toEqual({ kind: 'ok', value: { nwSaved: 'deleted' } });
		expect((await netWorthOf(p)).summary?.totalMinor).toBe(-250_000_000_00);
	});

	it('refuses invalid fields (echoing the form) and writes nothing', async () => {
		const p = await person();
		const r = await post(p, 'createItem', bitcoin({ quantity: '0.123456789' }));
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: {
				nwAction: 'create',
				nwErrors: { quantity: NW_QUANTITY_PRECISION },
				nwValues: { quantity: '0.123456789' }
			}
		});
		expect(await post(p, 'createItem', house({ manualValue: '' }))).toMatchObject({
			data: { nwErrors: { manualValue: NW_VALUE_REQUIRED } }
		});
		expect((await netWorthOf(p)).summary?.items).toEqual([]);
	});

	it('a coin code missing from the cached ticker is refused; with a cold cache it is accepted (red team M2)', async () => {
		const p = await person();
		const kv = fakeKv();
		kv.store.set(
			KV_INDODAX,
			JSON.stringify({ v: 1, entries: { btc: { price: '1493387000', at: Date.now() } } })
		);
		binding.CACHE = kv.kv;
		expect(await post(p, 'createItem', bitcoin({ symbol: 'A0001' }))).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { nwErrors: { symbol: NW_SYMBOL_UNKNOWN } }
		});
		expect(await post(p, 'createItem', bitcoin())).toMatchObject({ kind: 'ok' });
		binding.CACHE = fakeKv().kv;
		expect(await post(p, 'createItem', bitcoin({ symbol: 'A0001' }))).toMatchObject({ kind: 'ok' });
	});

	it('cross-space: a foreign id and an unknown id get the same 404; a non-member cookie falls back to the own space', async () => {
		const a = await person();
		const b = await person();
		await post(a, 'createItem', house());
		const item = (await netWorthOf(a)).summary!.items[0]!;
		const foreign = await post(b, 'updateItem', {
			...house({ name: 'Curian' }),
			itemId: item.id,
			updatedAt: String(item.updatedAt)
		});
		const unknown = await post(b, 'updateItem', {
			...house(),
			itemId: 'tidak-ada',
			updatedAt: '1'
		});
		expect(foreign).toEqual({ kind: 'fail', status: 404, data: { nwError: NW_NOT_FOUND } });
		expect(unknown).toEqual(foreign);
		expect(
			await post(b, 'deleteItem', { itemId: item.id, updatedAt: String(item.updatedAt) })
		).toEqual(foreign);
		// b naming a's personal space in the cookie still sees only b's own (empty) net worth.
		const aSpace = (await resolveCurrentSpace(db, a.user.id, undefined))!.id;
		expect((await netWorthOf(b, aSpace)).summary?.items).toEqual([]);
		expect((await netWorthOf(a)).summary?.items[0]?.name).toBe('Rumah');
	});

	it('a removed member of a shared space sees and writes nothing there any more', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		expect(await post(member, 'createItem', house(), spaceId)).toMatchObject({ kind: 'ok' });
		const item = (await netWorthOf(owner, spaceId)).summary!.items[0]!;
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		// The cookie no longer resolves to the shared space: the member is back in their personal space.
		expect((await netWorthOf(member, spaceId)).summary?.items).toEqual([]);
		expect(
			await post(
				member,
				'deleteItem',
				{ itemId: item.id, updatedAt: String(item.updatedAt) },
				spaceId
			)
		).toEqual({
			kind: 'fail',
			status: 404,
			data: { nwError: NW_NOT_FOUND }
		});
		expect((await netWorthOf(owner, spaceId)).summary?.items).toHaveLength(1);
	});

	it('a wallet balance past the safe range shows "too large" (null), never a rounded total', async () => {
		const p = await person();
		const spaceId = (await resolveCurrentSpace(db, p.user.id, undefined))!.id;
		await d1
			.prepare(
				`insert into wallets (id, space_id, name, type, currency, opening_balance_minor, created_at, updated_at, seq)
				values (?, ?, 'Besar', 'bank', 'IDR', ?, 1, 1, 1)`
			)
			.bind(crypto.randomUUID(), spaceId, Number.MAX_SAFE_INTEGER)
			.run();
		await post(p, 'createItem', house());
		const nw = await netWorthOf(p);
		expect(nw.summary?.totalMinor).toBeNull();
		expect(nw.change).toBeNull();
	});
});

describe('/kekayaan net worth: Data demo items (migration 0025)', () => {
	async function demoItem(spaceId: string) {
		const id = crypto.randomUUID();
		const now = Date.now();
		await d1
			.prepare(
				`insert into net_worth_items (id, space_id, kind, name, currency, price_source,
				manual_value_minor, is_demo, created_at, updated_at, seq)
				values (?, ?, 'vehicle', 'Motor demo', 'IDR', 'manual', 1500000000, 1, ?, ?, 1)`
			)
			.bind(id, spaceId, now, now)
			.run();
		return id;
	}
	const isDemoOf = async (id: string) =>
		(await d1.prepare('select is_demo from net_worth_items where id = ?').bind(id).first<{
			is_demo: number;
		}>())!.is_demo;

	it('a form-created item is real; a demo item is listed and badged but not in the total', async () => {
		const p = await person();
		const spaceId = (await resolveCurrentSpace(db, p.user.id, undefined))!.id;
		await post(p, 'createItem', house());
		const demoId = await demoItem(spaceId);
		const nw = await netWorthOf(p);
		const real = nw.summary!.items.find((i) => i.name === 'Rumah')!;
		expect(await isDemoOf(real.id)).toBe(0);
		expect(nw.summary?.totalMinor).toBe(1_250_000_000_00);
		expect(nw.summary?.classes).toEqual([{ cls: 'property', minor: 1_250_000_000_00 }]);
		expect(nw.summary?.items.find((i) => i.id === demoId)).toMatchObject({
			isDemo: true,
			valueMinor: 15_000_000_00
		});
	});

	it('edit and delete of a demo item are refused (same answer when stale); the row is unchanged', async () => {
		const p = await person();
		const spaceId = (await resolveCurrentSpace(db, p.user.id, undefined))!.id;
		const id = await demoItem(spaceId);
		const before = await d1.prepare('select * from net_worth_items where id = ?').bind(id).first();
		const updatedAt = String((before as { updated_at: number }).updated_at);
		const refusal = { kind: 'fail', status: 400, data: { nwError: COLLECTIBLE_DEMO_READONLY } };
		expect(await post(p, 'updateItem', { ...house(), itemId: id, updatedAt })).toEqual(refusal);
		expect(await post(p, 'deleteItem', { itemId: id, updatedAt })).toEqual(refusal);
		expect(await post(p, 'deleteItem', { itemId: id, updatedAt: '1' })).toEqual(refusal);
		expect(await d1.prepare('select * from net_worth_items where id = ?').bind(id).first()).toEqual(
			before
		);
	});
});

describe('FN-47: a manual item in TWD with cents', () => {
	it('stores 1.234,56 TWD as 123456; with no cached TWD rate it shows no value, never an error', async () => {
		const p = await person();
		expect(
			await post(
				p,
				'createItem',
				house({ name: 'Rekening TW', currency: 'TWD', manualValue: '1.234,56' })
			)
		).toEqual({ kind: 'ok', value: { nwSaved: 'created' } });
		const row = await d1
			.prepare('select currency, manual_value_minor from net_worth_items where name = ?')
			.bind('Rekening TW')
			.first<{ currency: string; manual_value_minor: number }>();
		expect(row).toEqual({ currency: 'TWD', manual_value_minor: 123_456 });
		const nw = await netWorthOf(p);
		expect(nw.error).toBeNull();
		expect(nw.summary?.items.find((i) => i.name === 'Rekening TW')).toBeDefined();
		expect(
			await post(p, 'createItem', house({ name: 'X', currency: 'TWD', manualValue: '1,23' }))
		).toMatchObject({ kind: 'ok' });
		expect(
			await post(p, 'createItem', house({ name: 'Y', currency: 'TWD', manualValue: '1,234' }))
		).toMatchObject({ kind: 'fail', status: 400 });
	});
});
