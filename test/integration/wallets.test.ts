import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '#lib/server/db/schema';
import {
	createSharedSpace,
	listMembers,
	purgeSpaces,
	removeMember,
	SPACE_SCOPED_TABLES
} from '#lib/server/spaces/spaces';
import {
	archiveWallet,
	createWallet,
	getWallet,
	listWallets,
	MAX_WALLETS_PER_SPACE,
	restoreWallet,
	setFavourite,
	updateWallet,
	type WalletScope
} from '#lib/server/wallets/repo';
import type { WalletInput } from '#lib/server/wallets/validation';
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
async function account(name = 'Uji') {
	const email = `dompet${++n}@contoh.id`;
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
	const scope: WalletScope = { spaceId: personal!.id, userId: r.userId };
	return { id: r.userId, email, scope };
}

const input = (over: Partial<WalletInput> = {}): WalletInput => ({
	name: 'BCA',
	type: 'bank',
	currency: 'IDR',
	openingBalanceMinor: 2_500_000,
	isFavourite: false,
	lastFour: '1234',
	...over
});

async function add(scope: WalletScope, over: Partial<WalletInput> = {}, at = NOW) {
	const r = await createWallet(db, scope, input(over), at);
	if (!r.ok) throw new Error(`create failed: ${r.reason}`);
	return r.id;
}

const raw = (id: string) =>
	d1.prepare('select * from wallets where id = ?').bind(id).first<{
		seq: number;
		is_favourite: number;
		deleted_at: number | null;
		updated_at: number;
		space_id: string;
		opening_balance_minor: number;
	}>();
const favourites = async (spaceId: string) =>
	(await d1
		.prepare(
			'select count(*) as n from wallets where space_id = ? and deleted_at is null and is_favourite = 1'
		)
		.bind(spaceId)
		.first<{ n: number }>())!.n;

describe('createWallet', () => {
	it('stores integer minor units in the scope’s space; the first wallet is the favourite, the second not', async () => {
		const { scope } = await account();
		const first = await add(scope, { name: 'Dompet', type: 'tunai', lastFour: null });
		const second = await add(scope, { openingBalanceMinor: -150_000_00 });
		const a = await getWallet(db, scope.spaceId, first);
		const b = await getWallet(db, scope.spaceId, second);
		expect(a).toMatchObject({ isFavourite: true, type: 'tunai', lastFour: null, archived: false });
		expect(b).toMatchObject({ isFavourite: false, openingBalanceMinor: -15_000_000 });
		expect((await raw(second))?.space_id).toBe(scope.spaceId);
		expect(Number.isInteger((await raw(second))?.opening_balance_minor)).toBe(true);
	});

	it('a later wallet created as favourite takes the flag over in the same batch', async () => {
		const { scope } = await account();
		const first = await add(scope);
		const second = await add(scope, { isFavourite: true });
		expect((await getWallet(db, scope.spaceId, first))?.isFavourite).toBe(false);
		expect((await getWallet(db, scope.spaceId, second))?.isFavourite).toBe(true);
		expect(await favourites(scope.spaceId)).toBe(1);
	});

	it('assigns a per-space seq that only grows', async () => {
		const { scope } = await account();
		const a = await add(scope);
		const b = await add(scope);
		expect((await raw(b))!.seq).toBeGreaterThan((await raw(a))!.seq);
	});

	it('refuses past the per-space cap, even when the last creates race', async () => {
		const { scope } = await account();
		for (let i = 0; i < MAX_WALLETS_PER_SPACE - 3; i++) await add(scope, { name: `D${i}` });
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) => createWallet(db, scope, input({ name: `R${i}` }), NOW))
		);
		expect(results.filter((r) => r.ok)).toHaveLength(3);
		expect(results.filter((r) => !r.ok && r.reason === 'limit')).toHaveLength(7);
		expect(await listWallets(db, scope.spaceId, { includeArchived: true })).toHaveLength(
			MAX_WALLETS_PER_SPACE
		);
	});

	it('only one of many concurrent first wallets becomes the favourite', async () => {
		const { scope } = await account();
		await Promise.all(Array.from({ length: 10 }, () => createWallet(db, scope, input(), NOW)));
		expect(await favourites(scope.spaceId)).toBe(1);
	});
});

describe('listWallets', () => {
	it('lists live wallets favourite first then oldest first; archived only on request, after the live ones', async () => {
		const { scope } = await account();
		const a = await add(scope, { name: 'A' }, NOW);
		const b = await add(scope, { name: 'B' }, NOW + 1);
		const c = await add(scope, { name: 'C', isFavourite: true }, NOW + 2);
		const bRow = (await getWallet(db, scope.spaceId, b))!;
		expect(await archiveWallet(db, scope, b, bRow.updatedAt, NOW + 3)).toBe('ok');
		expect((await listWallets(db, scope.spaceId)).map((w) => w.id)).toEqual([c, a]);
		const all = await listWallets(db, scope.spaceId, { includeArchived: true });
		expect(all.map((w) => [w.id, w.archived])).toEqual([
			[c, false],
			[a, false],
			[b, true]
		]);
	});

	it('never returns another space’s wallets', async () => {
		const one = await account();
		const two = await account();
		const id = await add(one.scope);
		expect(await listWallets(db, two.scope.spaceId, { includeArchived: true })).toEqual([]);
		expect(await getWallet(db, two.scope.spaceId, id, { includeArchived: true })).toBeNull();
	});
});

