import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import { countStatements, D1_STATEMENTS_PER_INVOCATION } from '#lib/server/db/statement-count';
import { emptyPriceBook, KV_INDODAX, readPriceBook } from '#lib/server/net-worth/prices';
import {
	createNetWorthItem,
	deleteNetWorthItem,
	listNetWorthItems,
	MAX_ITEMS_PER_SPACE,
	pricingDemand,
	updateNetWorthItem
} from '#lib/server/net-worth/repo';
import {
	netWorthChange,
	netWorthSummary,
	spacesDueForSnapshot,
	upsertSnapshot,
	writeSnapshots
} from '#lib/server/net-worth/summary';
import type { NetWorthInput } from '#lib/server/net-worth/validation';
import type { SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { createWallet } from '#lib/server/wallets/repo';
import { runNetWorthTick } from '../../workers/jobs/src/net-worth';
import { openLocalD1 } from '../helpers/d1';
import { fakeKv, json, stubFetch } from '../helpers/kv';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
/** 2026-10-08 10:00 WIB. */
const NOW = Date.UTC(2026, 9, 8, 3, 0);
const DAY = 24 * 60 * 60 * 1000;

/** One cron tick's snapshots at `now`, within the whole per-invocation D1 cap, counted as the jobs Worker does. */
async function snapshotTick(now: number) {
	const counted = countStatements(d1);
	return writeSnapshots(
		getDb(counted.d1),
		emptyPriceBook(),
		now,
		() => D1_STATEMENTS_PER_INVOCATION - counted.statements()
	);
}

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());
beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function account(name = 'Uji') {
	const email = `kekayaan-bersih${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = await d1
		.prepare('select space_id as id from space_members where user_id = ?')
		.bind(r.userId)
		.first<{ id: string }>();
	const scope: SpaceScope = { spaceId: personal!.id, userId: r.userId };
	return { id: r.userId, email, scope };
}

const manual = (over: Partial<NetWorthInput> = {}): NetWorthInput => ({
	kind: 'property',
	name: 'Rumah',
	currency: 'IDR',
	priceSource: 'manual',
	priceSymbol: null,
	quantityScaled: null,
	quantityScale: null,
	manualValueMinor: 500_000_000_00,
	acquiredOn: '2020-01-15',
	note: 'Sertifikat di lemari',
	...over
});
const btc = (over: Partial<NetWorthInput> = {}): NetWorthInput =>
	manual({
		kind: 'investment_crypto',
		name: 'Bitcoin',
		priceSource: 'indodax',
		priceSymbol: 'btc',
		quantityScaled: '1500000',
		quantityScale: 8,
		manualValueMinor: null,
		...over
	});

async function add(scope: SpaceScope, input: NetWorthInput = manual(), at = NOW) {
	const r = await createNetWorthItem(db, scope, input, at);
	if (!r.ok) throw new Error(`create failed: ${r.reason}`);
	return r.id;
}
async function wallet(
	scope: SpaceScope,
	openingBalanceMinor: number,
	currency: 'IDR' | 'USD' | 'GBP' = 'IDR'
) {
	const r = await createWallet(
		db,
		scope,
		{
			name: 'BCA',
			type: 'bank',
			currency,
			openingBalanceMinor,
			isFavourite: false,
			lastFour: null
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}
const rowsOf = async (table: string, spaceId: string) =>
	(await d1
		.prepare(`select count(*) as n from ${table} where space_id = ?`)
		.bind(spaceId)
		.first<{ n: number }>())!.n;

async function sharedSpace() {
	const owner = await account('Pemilik');
	const member = await account('Anggota');
	const spaceId = (await createSharedSpace(db, owner.id, 'Keluarga', NOW))!;
	const invite = (await createInvite(db, { spaceId, userId: owner.id, replaces: '' }, NOW))!;
	await acceptInvite(db, invite.token, member.id, NOW);
	return { owner, member, spaceId };
}

describe('net-worth items (repo)', () => {
	it('creates, lists, edits and deletes with a content-free tombstone', async () => {
		const p = await account();
		const id = await add(p.scope);
		let [item] = await listNetWorthItems(db, p.scope.spaceId);
		expect(item).toMatchObject({
			id,
			name: 'Rumah',
			manualValueMinor: 500_000_000_00,
			updatedAt: NOW
		});

		expect(
			await updateNetWorthItem(db, p.scope, id, manual({ name: 'Rumah Bekasi' }), NOW, NOW + 1)
		).toBe('ok');
		// A second tab still holding the old updated_at is refused, not applied.
		expect(await updateNetWorthItem(db, p.scope, id, manual({ name: 'Basi' }), NOW, NOW + 2)).toBe(
			'stale'
		);
		[item] = await listNetWorthItems(db, p.scope.spaceId);
		expect(item?.name).toBe('Rumah Bekasi');

		expect(await deleteNetWorthItem(db, p.scope, id, item!.updatedAt, NOW + 3)).toBe('ok');
		expect(await listNetWorthItems(db, p.scope.spaceId)).toEqual([]);
		const row = await d1.prepare('select * from net_worth_items where id = ?').bind(id).first();
		expect(row).toMatchObject({
			kind: null,
			name: null,
			currency: null,
			price_source: null,
			quantity_scaled: null,
			manual_value_minor: null,
			acquired_on: null,
			note: null,
			created_at: null
		});
		expect(row?.deleted_at).toBe(NOW + 3);
		// Gone: a delete or edit of the tombstone answers missing (no restore of content-free rows).
		expect(await deleteNetWorthItem(db, p.scope, id, NOW + 3, NOW + 4)).toBe('missing');
	});

	it('the DB refuses a value over 10^13, a bad coin code, a quantity on the wrong kind and a half tombstone', async () => {
		const p = await account();
		const insert = (cols: string, values: unknown[]) =>
			d1
				.prepare(
					`insert into net_worth_items (id, space_id, ${cols}, updated_at, seq) values (?, ?, ${cols
						.split(',')
						.map(() => '?')
						.join(', ')}, 1, 1)`
				)
				.bind(crypto.randomUUID(), p.scope.spaceId, ...values)
				.run();
		const base = 'kind, name, currency, price_source, manual_value_minor, created_at';
		await expect(
			insert(base, ['cash', 'X', 'IDR', 'manual', 10_000_000_000_000, 1])
		).resolves.toBeTruthy();
		await expect(
			insert(base, ['cash', 'X', 'IDR', 'manual', 10_000_000_000_001, 1])
		).rejects.toThrow();
		await expect(insert(base, ['cash', 'X', 'IDR', 'manual', 0, 1])).rejects.toThrow();
		await expect(
			insert(`${base}, price_symbol, quantity_scaled, quantity_scale`, [
				'investment_crypto',
				'X',
				'IDR',
				'indodax',
				null,
				1,
				'BTC/IDR',
				'1',
				8
			])
		).rejects.toThrow();
		await expect(
			insert(`${base}, quantity_scaled, quantity_scale`, [
				'cash',
				'X',
				'IDR',
				'manual',
				1,
				1,
				'100',
				8
			])
		).rejects.toThrow();
		await expect(
			insert(`${base}, price_symbol, quantity_scaled, quantity_scale`, [
				'investment_crypto',
				'X',
				'USD',
				'indodax',
				null,
				1,
				'btc',
				'1',
				8
			])
		).rejects.toThrow();
		await expect(insert('name, deleted_at', ['sisa', 5])).rejects.toThrow();
	});

	it(`holds the ${MAX_ITEMS_PER_SPACE}-item cap exactly under 20 concurrent creates; deleted items do not count`, async () => {
		const p = await account();
		const statements = Array.from({ length: MAX_ITEMS_PER_SPACE - 10 }, (_, i) =>
			d1
				.prepare(
					`insert into net_worth_items (id, space_id, kind, name, currency, price_source, manual_value_minor, created_at, updated_at, seq)
				values (?, ?, 'cash', ?, 'IDR', 'manual', 100, ?, ?, 1)`
				)
				.bind(crypto.randomUUID(), p.scope.spaceId, `K${i}`, NOW, NOW)
		);
		await d1.batch(statements);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createNetWorthItem(db, p.scope, manual({ name: `C${i}` }), NOW)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(10);
		expect(results.filter((r) => !r.ok && r.reason === 'limit')).toHaveLength(10);
		const live = await d1
			.prepare(
				'select count(*) as n from net_worth_items where space_id = ? and deleted_at is null'
			)
			.bind(p.scope.spaceId)
			.first<{ n: number }>();
		expect(live?.n).toBe(MAX_ITEMS_PER_SPACE);
		const first = results.find((r) => r.ok) as { ok: true; id: string };
		expect(await deleteNetWorthItem(db, p.scope, first.id, NOW, NOW + 1)).toBe('ok');
		expect((await createNetWorthItem(db, p.scope, manual(), NOW + 2)).ok).toBe(true);
	});

	it("cross-space: another space's id and an unknown id get the same answer; a removed member writes nothing", async () => {
		const a = await account();
		const b = await account();
		const id = await add(a.scope);
		for (const target of [id, 'tidak-ada'])
			for (const result of [
				await updateNetWorthItem(db, b.scope, target, manual({ name: 'Curian' }), NOW, NOW + 1),
				await deleteNetWorthItem(db, b.scope, target, NOW, NOW + 1)
			])
				expect(result).toBe('missing');
		// b writing with a's space id but b's user id is refused by the membership check in the statement.
		expect(
			await createNetWorthItem(db, { spaceId: a.scope.spaceId, userId: b.id }, manual(), NOW)
		).toEqual({ ok: false, reason: 'gone' });
		expect(
			await updateNetWorthItem(
				db,
				{ spaceId: a.scope.spaceId, userId: b.id },
				id,
				manual(),
				NOW,
				NOW + 1
			)
		).toBe('stale');
		expect((await listNetWorthItems(db, a.scope.spaceId))[0]?.name).toBe('Rumah');

		const s = await sharedSpace();
		const memberScope = { spaceId: s.spaceId, userId: s.member.id };
		const shared = await add(memberScope);
		const m = (await listMembers(db, s.spaceId, s.owner.id)).find((x) => !x.isYou)!;
		await removeMember(db, { spaceId: s.spaceId, actorUserId: s.owner.id, memberId: m.id }, NOW);
		expect(await deleteNetWorthItem(db, memberScope, shared, NOW, NOW + 1)).toBe('stale');
		expect(await createNetWorthItem(db, memberScope, manual(), NOW)).toEqual({
			ok: false,
			reason: 'gone'
		});
	});

	it("account deletion purges a personal space's items and snapshots; a shared space keeps them", async () => {
		const p = await account();
		await add(p.scope);
		await upsertSnapshot(db, p.scope.spaceId, '2026-10-08', 100, NOW);
		const s = await sharedSpace();
		await add({ spaceId: s.spaceId, userId: s.member.id });
		await upsertSnapshot(db, s.spaceId, '2026-10-08', 100, NOW);
		for (const who of [p, s.member]) {
			const proof = await signInWithPassword(db, who.email, PASSWORD, NOW);
			if (!proof.ok) throw new Error('sign-in failed');
			expect(await deleteAccount(db, who.id, proof.hash, NOW)).toBe(true);
		}
		expect(await rowsOf('net_worth_items', p.scope.spaceId)).toBe(0);
		expect(await rowsOf('net_worth_snapshots', p.scope.spaceId)).toBe(0);
		expect(await rowsOf('net_worth_items', s.spaceId)).toBe(1);
		expect(await rowsOf('net_worth_snapshots', s.spaceId)).toBe(1);
	});

	it('pricingDemand lists coins, gold and foreign currencies in use (live rows of live spaces only)', async () => {
		const p = await account();
		await add(p.scope, btc({ priceSymbol: 'zzcoin' }));
		await add(
			p.scope,
			manual({
				kind: 'investment_gold',
				priceSource: 'gold_api',
				quantityScaled: '1000',
				quantityScale: 3,
				manualValueMinor: null
			})
		);
		await add(p.scope, manual({ kind: 'cash', currency: 'SGD', manualValueMinor: 100_00 }));
		const gone = await add(p.scope, btc({ priceSymbol: 'deadcoin' }));
		await deleteNetWorthItem(db, p.scope, gone, NOW, NOW + 1);
		await wallet(p.scope, 5_00, 'USD');
		const demand = await pricingDemand(db);
		expect(demand.crypto).toBe(true);
		expect(demand.gold).toBe(true);
		expect(demand.currencies).toEqual(expect.arrayContaining(['SGD', 'USD']));
		expect(demand.currencies).not.toContain('IDR');
	});

	it('pricingDemand ignores wallets and items of deleted spaces (red team L3)', async () => {
		const p = await account();
		await wallet(p.scope, 5_00, 'GBP');
		await add(p.scope, manual({ kind: 'cash', currency: 'AUD', manualValueMinor: 100_00 }));
		expect((await pricingDemand(db)).currencies).toEqual(expect.arrayContaining(['AUD', 'GBP']));
		await d1
			.prepare('update spaces set deleted_at = ? where id = ?')
			.bind(NOW, p.scope.spaceId)
			.run();
		const demand = await pricingDemand(db);
		expect(demand.currencies).not.toContain('GBP');
		expect(demand.currencies).not.toContain('AUD');
	});
});

describe('net-worth summary, snapshots and the 30-day change', () => {
	it('total = wallet balances + items − debts, read back from D1', async () => {
		const p = await account();
		await wallet(p.scope, 10_000_000_00);
		await add(p.scope);
		await add(p.scope, manual({ kind: 'debt', name: 'KPR', manualValueMinor: 300_000_000_00 }));
		await add(p.scope, btc());
		const s = await netWorthSummary(db, p.scope.spaceId, emptyPriceBook(), NOW);
		expect(s.totalMinor).toBe(10_000_000_00 + 500_000_000_00 - 300_000_000_00);
		expect(s.missingCount).toBe(1);
	});

	it('FN-58 pass 1: an e-money card counts like any e-wallet and carries its issuer', async () => {
		const p = await account();
		await wallet(p.scope, 1_000_000_00);
		const card = await createWallet(
			db,
			p.scope,
			{
				name: 'KMT',
				type: 'e_wallet',
				currency: 'IDR',
				openingBalanceMinor: 75_000_00,
				isFavourite: false,
				lastFour: '5678',
				emoneyIssuer: 'kmt'
			},
			NOW
		);
		if (!card.ok) throw new Error('card failed');
		const s = await netWorthSummary(db, p.scope.spaceId, emptyPriceBook(), NOW);
		expect(s.totalMinor).toBe(1_000_000_00 + 75_000_00);
		expect(s.wallets.find((w) => w.id === card.id)).toMatchObject({
			type: 'e_wallet',
			emoneyIssuer: 'kmt',
			balanceMinor: 75_000_00
		});
	});

	it('the change compares with the snapshot of exactly 30 WIB days ago, else an older one, else the oldest', async () => {
		const p = await account();
		const id = p.scope.spaceId;
		expect(await netWorthChange(db, id, 1_000, NOW)).toBeNull();
		await upsertSnapshot(db, id, '2026-10-08', 900, NOW);
		// Only today's snapshot: no earlier figure to compare with.
		expect(await netWorthChange(db, id, 1_000, NOW)).toBeNull();
		await upsertSnapshot(db, id, '2026-10-01', 400, NOW);
		await upsertSnapshot(db, id, '2026-09-20', 300, NOW);
		expect(await netWorthChange(db, id, 1_000, NOW)).toEqual({
			kind: 'since_start',
			fromDate: '2026-09-20',
			deltaMinor: 700
		});
		await upsertSnapshot(db, id, '2026-09-01', 100, NOW);
		expect(await netWorthChange(db, id, 1_000, NOW)).toEqual({
			kind: 'since',
			fromDate: '2026-09-01',
			deltaMinor: 900
		});
		await upsertSnapshot(db, id, '2026-09-08', 4_200_000, NOW);
		expect(await netWorthChange(db, id, 1_000, NOW)).toEqual({
			kind: 'days30',
			fromDate: '2026-09-08',
			deltaMinor: 1_000 - 4_200_000
		});
		expect(await netWorthChange(db, id, null, NOW)).toBeNull();
	});

	it('30 days is counted in WIB: at 06:30 WIB on 8 Oct (23:30 UTC on 7 Oct) the base is 8 Sep', async () => {
		const p = await account();
		await upsertSnapshot(db, p.scope.spaceId, '2026-09-08', 100, NOW);
		await upsertSnapshot(db, p.scope.spaceId, '2026-09-07', 50, NOW);
		const early = Date.UTC(2026, 9, 7, 23, 30);
		expect(await netWorthChange(db, p.scope.spaceId, 300, early)).toMatchObject({
			kind: 'days30',
			fromDate: '2026-09-08',
			deltaMinor: 200
		});
	});

	it('the cron writes the snapshot under the WIB date: 23:00 WIB → that day, 06:00 WIB → the next', async () => {
		const p = await account();
		await add(p.scope, manual({ manualValueMinor: 1_000_00 }));
		const lateTick = Date.UTC(2026, 9, 8, 16, 0); // 23:00 WIB, 8 Oct
		const earlyTick = Date.UTC(2026, 9, 8, 23, 0); // 06:00 WIB, 9 Oct
		await snapshotTick(lateTick);
		await add(p.scope, manual({ name: 'Motor', kind: 'vehicle', manualValueMinor: 500_00 }));
		await snapshotTick(earlyTick);
		const rows = await d1
			.prepare(
				'select date, total_minor as t from net_worth_snapshots where space_id = ? order by date'
			)
			.bind(p.scope.spaceId)
			.all<{ date: string; t: number }>();
		expect(rows.results).toEqual([
			{ date: '2026-10-08', t: 1_000_00 },
			{ date: '2026-10-09', t: 1_500_00 }
		]);
	});

	it('a later tick on the same WIB day overwrites that day; a fresh snapshot is not due again within 30 minutes', async () => {
		const p = await account();
		const item = await add(p.scope, manual({ manualValueMinor: 1_000_00 }));
		await snapshotTick(NOW);
		expect(await spacesDueForSnapshot(db, '2026-10-08', NOW + 60_000)).not.toContain(
			p.scope.spaceId
		);
		await updateNetWorthItem(
			db,
			p.scope,
			item,
			manual({ manualValueMinor: 2_000_00 }),
			NOW,
			NOW + 1
		);
		const nextHour = NOW + 60 * 60 * 1000;
		expect(await spacesDueForSnapshot(db, '2026-10-08', nextHour)).toContain(p.scope.spaceId);
		await snapshotTick(nextHour);
		const row = await d1
			.prepare(
				'select total_minor as t, updated_at as u from net_worth_snapshots where space_id = ? and date = ?'
			)
			.bind(p.scope.spaceId, '2026-10-08')
			.first<{ t: number; u: number }>();
		expect(row).toEqual({ t: 2_000_00, u: nextHour });
	});
});

describe('jobs cron tick (stubbed providers, fake KV)', () => {
	const TICKER_ALL = 'https://indodax.com/api/ticker_all';
	const GOLD = 'https://api.gold-api.com/price/XAU';
	const FX_USD = 'https://api.frankfurter.dev/v2/rate/USD/IDR';

	it('prices the coins in use, then snapshots with those prices; provider down keeps the last good price', async () => {
		const p = await account();
		await add(p.scope, btc({ priceSymbol: 'tickcoin', quantityScaled: '200000000' }));
		const { kv, store } = fakeKv();
		const up = stubFetch({
			[TICKER_ALL]: () => json({ tickers: { tickcoin_idr: { last: '1000' } } }),
			[GOLD]: () => json({ symbol: 'XAU', currency: 'USD', price: 4105.3 }),
			[FX_USD]: () => json({ date: '2026-10-07', base: 'USD', quote: 'IDR', rate: 17881 })
		});
		await runNetWorthTick(db, kv, up.fetch, NOW, () => 0);
		expect(up.calls[0]).toBe(TICKER_ALL);
		const snap = await d1
			.prepare('select total_minor as t from net_worth_snapshots where space_id = ?')
			.bind(p.scope.spaceId)
			.first<{ t: number }>();
		expect(snap?.t).toBe(2_000_00);

		const before = store.get(KV_INDODAX);
		const down = stubFetch({
			[TICKER_ALL]: () => new Response('down', { status: 503 }),
			[GOLD]: () => new Response('down', { status: 503 }),
			[FX_USD]: () => new Response('down', { status: 503 })
		});
		const later = NOW + 9 * 60 * 60 * 1000;
		await runNetWorthTick(db, kv, down.fetch, later, () => 0);
		expect(store.get(KV_INDODAX)).toBe(before);
		const s = await netWorthSummary(db, p.scope.spaceId, await readPriceBook(kv, later), later);
		const item = s.items.find((i) => i.priceSymbol === 'tickcoin');
		expect(item).toMatchObject({ valueMinor: 2_000_00, basis: 'price', priceAt: NOW, stale: true });

		// After PRICE_MAX_AGE_MS without a success the price is no longer used: no value (no manual fallback set).
		const s2 = await netWorthSummary(
			db,
			p.scope.spaceId,
			await readPriceBook(kv, NOW + 4 * DAY),
			NOW + 4 * DAY
		);
		expect(s2.items.find((i) => i.priceSymbol === 'tickcoin')).toMatchObject({
			valueMinor: null,
			basis: null
		});
	});

	it('never throws, even when D1 fails', async () => {
		const { kv } = fakeKv();
		const broken = { all: () => Promise.reject(new Error('D1_ERROR')) } as unknown as Db;
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(
			runNetWorthTick(broken, kv, stubFetch({}).fetch, NOW, () => 0)
		).resolves.toBeUndefined();
		expect(err).toHaveBeenCalled();
	});
});

describe('snapshot fairness and partial days (red team M1, L2)', () => {
	it('105 more spaces (and a too-large one) all get a snapshot within ceil(105/100) + 1 hourly ticks', async () => {
		const ids = Array.from({ length: 105 }, () => crypto.randomUUID());
		const big = crypto.randomUUID();
		const stmts = [...ids, big].flatMap((id, i) => [
			d1
				.prepare(
					`insert into spaces (id, kind, name, created_at, updated_at) values (?, 'personal', 'P', 1, 1)`
				)
				.bind(id),
			d1
				.prepare(
					`insert into net_worth_items (id, space_id, kind, name, currency, price_source, manual_value_minor, created_at, updated_at, seq)
					values (?, ?, 'cash', 'K', 'IDR', 'manual', ?, 1, 1, 1)`
				)
				.bind(crypto.randomUUID(), id, 100 + i)
		]);
		stmts.push(
			d1
				.prepare(
					`insert into wallets (id, space_id, name, type, currency, opening_balance_minor, created_at, updated_at, seq)
					values (?, ?, 'Besar', 'bank', 'IDR', ?, 1, 1, 1)`
				)
				.bind(crypto.randomUUID(), big, Number.MAX_SAFE_INTEGER)
		);
		await d1.batch(stmts);
		const base = Date.UTC(2026, 9, 9, 2, 0); // 09:00 WIB, 9 Oct
		const ticks = Math.ceil(105 / 100) + 1;
		for (let t = 0; t < ticks; t++) await snapshotTick(base + t * 3_600_000);
		const done = await d1
			.prepare(
				`select count(*) as n from net_worth_snapshots where date = '2026-10-09'
				and space_id in (select value from json_each(?))`
			)
			.bind(JSON.stringify(ids))
			.first<{ n: number }>();
		expect(done?.n).toBe(105);
		// The too-large space is skipped (never written), and did not hold a slot.
		expect(await rowsOf('net_worth_snapshots', big)).toBe(0);
	});

	it('a day with a missing price is stored as partial, never replaces a complete figure, and is not compared with', async () => {
		const p = await account();
		await add(p.scope, manual({ manualValueMinor: 1_000_00 }));
		await upsertSnapshot(db, p.scope.spaceId, '2026-09-08', 500_00, NOW);
		await upsertSnapshot(db, p.scope.spaceId, '2026-09-07', 900_00, NOW, true);
		// Complete then partial on the same day: the complete figure stays.
		await upsertSnapshot(db, p.scope.spaceId, '2026-09-08', 1, NOW + 1, true);
		const row = await d1
			.prepare(
				`select total_minor as t, partial from net_worth_snapshots where space_id = ? and date = '2026-09-08'`
			)
			.bind(p.scope.spaceId)
			.first<{ t: number; partial: number }>();
		expect(row).toEqual({ t: 500_00, partial: 0 });
		expect(await netWorthChange(db, p.scope.spaceId, 1_000_00, NOW)).toEqual({
			kind: 'days30',
			fromDate: '2026-09-08',
			deltaMinor: 500_00
		});
		// Only a partial snapshot left on and before the base: it is not used.
		const q = await account();
		await upsertSnapshot(db, q.scope.spaceId, '2026-09-08', 1, NOW, true);
		expect(await netWorthChange(db, q.scope.spaceId, 1_000_00, NOW)).toBeNull();
		// The cron marks a day partial when an item has no price.
		await add(q.scope, btc());
		// (Over 100 spaces are due in this file by now: a few ticks in a row cover them all.)
		for (let t = 0; t < 3; t++) await snapshotTick(Date.UTC(2026, 9, 10, 3, t));
		const today = await d1
			.prepare(`select partial from net_worth_snapshots where space_id = ? and date = '2026-10-10'`)
			.bind(q.scope.spaceId)
			.first<{ partial: number }>();
		expect(today?.partial).toBe(1);

		// A priced item on its manual fallback (price aged out or never fetched) also makes the day partial.
		const r = await account();
		await add(r.scope, btc({ manualValueMinor: 20_000_000_00 }));
		for (let t = 0; t < 3; t++) await snapshotTick(Date.UTC(2026, 9, 11, 3, t));
		const fallback = await d1
			.prepare(
				`select partial, total_minor as t from net_worth_snapshots where space_id = ? and date = '2026-10-11'`
			)
			.bind(r.scope.spaceId)
			.first<{ partial: number; t: number }>();
		expect(fallback).toEqual({ partial: 1, t: 20_000_000_00 });
	});
});
