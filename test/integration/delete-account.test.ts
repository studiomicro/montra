import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import { createSharedSpace } from '#lib/server/spaces/spaces';
import { openLocalD1 } from '../helpers/d1';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

async function account(email: string) {
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		0
	);
	if (!r.ok) throw new Error('setup failed');
	const space = await d1
		.prepare('select space_id as id from space_members where user_id = ?')
		.bind(r.userId)
		.first<{ id: string }>();
	return { ...r, spaceId: space!.id };
}
const rows = async (table: string, column: string, value: string) =>
	(await d1.prepare(`select count(*) as n from ${table} where ${column} = ?`).bind(value).first<{
		n: number;
	}>())!.n;
async function footprint(userId: string, spaceId: string) {
	return {
		users: await rows('users', 'id', userId),
		passwords: await rows('user_passwords', 'user_id', userId),
		sessions: await rows('sessions', 'user_id', userId),
		members: await rows('space_members', 'user_id', userId),
		space: await rows('spaces', 'id', spaceId)
	};
}
const proofFor = async (email: string) => {
	const p = await signInWithPassword(db, email, PASSWORD, 1);
	if (!p.ok) throw new Error('proof failed');
	return p.hash;
};

describe('deleteAccount', () => {
	it('deletes user, credential, sessions, memberships and the personal space', async () => {
		const a = await account('hapus@contoh.id');
		const other = await account('tetap@contoh.id');
		expect(await deleteAccount(db, a.userId, await proofFor('hapus@contoh.id'))).toBe(true);
		expect(await footprint(a.userId, a.spaceId)).toEqual({
			users: 0,
			passwords: 0,
			sessions: 0,
			members: 0,
			space: 0
		});
		// Another user's rows are untouched.
		expect(await footprint(other.userId, other.spaceId)).toEqual({
			users: 1,
			passwords: 1,
			sessions: 1,
			members: 1,
			space: 1
		});
	});

	it('leaves every row when the proven hash is not the stored one', async () => {
		const a = await account('salah-hapus@contoh.id');
		expect(await deleteAccount(db, a.userId, 'not-the-hash')).toBe(false);
		expect(await footprint(a.userId, a.spaceId)).toEqual({
			users: 1,
			passwords: 1,
			sessions: 1,
			members: 1,
			space: 1
		});
	});

	it('keeps a space that still has another member, removing only the membership', async () => {
		const a = await account('pemilik@contoh.id');
		const b = await account('anggota@contoh.id');
		await d1
			.prepare(
				`insert into space_members (id, space_id, user_id, role, created_at, updated_at) values ('m-x', ?, ?, 'member', 0, 0)`
			)
			.bind(a.spaceId, b.userId)
			.run();
		expect(await deleteAccount(db, a.userId, await proofFor('pemilik@contoh.id'))).toBe(true);
		expect(await rows('spaces', 'id', a.spaceId)).toBe(1);
		expect(await rows('space_members', 'space_id', a.spaceId)).toBe(1);
		expect(await rows('users', 'id', a.userId)).toBe(0);
	});

	it('cannot be replayed with an old proof after a second delete attempt', async () => {
		const a = await account('ulang@contoh.id');
		const hash = await proofFor('ulang@contoh.id');
		const [first, second] = await Promise.all([
			deleteAccount(db, a.userId, hash),
			deleteAccount(db, a.userId, hash)
		]);
		expect([first, second].filter(Boolean)).toHaveLength(1);
		expect(await rows('users', 'id', a.userId)).toBe(0);
	});

	it('N1: a space created after deletion began and before its batch is deleted too, never left memberless', async () => {
		const a = await account('kilat@contoh.id');
		const proof = await proofFor('kilat@contoh.id');
		let raced: string | null = null;
		// The user's other tab creates a shared space just before the deletion batch runs (after anything the
		// deletion read beforehand).
		const racing = new Proxy(db, {
			get(target, prop) {
				const value = Reflect.get(target, prop) as unknown;
				if (prop === 'batch')
					return async (steps: unknown) => {
						raced = await createSharedSpace(db, a.userId, 'Liburan', 5);
						return (value as (s: unknown) => unknown).call(target, steps);
					};
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		expect(await deleteAccount(racing, a.userId, proof)).toBe(true);
		expect(raced).not.toBeNull();
		expect(await rows('spaces', 'id', raced!)).toBe(0);
		expect(await rows('audit_events', 'space_id', raced!)).toBe(0);
		expect(await rows('spaces', 'id', a.spaceId)).toBe(0);
		const memberless = await d1
			.prepare(
				`select count(*) as n from spaces s where not exists (select 1 from space_members m where m.space_id = s.id)`
			)
			.first<{ n: number }>();
		expect(memberless?.n).toBe(0);
	});

	it('marks nothing as deleted when the proof no longer holds', async () => {
		const a = await account('tanda@contoh.id');
		const shared = await createSharedSpace(db, a.userId, 'Rumah', 1);
		expect(await deleteAccount(db, a.userId, 'not-the-hash')).toBe(false);
		const live = await d1
			.prepare(`select count(*) as n from spaces where id in (?, ?) and deleted_at is null`)
			.bind(a.spaceId, shared)
			.first<{ n: number }>();
		expect(live?.n).toBe(2);
	});
});