describe('updateWallet', () => {
	it('saves with the loaded updated_at, advances it and seq; a second stale save is refused', async () => {
		const { scope } = await account();
		const id = await add(scope);
		const loaded = (await getWallet(db, scope.spaceId, id))!;
		const seqBefore = (await raw(id))!.seq;
		// Same millisecond as the create: updated_at still moves forward.
		expect(
			await updateWallet(db, scope, id, input({ name: 'Tab satu' }), loaded.updatedAt, NOW)
		).toBe('ok');
		expect(
			await updateWallet(db, scope, id, input({ name: 'Tab dua' }), loaded.updatedAt, NOW)
		).toBe('stale');
		const after = (await getWallet(db, scope.spaceId, id))!;
		expect(after.name).toBe('Tab satu');
		expect(after.updatedAt).toBeGreaterThan(loaded.updatedAt);
		expect((await raw(id))!.seq).toBeGreaterThan(seqBefore);
	});

	it('answers missing for an unknown id and for another space’s wallet alike, writing nothing', async () => {
		const one = await account();
		const two = await account();
		const id = await add(one.scope);
		const row = (await getWallet(db, one.scope.spaceId, id))!;
		expect(await updateWallet(db, two.scope, id, input({ name: 'X' }), row.updatedAt, NOW)).toBe(
			'missing'
		);
		expect(
			await updateWallet(db, two.scope, crypto.randomUUID(), input(), row.updatedAt, NOW)
		).toBe('missing');
		expect((await getWallet(db, one.scope.spaceId, id))!.name).toBe('BCA');
	});

	it('ticking favourite moves it; unticking it on the favourite keeps exactly one', async () => {
		const { scope } = await account();
		const a = await add(scope);
		const b = await add(scope);
		const bRow = (await getWallet(db, scope.spaceId, b))!;
		expect(
			await updateWallet(db, scope, b, input({ isFavourite: true }), bRow.updatedAt, NOW + 5)
		).toBe('ok');
		expect((await getWallet(db, scope.spaceId, a))!.isFavourite).toBe(false);
		const bNow = (await getWallet(db, scope.spaceId, b))!;
		expect(bNow.isFavourite).toBe(true);
		expect(await updateWallet(db, scope, b, input(), bNow.updatedAt, NOW + 6)).toBe('ok');
		expect(await favourites(scope.spaceId)).toBe(1);
		expect((await getWallet(db, scope.spaceId, b))!.isFavourite).toBe(true);
	});

	it('a stale edit that ticks favourite moves nothing', async () => {
		const { scope } = await account();
		const a = await add(scope);
		const b = await add(scope);
		const bRow = (await getWallet(db, scope.spaceId, b))!;
		await updateWallet(db, scope, b, input({ name: 'Baru' }), bRow.updatedAt, NOW + 1);
		expect(
			await updateWallet(db, scope, b, input({ isFavourite: true }), bRow.updatedAt, NOW + 2)
		).toBe('stale');
		expect((await getWallet(db, scope.spaceId, a))!.isFavourite).toBe(true);
	});
});

describe('archive and restore', () => {
	it('archiving the favourite passes it to the oldest live wallet, or to none when none is left', async () => {
		const { scope } = await account();
		const a = await add(scope, {}, NOW);
		const b = await add(scope, {}, NOW + 1);
		const c = await add(scope, {}, NOW + 2);
		const aRow = (await getWallet(db, scope.spaceId, a))!;
		const seqBefore = (await raw(a))!.seq;
		expect(await archiveWallet(db, scope, a, aRow.updatedAt, NOW + 3)).toBe('ok');
		const archived = (await raw(a))!;
		expect(archived.deleted_at).toBe(NOW + 3);
		expect(archived.is_favourite).toBe(0);
		expect(archived.seq).toBeGreaterThan(seqBefore);
		expect((await getWallet(db, scope.spaceId, b))!.isFavourite).toBe(true);
		for (const id of [b, c]) {
			const row = (await getWallet(db, scope.spaceId, id))!;
			expect(await archiveWallet(db, scope, id, row.updatedAt, NOW + 4)).toBe('ok');
		}
		expect(await favourites(scope.spaceId)).toBe(0);
		expect(await listWallets(db, scope.spaceId)).toEqual([]);
	});

	it('restores an archived wallet with a new seq; it is the favourite only when there is none', async () => {
		const { scope } = await account();
		const a = await add(scope);
		const aRow = (await getWallet(db, scope.spaceId, a))!;
		await archiveWallet(db, scope, a, aRow.updatedAt, NOW + 1);
		const archived = (await getWallet(db, scope.spaceId, a, { includeArchived: true }))!;
		const seqBefore = (await raw(a))!.seq;
		expect(await restoreWallet(db, scope, a, archived.updatedAt, NOW + 2)).toBe('ok');
		const back = (await getWallet(db, scope.spaceId, a))!;
		expect(back).toMatchObject({ archived: false, isFavourite: true });
		expect((await raw(a))!.seq).toBeGreaterThan(seqBefore);
		expect(await restoreWallet(db, scope, a, archived.updatedAt, NOW + 3)).toBe('stale');
	});

	it('a second tab archiving the same wallet gets stale; another space gets missing', async () => {
		const { scope } = await account();
		const other = await account();
		const a = await add(scope);
		const row = (await getWallet(db, scope.spaceId, a))!;
		expect(await archiveWallet(db, other.scope, a, row.updatedAt, NOW + 1)).toBe('missing');
		expect(await archiveWallet(db, scope, a, row.updatedAt, NOW + 1)).toBe('ok');
		expect(await archiveWallet(db, scope, a, row.updatedAt, NOW + 2)).toBe('stale');
	});
});

