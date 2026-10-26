import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import {
	CATEGORY_LIST_MAX,
	createCategory,
	ensurePresetCategories,
	MAX_CATEGORIES_PER_SPACE,
	getCategory,
	listCategories,
	listCategoriesWithPresets,
	setCategoryHidden,
	updateCategory
} from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import type { SpaceScope } from '#lib/server/spaces/access';
import {
	listTransactionsByDay,
	periodTotals,
	type TransactionFilter
} from '#lib/server/transactions/aggregate';
import {
	createTransaction,
	deleteTransaction,
	getTransaction,
	updateTransaction
} from '#lib/server/transactions/repo';
import { MAX_AMOUNT_MINOR, type TransactionInput } from '#lib/server/transactions/validation';
import { walletTransactionsSums } from '#lib/server/transactions/wallet-sum';
import { purgeSpaces } from '#lib/server/spaces/spaces';
import { walletBalanceMinor } from '#lib/server/wallets/balance';
import { createWallet, getWallet } from '#lib/server/wallets/repo';
import { wibDateString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = 1_800_000_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

let n = 0;
async function account() {
	const email = `transaksi${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
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

async function wallet(
	scope: SpaceScope,
	name = 'BCA',
	currency: 'IDR' | 'USD' = 'IDR',
	opening = 0
) {
	const r = await createWallet(
		db,
		scope,
		{
			name,
			type: 'bank',
			currency,
			openingBalanceMinor: opening,
			isFavourite: false,
			lastFour: null
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

/** A space with presets, two IDR wallets and one USD wallet. */
async function ledger() {
	const who = await account();
	await ensurePresetCategories(db, who.scope.spaceId, NOW);
	const cats = await listCategories(db, who.scope.spaceId);
	const kopi = cats.find((c) => c.tileKey === 'kopi')!;
	const gaji = cats.find((c) => c.tileKey === 'gaji')!;
	const bca = await wallet(who.scope, 'BCA', 'IDR', 1_000_000);
	const gopay = await wallet(who.scope, 'GoPay');
	const usd = await wallet(who.scope, 'Wise', 'USD');
	return { ...who, kopi: kopi.id, gaji: gaji.id, bca, gopay, usd };
}
type Ledger = Awaited<ReturnType<typeof ledger>>;

function tx(l: Ledger, over: Partial<TransactionInput> = {}): TransactionInput {
	return {
		type: 'expense',
		amountMinor: 2_500_000,
		currency: 'IDR',
		walletId: l.bca,
		transferToWalletId: null,
		categoryId: l.kopi,
		title: 'Kopi susu',
		note: null,
		occurredOn: '2026-10-08',
		occurredTime: null,
		...over
	};
}

async function add(l: Ledger, over: Partial<TransactionInput> = {}, now = NOW) {
	const r = await createTransaction(db, l.scope, tx(l, over), now);
	if (!r.ok) throw new Error('create failed');
	return r.id;
}

const october = (over: Partial<TransactionFilter> = {}): TransactionFilter => ({
	from: '2026-10-01',
	to: '2026-10-31',
	type: null,
	categoryId: null,
	walletId: null,
	q: null,
	...over
});

async function allRows(spaceId: string, filter: TransactionFilter, limit = 50) {
	const rows = [];
	let cursor: string | null = null;
	for (let i = 0; i < 100; i++) {
		const page = await listTransactionsByDay(db, spaceId, filter, { cursor, limit });
		rows.push(...page.days.flatMap((d) => d.rows));
		cursor = page.nextCursor;
		if (!cursor) break;
	}
	return rows;
}

describe('ensurePresetCategories', () => {
	it('seeds the 24 presets once (17 expense, 7 income), with seq stamped', async () => {
		const { scope } = await account();
		await ensurePresetCategories(db, scope.spaceId, NOW);
		await ensurePresetCategories(db, scope.spaceId, NOW);
		const cats = await listCategories(db, scope.spaceId);
		expect(cats).toHaveLength(24);
		expect(cats.filter((c) => c.kind === 'expense')).toHaveLength(17);
		// FN-48 AC-14: the bank-statement presets, "Transfer" once per kind.
		for (const [tileKey, kind, name] of [
			['biaya-bank', 'expense', 'Biaya Bank'],
			['pajak', 'expense', 'Pajak'],
			['tarik-tunai', 'expense', 'Tarik Tunai'],
			['kartu-kredit', 'expense', 'Kartu Kredit'],
			['transfer', 'expense', 'Transfer keluar'],
			['transfer', 'income', 'Transfer masuk'],
			['bunga', 'income', 'Bunga']
		])
			expect(cats.filter((c) => c.tileKey === tileKey && c.kind === kind)).toEqual([
				expect.objectContaining({ name, isPreset: true, isHidden: false })
			]);
		for (const [tileKey, name] of [
			['ojek-online', 'Ojek Online'],
			['pesan-antar-makanan', 'Pesan Antar Makanan']
		])
			expect(cats.find((c) => c.tileKey === tileKey)).toMatchObject({
				name,
				kind: 'expense',
				isPreset: true,
				isHidden: false
			});
		// Right after "Transportasi" in a fresh space.
		expect(cats.slice(4, 7).map((c) => c.tileKey)).toEqual([
			'transportasi',
			'ojek-online',
			'pesan-antar-makanan'
		]);
		expect(cats.find((c) => c.tileKey === 'lain')).toMatchObject({
			name: 'Pemasukan Lain',
			kind: 'income',
			isPreset: true,
			isHidden: false
		});
		const seq = await d1
			.prepare('select min(seq) as s from categories where space_id = ?')
			.bind(scope.spaceId)
			.first<{ s: number }>();
		expect(seq!.s).toBeGreaterThan(0);
	});

	it('20 concurrent first loads of one space seed exactly 24 rows, never 48, never an error', async () => {
		const { scope } = await account();
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, () => ensurePresetCategories(db, scope.spaceId, NOW))
		);
		expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
		const count = await d1
			.prepare('select count(*) as n from categories where space_id = ?')
			.bind(scope.spaceId)
			.first<{ n: number }>();
		expect(count!.n).toBe(24);
	});
});

describe('ensurePresetCategories: FN-39 and FN-48 top-up of a space seeded with the first 15 presets', () => {
	const FN39 = ['ojek-online', 'pesan-antar-makanan'];
	const FN48 = ['biaya-bank', 'pajak', 'tarik-tunai', 'kartu-kredit', 'transfer', 'bunga'];
	/** Every later preset row's tile, sorted ("transfer" twice: expense and income). */
	const LATER = [...FN39, ...FN48, 'transfer'].sort();
	const tileList = (tiles: readonly string[]) => tiles.map((t) => `'${t}'`).join(', ');
	const spaceSeq = async (spaceId: string) =>
		(await d1.prepare('select seq from space_seq where space_id = ?').bind(spaceId).first<{
			seq: number;
		}>())!.seq;
	const rowsOf = (spaceId: string) =>
		d1
			.prepare(
				`select id, kind, name, tile_key, is_preset, is_hidden, sort_order, updated_at, seq from categories
				where space_id = ? order by id`
			)
			.bind(spaceId)
			.all<{ id: string; tile_key: string; is_preset: number; sort_order: number; seq: number }>()
			.then((r) => r.results);

	/** A space as seeded before FN-39: the 15 first presets (the nine later rows removed again). */
	async function oldSpace(removed: readonly string[] = [...FN39, ...FN48]) {
		const who = await account();
		await ensurePresetCategories(db, who.scope.spaceId, NOW);
		await d1
			.prepare(`delete from categories where space_id = ? and tile_key in (${tileList(removed)})`)
			.bind(who.scope.spaceId)
			.run();
		return who;
	}

	it('listCategoriesWithPresets seeds, tops up and lists exactly as ensurePresetCategories + listCategories', async () => {
		// A fresh space: seeded on the first read, the list already holds the 24 presets.
		const fresh = await account();
		const seeded = await listCategoriesWithPresets(db, fresh.scope.spaceId, {}, NOW);
		expect(seeded).toHaveLength(24);
		expect(seeded).toEqual(await listCategories(db, fresh.scope.spaceId));
		// An old space: the nine later presets are topped up and listed in the same call.
		const old = await oldSpace();
		const topped = await listCategoriesWithPresets(
			db,
			old.scope.spaceId,
			{ includeHidden: true },
			NOW + 1
		);
		expect(topped).toHaveLength(24);
		expect(topped).toEqual(await listCategories(db, old.scope.spaceId, { includeHidden: true }));
		// A complete space: nothing written (seq unchanged), the same list.
		const seq = await spaceSeq(old.scope.spaceId);
		expect(await listCategoriesWithPresets(db, old.scope.spaceId, {}, NOW + 2)).toEqual(
			await listCategories(db, old.scope.spaceId)
		);
		expect(await spaceSeq(old.scope.spaceId)).toBe(seq);
	});

	it('adds exactly the nine missing presets at the end, once, leaving every other row unchanged', async () => {
		const { scope } = await oldSpace();
		const custom = await createCategory(
			db,
			scope,
			{ kind: 'expense', name: 'Ojek Online', tileKey: 'transportasi' },
			NOW
		);
		expect(custom.ok).toBe(true);
		const before = await rowsOf(scope.spaceId);
		expect(before).toHaveLength(16);
		const seqBefore = await spaceSeq(scope.spaceId);

		await ensurePresetCategories(db, scope.spaceId, NOW + 1);
		const after = await rowsOf(scope.spaceId);
		expect(after).toHaveLength(25);
		for (const row of before) expect(after).toContainEqual(row);
		const added = after.filter((r) => !before.some((b) => b.id === r.id));
		expect(added.map((r) => r.tile_key).sort()).toEqual(LATER);
		const seqAfter = await spaceSeq(scope.spaceId);
		expect(seqAfter).toBe(seqBefore + 1);
		for (const r of added) {
			expect(r).toMatchObject({ is_preset: 1, is_hidden: 0, seq: seqAfter });
			expect(r.sort_order).toBeGreaterThan(Math.max(...before.map((b) => b.sort_order)));
		}
		// Listed as the last expense categories, in preset order (FN-39's first, then FN-48's).
		const expense = (await listCategories(db, scope.spaceId)).filter((c) => c.kind === 'expense');
		expect(expense.slice(-7).map((c) => [c.tileKey, c.isPreset])).toEqual([
			['ojek-online', true],
			['pesan-antar-makanan', true],
			['biaya-bank', true],
			['pajak', true],
			['tarik-tunai', true],
			['kartu-kredit', true],
			['transfer', true]
		]);
		const income = (await listCategories(db, scope.spaceId)).filter((c) => c.kind === 'income');
		expect(income.slice(-2).map((c) => c.tileKey)).toEqual(['bunga', 'transfer']);

		// A second call writes nothing, not even the change counter.
		await ensurePresetCategories(db, scope.spaceId, NOW + 2);
		expect(await rowsOf(scope.spaceId)).toEqual(after);
		expect(await spaceSeq(scope.spaceId)).toBe(seqAfter);
	});

	it('adds only the presets still missing', async () => {
		const { scope } = await oldSpace(['pesan-antar-makanan', ...FN48]);
		const ojek = (await rowsOf(scope.spaceId)).find((r) => r.tile_key === 'ojek-online')!;
		await ensurePresetCategories(db, scope.spaceId, NOW + 1);
		const after = await rowsOf(scope.spaceId);
		expect(after).toHaveLength(24);
		expect(after.filter((r) => r.tile_key === 'ojek-online')).toEqual([ojek]);
		expect(after.filter((r) => r.tile_key === 'pesan-antar-makanan')).toHaveLength(1);
	});

	it('FN-48 AC-15: a space with the 17 presets gets exactly the seven new ones; a retiled FN-39 preset stays gone', async () => {
		const { scope } = await oldSpace(FN48);
		const ojek = (await listCategories(db, scope.spaceId)).find(
			(c) => c.tileKey === 'ojek-online'
		)!;
		expect(
			await updateCategory(
				db,
				scope,
				ojek.id,
				{ name: 'Ojol', tileKey: 'transportasi' },
				ojek.updatedAt,
				NOW + 1
			)
		).toBe('ok');
		const before = await rowsOf(scope.spaceId);
		await ensurePresetCategories(db, scope.spaceId, NOW + 2);
		const after = await rowsOf(scope.spaceId);
		const added = after.filter((r) => !before.some((b) => b.id === r.id));
		expect(added.map((r) => r.tile_key).sort()).toEqual([...FN48, 'transfer'].sort());
		expect(after.filter((r) => r.tile_key === 'ojek-online')).toEqual([]);
		for (const row of before) expect(after).toContainEqual(row);
	});

	it('FN-48: "Transfer" is one preset per kind, so a missing income half is added on its own', async () => {
		const { scope } = await account();
		await ensurePresetCategories(db, scope.spaceId, NOW);
		await d1
			.prepare(
				`delete from categories where space_id = ? and tile_key = 'transfer' and kind = 'income'`
			)
			.bind(scope.spaceId)
			.run();
		await ensurePresetCategories(db, scope.spaceId, NOW + 1);
		const transfer = (await rowsOf(scope.spaceId)).filter((r) => r.tile_key === 'transfer');
		expect(transfer.map((r) => (r as unknown as { kind: string }).kind).sort()).toEqual([
			'expense',
			'income'
		]);
	});

	it('20 concurrent top-ups add exactly nine rows, never an error', async () => {
		const { scope } = await oldSpace();
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, () => ensurePresetCategories(db, scope.spaceId, NOW))
		);
		expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
		const tiles = (await rowsOf(scope.spaceId)).map((r) => r.tile_key);
		expect(tiles).toHaveLength(24);
		for (const t of [...FN39, ...FN48])
			expect(tiles.filter((x) => x === t)).toHaveLength(t === 'transfer' ? 2 : 1);
	});

	it('never recreates a topped-up preset the user renamed, hid or moved to another tile', async () => {
		const { scope } = await oldSpace();
		await ensurePresetCategories(db, scope.spaceId, NOW);
		const cats = await listCategories(db, scope.spaceId);
		const ojek = cats.find((c) => c.tileKey === 'ojek-online')!;
		const food = cats.find((c) => c.tileKey === 'pesan-antar-makanan')!;
		expect(
			await updateCategory(
				db,
				scope,
				ojek.id,
				{ name: 'Ojol', tileKey: 'transportasi' },
				ojek.updatedAt,
				NOW + 1
			)
		).toBe('ok');
		expect(await setCategoryHidden(db, scope, food.id, true, NOW + 1)).toBe('ok');
		const seq = await spaceSeq(scope.spaceId);
		await ensurePresetCategories(db, scope.spaceId, NOW + 2);
		expect(await rowsOf(scope.spaceId)).toHaveLength(24);
		expect(await spaceSeq(scope.spaceId)).toBe(seq);
	});

	it('is not gated by the creation cap: a full space still gets all nine, then creates nothing more', async () => {
		for (const custom of [MAX_CATEGORIES_PER_SPACE - 15 - 1, MAX_CATEGORIES_PER_SPACE - 15]) {
			const { scope } = await oldSpace();
			await d1
				.prepare(
					`with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
					insert into categories select lower(hex(randomblob(16))), ?, 'expense', 'Kustom ' || i, 'lain', 0, 0,
						100 + i, ?, ?, null, 1 from n`
				)
				.bind(custom, scope.spaceId, NOW, NOW)
				.run();
			await ensurePresetCategories(db, scope.spaceId, NOW + 1);
			const total = 15 + custom + 9;
			expect(await rowsOf(scope.spaceId)).toHaveLength(total);
			expect(await listCategories(db, scope.spaceId, { includeHidden: true })).toHaveLength(total);
			expect(total).toBeLessThanOrEqual(CATEGORY_LIST_MAX);
			expect(
				await createCategory(
					db,
					scope,
					{ kind: 'expense', name: 'Satu lagi', tileKey: 'lain' },
					NOW
				)
			).toEqual({ ok: false, reason: 'limit' });
		}
	});
});

describe('category writes', () => {
	it('renames and re-tiles in place; a stale form gets `stale`; hide/show is idempotent', async () => {
		const l = await ledger();
		const before = (await getCategory(db, l.scope.spaceId, l.kopi))!;
		expect(
			await updateCategory(
				db,
				l.scope,
				l.kopi,
				{ name: 'Ngopi', tileKey: 'makan' },
				before.updatedAt,
				NOW + 1
			)
		).toBe('ok');
		expect(
			await updateCategory(
				db,
				l.scope,
				l.kopi,
				{ name: 'Lagi', tileKey: 'kopi' },
				before.updatedAt,
				NOW + 2
			)
		).toBe('stale');
		expect(await getCategory(db, l.scope.spaceId, l.kopi)).toMatchObject({
			name: 'Ngopi',
			tileKey: 'makan'
		});
		expect(await setCategoryHidden(db, l.scope, l.kopi, true, NOW)).toBe('ok');
		expect(await setCategoryHidden(db, l.scope, l.kopi, true, NOW)).toBe('ok');
		expect((await listCategories(db, l.scope.spaceId)).some((c) => c.id === l.kopi)).toBe(false);
		expect(
			(await listCategories(db, l.scope.spaceId, { includeHidden: true })).some(
				(c) => c.id === l.kopi
			)
		).toBe(true);
		expect(await setCategoryHidden(db, l.scope, l.kopi, false, NOW)).toBe('ok');
		const deleted = await d1
			.prepare('select count(*) as n from categories where deleted_at is not null')
			.first<{ n: number }>();
		expect(deleted!.n).toBe(0);
	});

	it('creates a custom category; another space cannot touch it', async () => {
		const l = await ledger();
		const other = await account();
		const created = await createCategory(
			db,
			l.scope,
			{ name: 'Kucing', tileKey: 'hadiah', kind: 'expense' },
			NOW
		);
		expect(created.ok).toBe(true);
		const id = created.ok ? created.id : '';
		expect(await getCategory(db, l.scope.spaceId, id)).toMatchObject({
			isPreset: false,
			isHidden: false
		});
		expect(await getCategory(db, other.scope.spaceId, id)).toBeNull();
		const otherScope = { spaceId: l.scope.spaceId, userId: other.id };
		expect(await setCategoryHidden(db, otherScope, id, true, NOW)).toBe('missing');
		expect(await setCategoryHidden(db, other.scope, id, true, NOW)).toBe('missing');
		expect(
			await updateCategory(db, other.scope, id, { name: 'x', tileKey: 'kopi' }, NOW, NOW)
		).toBe('missing');
	});
});

describe('transactions: writes', () => {
	it('stores a positive magnitude, the wallet’s currency, source manual, no dedupe key', async () => {
		const l = await ledger();
		const id = await add(l);
		const row = await d1
			.prepare(
				'select amount_minor, currency, source, dedupe_key, occurred_at, seq from transactions where id = ?'
			)
			.bind(id)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			amount_minor: 2_500_000,
			currency: 'IDR',
			source: 'manual',
			dedupe_key: null,
			occurred_at: NOW
		});
		expect(row!.seq).toBeGreaterThan(0);
	});

	it('a missing time is the save instant; the WIB date stays the one the form showed (decision F)', async () => {
		const l = await ledger();
		// Saved at 2026-10-31 23:30 WIB for a transaction dated 1 Oct: bucketed on 1 Oct regardless.
		const savedAt = Date.UTC(2026, 9, 31, 16, 30);
		const id = await add(l, { occurredOn: '2026-10-01' }, savedAt);
		expect(await getTransaction(db, l.scope.spaceId, id)).toMatchObject({
			occurredOn: '2026-10-01',
			occurredAt: savedAt
		});
		const timed = await add(l, { occurredOn: '2026-10-31', occurredTime: '23:30' });
		expect((await getTransaction(db, l.scope.spaceId, timed))!.occurredAt).toBe(savedAt);
	});

	it('refuses (writes nothing) when the wallet or category is in another space', async () => {
		const l = await ledger();
		const other = await ledger();
		for (const over of [
			{ walletId: other.bca },
			{ categoryId: other.kopi },
			{ type: 'transfer' as const, categoryId: null, transferToWalletId: other.gopay }
		]) {
			expect(await createTransaction(db, l.scope, tx(l, over), NOW)).toEqual({
				ok: false,
				reason: 'gone'
			});
		}
		const count = await d1
			.prepare('select count(*) as n from transactions where space_id = ?')
			.bind(l.scope.spaceId)
			.first<{ n: number }>();
		expect(count!.n).toBe(0);
	});

	it('the schema itself refuses a negative amount, a same-wallet transfer and a category on a transfer', async () => {
		const l = await ledger();
		const insert = (type: string, amount: number, to: string | null, cat: string | null) =>
			d1
				.prepare(
					`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
						transfer_to_wallet_id, occurred_on, occurred_at, created_at, updated_at, seq)
					values (?, ?, ?, ?, 'IDR', ?, ?, ?, '2026-10-08', 0, 0, 0, 1)`
				)
				.bind(crypto.randomUUID(), l.scope.spaceId, type, amount, cat, l.bca, to)
				.run();
		await expect(insert('expense', -100, null, l.kopi)).rejects.toThrow(/CHECK/);
		await expect(insert('transfer', 100, l.bca, null)).rejects.toThrow(/CHECK/);
		await expect(insert('transfer', 100, l.gopay, l.kopi)).rejects.toThrow(/CHECK/);
		await expect(insert('expense', 100, l.gopay, l.kopi)).rejects.toThrow(/CHECK/);
	});

	it('the dedupe index makes a capture key idempotent per space and source (schema-ready)', async () => {
		const l = await ledger();
		const insert = () =>
			d1
				.prepare(
					`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
						occurred_on, occurred_at, source, dedupe_key, created_at, updated_at, seq)
					values (?, ?, 'expense', 100, 'IDR', ?, ?, '2026-10-08', 0, 'gmail', 'msg-1', 0, 0, 1)`
				)
				.bind(crypto.randomUUID(), l.scope.spaceId, l.kopi, l.bca)
				.run();
		await insert();
		await expect(insert()).rejects.toThrow(/UNIQUE/);
	});

	it('edit: guarded by updated_at; never touches source or dedupe_key', async () => {
		const l = await ledger();
		const id = await add(l);
		const loaded = (await getTransaction(db, l.scope.spaceId, id))!;
		expect(
			await updateTransaction(
				db,
				l.scope,
				id,
				tx(l, { amountMinor: 3_000_000 }),
				loaded.updatedAt,
				NOW + 5
			)
		).toBe('ok');
		// A second tab with the same stale updated_at.
		expect(
			await updateTransaction(db, l.scope, id, tx(l, { amountMinor: 9 }), loaded.updatedAt, NOW + 6)
		).toBe('stale');
		const after = (await getTransaction(db, l.scope.spaceId, id))!;
		expect(after).toMatchObject({ amountMinor: 3_000_000, source: 'manual', occurredAt: NOW });
		expect(after.updatedAt).toBeGreaterThan(loaded.updatedAt);
	});

	it('concurrent edit and delete of one row: exactly one wins, the other is refused', async () => {
		const l = await ledger();
		const id = await add(l);
		const { updatedAt } = (await getTransaction(db, l.scope.spaceId, id))!;
		const [edit, del] = await Promise.all([
			updateTransaction(db, l.scope, id, tx(l, { amountMinor: 1 }), updatedAt, NOW + 1),
			deleteTransaction(db, l.scope, id, updatedAt, NOW + 1)
		]);
		expect([edit, del].filter((r) => r === 'ok')).toHaveLength(1);
		expect([edit, del].filter((r) => r !== 'ok')[0]).toMatch(/stale|missing/);
	});

	it('delete: a content-free tombstone with a new seq, gone from every list and total', async () => {
		const l = await ledger();
		const id = await add(l, { note: 'rahasia' });
		const before = (await getTransaction(db, l.scope.spaceId, id))!;
		const seqBefore = (await d1
			.prepare('select seq from transactions where id = ?')
			.bind(id)
			.first<{ seq: number }>())!.seq;
		expect(await deleteTransaction(db, l.scope, id, before.updatedAt, NOW + 1)).toBe('ok');
		const row = await d1
			.prepare('select deleted_at, title, note, seq from transactions where id = ?')
			.bind(id)
			.first<{ deleted_at: number; title: null; note: null; seq: number }>();
		expect(row).toMatchObject({ deleted_at: NOW + 1, title: null, note: null });
		expect(row!.seq).toBeGreaterThan(seqBefore);
		expect(await getTransaction(db, l.scope.spaceId, id)).toBeNull();
		expect((await periodTotals(db, l.scope.spaceId, october())).count).toBe(0);
		expect((await walletTransactionsSums(db, l.scope.spaceId)).get(l.bca)).toBeUndefined();
		expect(await deleteTransaction(db, l.scope, id, before.updatedAt, NOW + 2)).toBe('missing');
	});

	it('20 concurrent creates against one wallet: 20 rows, 20 distinct seqs, the sum exact', async () => {
		const l = await ledger();
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createTransaction(db, l.scope, tx(l, { amountMinor: 100 * (i + 1) }), NOW)
			)
		);
		expect(results.every((r) => r.ok)).toBe(true);
		const rows = await d1
			.prepare(
				'select count(*) as n, count(distinct seq) as s from transactions where space_id = ?'
			)
			.bind(l.scope.spaceId)
			.first<{ n: number; s: number }>();
		expect(rows).toEqual({ n: 20, s: 20 });
		expect((await walletTransactionsSums(db, l.scope.spaceId)).get(l.bca)).toBe(-21_000);
	});

	it('a removed membership writes nothing (the write repeats the membership check)', async () => {
		const l = await ledger();
		const stranger = await account();
		const r = await createTransaction(
			db,
			{ spaceId: l.scope.spaceId, userId: stranger.id },
			tx(l),
			NOW
		);
		expect(r).toEqual({ ok: false, reason: 'gone' });
	});
});

describe('the totals contract (aggregate.ts)', () => {
	async function mixed() {
		const l = await ledger();
		await add(l, { amountMinor: 2_500_000, occurredOn: '2026-10-08', title: 'Kopi susu' });
		await add(l, {
			amountMinor: 500_000,
			occurredOn: '2026-10-08',
			walletId: l.gopay,
			note: 'Parkir mall'
		});
		await add(l, {
			type: 'income',
			categoryId: l.gaji,
			amountMinor: 950_000_000,
			occurredOn: '2026-10-01',
			title: 'Gaji Oktober'
		});
		await add(l, {
			type: 'transfer',
			categoryId: null,
			transferToWalletId: l.gopay,
			amountMinor: 10_000_000,
			occurredOn: '2026-10-05',
			title: null
		});
		await add(l, {
			walletId: l.usd,
			currency: 'USD',
			amountMinor: 1_250,
			occurredOn: '2026-10-09'
		});
		await add(l, { amountMinor: 7_700, occurredOn: '2026-09-30' });
		return l;
	}

	it('Beranda total = Riwayat total: periodTotals equals the sum of the listed rows, per currency', async () => {
		const l = await mixed();
		for (const filter of [
			october(),
			october({ type: 'expense' }),
			october({ type: 'income' }),
			october({ type: 'transfer' }),
			october({ walletId: l.gopay }),
			october({ categoryId: l.kopi }),
			october({ q: 'parkir' })
		]) {
			const totals = await periodTotals(db, l.scope.spaceId, filter);
			const rows = await allRows(l.scope.spaceId, filter, 2);
			expect(totals.count).toBe(rows.length);
			const manual = new Map<string, { inMinor: number; outMinor: number }>();
			for (const r of rows) {
				if (r.type === 'transfer') continue;
				const t = manual.get(r.currency) ?? { inMinor: 0, outMinor: 0 };
				if (r.type === 'income') t.inMinor += r.amountMinor;
				else t.outMinor += r.amountMinor;
				manual.set(r.currency, t);
			}
			expect(totals.totals).toEqual(
				[...manual]
					.map(([currency, t]) => ({ currency, ...t }))
					.sort((a, b) =>
						a.currency === 'IDR'
							? -1
							: b.currency === 'IDR'
								? 1
								: a.currency.localeCompare(b.currency)
					)
			);
		}
	});

	it('never sums across currencies; transfers count as rows but never as money in or out', async () => {
		const l = await mixed();
		const t = await periodTotals(db, l.scope.spaceId, october());
		expect(t).toEqual({
			count: 5,
			expenseCount: 3,
			incomeCount: 1,
			transferCount: 1,
			adjustmentCount: 0,
			totals: [
				{ currency: 'IDR', inMinor: 950_000_000, outMinor: 3_000_000 },
				{ currency: 'USD', inMinor: 0, outMinor: 1_250 }
			]
		});
		// Keluar/Masuk exclude transfers from the list entirely.
		const expenses = await allRows(l.scope.spaceId, october({ type: 'expense' }));
		expect(expenses.every((r) => r.type === 'expense')).toBe(true);
		const all = await allRows(l.scope.spaceId, october());
		expect(all.some((r) => r.type === 'transfer')).toBe(true);
		// The Transfer chip (APP_PARITY § 3): only transfers, counted, never money in or out.
		const transfers = await allRows(l.scope.spaceId, october({ type: 'transfer' }));
		expect(transfers.map((r) => r.type)).toEqual(['transfer']);
		expect(await periodTotals(db, l.scope.spaceId, october({ type: 'transfer' }))).toEqual({
			count: 1,
			expenseCount: 0,
			incomeCount: 0,
			transferCount: 1,
			adjustmentCount: 0,
			totals: []
		});
	});

	it('groups by WIB day with whole-day totals, newest first, and pages without repeats or gaps', async () => {
		const l = await mixed();
		const first = await listTransactionsByDay(db, l.scope.spaceId, october(), { limit: 2 });
		expect(first.days.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-08']);
		// Only one of the two 8 Oct rows is on this page, but the header carries the whole day.
		expect(first.days[1]!.rows).toHaveLength(1);
		expect(first.days[1]!.totals).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: 3_000_000 }]);
		const second = await listTransactionsByDay(db, l.scope.spaceId, october(), {
			limit: 2,
			cursor: first.nextCursor
		});
		expect(second.days[0]!.date).toBe('2026-10-08');
		const ids = (await allRows(l.scope.spaceId, october(), 1)).map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toHaveLength(5);
		const transferDay = (await listTransactionsByDay(db, l.scope.spaceId, october())).days.find(
			(d) => d.date === '2026-10-05'
		)!;
		expect(transferDay.totals).toEqual([]);
		expect(transferDay.rows[0]).toMatchObject({
			type: 'transfer',
			category: null,
			wallet: { name: 'BCA' },
			toWallet: { name: 'GoPay' }
		});
	});

	it('WIB month boundaries: 23:30 WIB on the 31st is October, 00:30 WIB on the 1st is November', async () => {
		const l = await ledger();
		const lastDay = Date.UTC(2026, 9, 31, 16, 30);
		const firstDay = Date.UTC(2026, 9, 31, 17, 30); // still 31 Oct in UTC
		await add(l, { occurredOn: wibDateString(lastDay), occurredTime: '23:30', amountMinor: 111 });
		await add(l, { occurredOn: wibDateString(firstDay), occurredTime: '00:30', amountMinor: 222 });
		const oct = await periodTotals(db, l.scope.spaceId, october());
		const nov = await periodTotals(
			db,
			l.scope.spaceId,
			october({ from: '2026-11-01', to: '2026-11-30' })
		);
		expect(oct.totals).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: 111 }]);
		expect(nov.totals).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: 222 }]);
		const novPage = await listTransactionsByDay(
			db,
			l.scope.spaceId,
			october({ from: '2026-11-01', to: '2026-11-30' })
		);
		expect(novPage.days.map((d) => d.date)).toEqual(['2026-11-01']);
	});

	it('search uses instr(): a 60+ character term runs (LIKE would hit D1’s 50-byte pattern cap)', async () => {
		const l = await ledger();
		const long = 'Pembayaran tagihan listrik PLN bulan Oktober untuk rumah di Bandung'; // 67 chars
		expect(long.length).toBeGreaterThan(60);
		await add(l, { title: long });
		await add(l, { title: 'Kopi' });
		const hit = await periodTotals(db, l.scope.spaceId, october({ q: long.toUpperCase() }));
		expect(hit.count).toBe(1);
		const page = await listTransactionsByDay(db, l.scope.spaceId, october({ q: long }));
		expect(page.days.flatMap((d) => d.rows).map((r) => r.title)).toEqual([long]);
		// Characters LIKE treats as wildcards are plain text here.
		expect((await periodTotals(db, l.scope.spaceId, october({ q: '%' }))).count).toBe(0);
	});

	it('pages through more than 101 distinct days and ids without any parameter limit', async () => {
		const l = await ledger();
		const stmts = Array.from({ length: 130 }, (_, i) => {
			const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
			return d1
				.prepare(
					`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
						occurred_on, occurred_at, created_at, updated_at, seq)
					values (?, ?, 'expense', 100, 'IDR', ?, ?, ?, 0, 0, 0, 1)`
				)
				.bind(crypto.randomUUID(), l.scope.spaceId, l.kopi, l.bca, day);
		});
		await d1.batch(stmts);
		const filter = october({ from: '2026-01-01', to: '2026-12-31' });
		const rows = await allRows(l.scope.spaceId, filter, 50);
		expect(rows).toHaveLength(130);
		expect((await periodTotals(db, l.scope.spaceId, filter)).totals[0]!.outMinor).toBe(13_000);
	});

	it('refuses an unbounded period (a programming error, never a table scan)', async () => {
		const l = await ledger();
		await expect(
			periodTotals(db, l.scope.spaceId, october({ from: '2020-01-01', to: '2026-12-31' }))
		).rejects.toThrow(RangeError);
		await expect(periodTotals(db, l.scope.spaceId, october({ from: 'x' }))).rejects.toThrow(
			RangeError
		);
	});

	it('only ever reads the given space', async () => {
		const l = await mixed();
		const other = await ledger();
		expect((await periodTotals(db, other.scope.spaceId, october())).count).toBe(0);
		expect((await periodTotals(db, other.scope.spaceId, october({ walletId: l.bca }))).count).toBe(
			0
		);
		expect((await listTransactionsByDay(db, other.scope.spaceId, october())).days).toEqual([]);
	});
});

describe('walletTransactionsSums (the FN-04 balance seam)', () => {
	it('= Σincome − Σexpense − Σtransfer out + Σtransfer in, per wallet, in one query', async () => {
		const l = await ledger();
		await add(l, { amountMinor: 30_000 });
		await add(l, { type: 'income', categoryId: l.gaji, amountMinor: 500_000 });
		await add(l, {
			type: 'transfer',
			categoryId: null,
			transferToWalletId: l.gopay,
			amountMinor: 100_000
		});
		await add(l, { walletId: l.gopay, amountMinor: 20_000 });
		await add(l, { walletId: l.usd, currency: 'USD', amountMinor: 999 });
		const sums = await walletTransactionsSums(db, l.scope.spaceId);
		expect(sums.get(l.bca)).toBe(500_000 - 30_000 - 100_000);
		expect(sums.get(l.gopay)).toBe(100_000 - 20_000);
		expect(sums.get(l.usd)).toBe(-999);
		const bca = (await getWallet(db, l.scope.spaceId, l.bca))!;
		expect(walletBalanceMinor(bca, sums.get(bca.id) ?? 0)).toBe(1_000_000 + 370_000);
	});
});

describe('account deletion', () => {
	it('deletes a personal space with categories and transactions (no foreign-key error)', async () => {
		const l = await ledger();
		await add(l);
		await add(l, { type: 'transfer', categoryId: null, transferToWalletId: l.gopay });
		const proof = await signInWithPassword(db, l.email, PASSWORD, NOW);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, l.id, proof.hash, NOW)).toBe(true);
		for (const table of ['transactions', 'categories', 'wallets']) {
			const r = await d1
				.prepare(`select count(*) as n from ${table} where space_id = ?`)
				.bind(l.scope.spaceId)
				.first<{ n: number }>();
			expect(r!.n).toBe(0);
		}
	});
});

describe('space deletion (purgeSpaces)', () => {
	it('removes the space’s transactions and categories (before its wallets) and nothing of another space', async () => {
		const l = await ledger();
		const other = await ledger();
		await add(l);
		await add(l, { type: 'transfer', categoryId: null, transferToWalletId: l.gopay });
		await add(other);
		await db.batch(purgeSpaces(db, sql`select ${l.scope.spaceId}`, () => sql`1`) as never);
		const count = async (table: string, spaceId: string) =>
			(await d1
				.prepare(`select count(*) as n from ${table} where space_id = ?`)
				.bind(spaceId)
				.first<{ n: number }>())!.n;
		for (const table of ['transactions', 'categories', 'wallets']) {
			expect(await count(table, l.scope.spaceId)).toBe(0);
			expect(await count(table, other.scope.spaceId)).toBeGreaterThan(0);
		}
	});
});

describe('red-team cycle 3', () => {
	/** `count` live expense rows of `amountMinor` on `walletId`, in one statement (bypasses the form cap). */
	async function bulk(l: Ledger, count: number, amountMinor: number, walletId = l.bca) {
		await d1
			.prepare(
				`with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					occurred_on, occurred_at, created_at, updated_at, seq)
				select lower(hex(randomblob(16))), ?, 'expense', ?, 'IDR', ?, ?, '2026-10-08', 0, 0, 0, 1 from n`
			)
			.bind(count, l.scope.spaceId, amountMinor, l.kopi, walletId)
			.run();
	}

	it('M1: totals past 2^53 degrade to null instead of throwing; the list still loads', async () => {
		const l = await ledger();
		await bulk(l, 1000, 10_000_000_000_000); // 10^16 in total, far past 2^53
		const totals = await periodTotals(db, l.scope.spaceId, october());
		expect(totals.count).toBe(1000);
		expect(totals.totals).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: null }]);
		const page = await listTransactionsByDay(db, l.scope.spaceId, october());
		expect(page.days[0]!.rows).toHaveLength(50);
		expect(page.days[0]!.totals).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: null }]);
		expect((await walletTransactionsSums(db, l.scope.spaceId)).get(l.bca)).toBeNull();
	});

	it('M1(b)/L2: at most 100.000 live transactions per space (guarded insert)', async () => {
		const l = await ledger();
		await bulk(l, 100_000, 100);
		expect(await createTransaction(db, l.scope, tx(l), NOW)).toEqual({
			ok: false,
			reason: 'limit'
		});
		const other = await ledger();
		expect((await createTransaction(db, other.scope, tx(other), NOW)).ok).toBe(true);
	});

	it('M2: a deleted transaction keeps no content, and its dedupe key still blocks a re-capture', async () => {
		const l = await ledger();
		const id = await add(l, { note: 'rahasia' });
		await d1
			.prepare(`update transactions set source = 'gmail', dedupe_key = 'msg-42' where id = ?`)
			.bind(id)
			.run();
		const { updatedAt } = (await getTransaction(db, l.scope.spaceId, id))!;
		expect(await deleteTransaction(db, l.scope, id, updatedAt, NOW + 1)).toBe('ok');
		const row = await d1
			.prepare(
				`select amount_minor, currency, wallet_id, transfer_to_wallet_id, category_id, occurred_on,
					occurred_at, title, note, source, dedupe_key, deleted_at from transactions where id = ?`
			)
			.bind(id)
			.first<Record<string, unknown>>();
		expect(row).toEqual({
			amount_minor: null,
			currency: null,
			wallet_id: null,
			transfer_to_wallet_id: null,
			category_id: null,
			occurred_on: null,
			occurred_at: null,
			title: null,
			note: null,
			source: 'gmail',
			dedupe_key: 'msg-42',
			deleted_at: NOW + 1
		});
		await expect(
			d1
				.prepare(
					`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
						occurred_on, occurred_at, source, dedupe_key, created_at, updated_at, seq)
					values (?, ?, 'expense', 100, 'IDR', ?, ?, '2026-10-08', 0, 'gmail', 'msg-42', 0, 0, 1)`
				)
				.bind(crypto.randomUUID(), l.scope.spaceId, l.kopi, l.bca)
				.run()
		).rejects.toThrow(/UNIQUE/);
		// A tombstone that regains content is refused by the schema.
		await expect(
			d1.prepare('update transactions set amount_minor = 5 where id = ?').bind(id).run()
		).rejects.toThrow(/CHECK/);
		expect((await periodTotals(db, l.scope.spaceId, october())).count).toBe(0);
		expect(await walletTransactionsSums(db, l.scope.spaceId)).toEqual(new Map());
	});

	it('L1: an archived wallet cannot receive a new row, even when archived after the form check', async () => {
		const l = await ledger();
		const id = await add(l);
		await d1.prepare('update wallets set deleted_at = 1 where id = ?').bind(l.bca).run();
		expect(await createTransaction(db, l.scope, tx(l), NOW)).toEqual({ ok: false, reason: 'gone' });
		expect(
			await createTransaction(
				db,
				l.scope,
				tx(l, { walletId: l.gopay, type: 'transfer', categoryId: null, transferToWalletId: l.bca }),
				NOW
			)
		).toEqual({ ok: false, reason: 'gone' });
		// The row that already uses the archived wallet can still be edited…
		const { updatedAt } = (await getTransaction(db, l.scope.spaceId, id))!;
		expect(
			await updateTransaction(db, l.scope, id, tx(l, { title: 'Masih' }), updatedAt, NOW + 1)
		).toBe('ok');
		// …but another row cannot be moved onto it.
		const other = await add(l, { walletId: l.gopay });
		const o = (await getTransaction(db, l.scope.spaceId, other))!;
		expect(await updateTransaction(db, l.scope, other, tx(l), o.updatedAt, NOW + 1)).toBe('stale');
	});
});

describe('L3 (red team): the per-amount cap lives in the schema too', () => {
	it('refuses a direct insert above 10^13 minor units, accepts exactly 10^13', async () => {
		const l = await ledger();
		const insert = (amount: number) =>
			d1
				.prepare(
					`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
						occurred_on, occurred_at, created_at, updated_at, seq)
					values (?, ?, 'expense', ?, 'IDR', ?, ?, '2026-10-08', 0, 0, 0, 1)`
				)
				.bind(crypto.randomUUID(), l.scope.spaceId, amount, l.kopi, l.bca)
				.run();
		expect(MAX_AMOUNT_MINOR).toBe(10_000_000_000_000); // the form cap and the CHECK agree
		await insert(10_000_000_000_000);
		await expect(insert(10_000_000_000_001)).rejects.toThrow(/CHECK/);
		// The repo path (no form) is refused by the same constraint.
		await expect(
			createTransaction(db, l.scope, tx(l, { amountMinor: 10_000_000_000_001 }), NOW)
		).rejects.toThrow();
	});
});