describe('setFavourite', () => {
	it('20 concurrent swaps across two wallets end with exactly one favourite', async () => {
		const { scope } = await account();
		const a = await add(scope);
		const b = await add(scope);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) => setFavourite(db, scope, i % 2 ? a : b, NOW + i))
		);
		expect(results.every((r) => r === 'ok')).toBe(true);
		expect(await favourites(scope.spaceId)).toBe(1);
	});

	it('answers missing for an archived wallet and another space’s wallet, changing nothing', async () => {
		const { scope } = await account();
		const other = await account();
		const a = await add(scope);
		const b = await add(scope);
		const bRow = (await getWallet(db, scope.spaceId, b))!;
		await archiveWallet(db, scope, b, bRow.updatedAt, NOW + 1);
		expect(await setFavourite(db, scope, b, NOW + 2)).toBe('missing');
		expect(await setFavourite(db, other.scope, a, NOW + 2)).toBe('missing');
		expect((await getWallet(db, scope.spaceId, a))!.isFavourite).toBe(true);
	});
});

describe('membership inside the write', () => {
	it('a removed member’s scope writes nothing to the shared space', async () => {
		const owner = await account('Pemilik');
		const member = await account('Anggota');
		const spaceId = (await createSharedSpace(db, owner.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.id, NOW);
		const shared: WalletScope = { spaceId, userId: member.id };
		const id = await add(shared);
		const row = (await listMembers(db, spaceId, owner.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.id, memberId: row.id }, NOW);
		const w = (await getWallet(db, spaceId, id))!;
		expect(await createWallet(db, shared, input(), NOW + 1)).toEqual({ ok: false, reason: 'gone' });
		expect(await updateWallet(db, shared, id, input({ name: 'X' }), w.updatedAt, NOW + 1)).toBe(
			'stale'
		);
		expect(await archiveWallet(db, shared, id, w.updatedAt, NOW + 1)).toBe('stale');
		expect((await getWallet(db, spaceId, id))!.name).toBe('BCA');
		expect(await listWallets(db, spaceId)).toHaveLength(1);
	});
});

describe('space deletion (purgeSpaces)', () => {
	const rowsOf = async (table: string, spaceId: string) =>
		(await d1
			.prepare(`select count(*) as n from ${table} where space_id = ?`)
			.bind(spaceId)
			.first<{ n: number }>())!.n;

	it('every table with a space_id column is in SPACE_SCOPED_TABLES', () => {
		const tables: SQLiteTable[] = (Object.values(schema) as unknown[]).filter(
			(t): t is SQLiteTable => is(t, SQLiteTable)
		);
		const withSpaceId = tables
			.filter((t) => 'spaceId' in getTableColumns(t) && getTableName(t) !== 'spaces')
			.map((t) => getTableName(t))
			.sort();
		expect(SPACE_SCOPED_TABLES.map((t) => getTableName(t)).sort()).toEqual(withSpaceId);
	});

	it('removes the space’s wallets and seq counter, archived ones included, and nothing of another space', async () => {
		const p = await account();
		const other = await account();
		const id = await add(p.scope);
		await add(p.scope);
		await add(other.scope);
		const row = (await getWallet(db, p.scope.spaceId, id))!;
		await archiveWallet(db, p.scope, id, row.updatedAt, NOW + 1);
		await db.batch(purgeSpaces(db, sql`select ${p.scope.spaceId}`, () => sql`1`) as never);
		expect(await rowsOf('wallets', p.scope.spaceId)).toBe(0);
		expect(await rowsOf('space_seq', p.scope.spaceId)).toBe(0);
		expect(await rowsOf('wallets', other.scope.spaceId)).toBe(1);
		expect(await rowsOf('space_seq', other.scope.spaceId)).toBe(1);
	});

	it('account deletion deletes the personal space’s wallets with it', async () => {
		const p = await account();
		await add(p.scope);
		const proof = await signInWithPassword(db, p.email, PASSWORD, NOW);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, p.id, proof.hash, NOW)).toBe(true);
		expect(await rowsOf('wallets', p.scope.spaceId)).toBe(0);
		expect(await rowsOf('space_seq', p.scope.spaceId)).toBe(0);
	});
});
