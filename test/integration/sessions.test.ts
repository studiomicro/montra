import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import {
	createPasswordSession,
	resolveSession,
	revokeSession,
	SESSION_TOUCH_MS,
	SESSION_TTL_MS
} from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
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

async function account(email: string, now = 0) {
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		now
	);
	if (!r.ok) throw new Error('setup failed');
	return r;
}

describe('sessions', () => {
	it('resolves a live session to its user, without credential fields', async () => {
		const a = await account('sesi@contoh.id', 1000);
		const user = await resolveSession(db, a.token, 2000);
		expect(user).toEqual({ id: a.userId, email: 'sesi@contoh.id', name: 'Uji', createdAt: 1000 });
	});

	it('treats an unknown, expired or revoked token as signed out', async () => {
		const a = await account('habis@contoh.id', 0);
		expect(await resolveSession(db, 'bukan-token', 1)).toBeNull();
		expect(await resolveSession(db, a.token, SESSION_TTL_MS)).toBeNull();
		expect(await resolveSession(db, a.token, SESSION_TTL_MS - 1)).not.toBeNull();
		await revokeSession(db, a.token, 5);
		expect(await resolveSession(db, a.token, 6)).toBeNull();
	});

	it('signs out one device only (probe: two devices)', async () => {
		const a = await account('dua@contoh.id', 0);
		const proof = await signInWithPassword(db, 'dua@contoh.id', PASSWORD, 10);
		if (!proof.ok) throw new Error('sign-in failed');
		const second = await createPasswordSession(db, a.userId, proof.hash, 10);
		expect(second).not.toBeNull();
		expect(await revokeSession(db, a.token, 20)).toBe(1);
		expect(await resolveSession(db, a.token, 21)).toBeNull();
		expect((await resolveSession(db, second!.token, 21))?.id).toBe(a.userId);
	});

	it('touches last_seen_at at most once per interval', async () => {
		const a = await account('lihat@contoh.id', 0);
		const seen = () =>
			d1
				.prepare('select last_seen_at as t from sessions where user_id = ?')
				.bind(a.userId)
				.first<{ t: number }>();
		await resolveSession(db, a.token, SESSION_TOUCH_MS - 1);
		expect((await seen())?.t).toBe(0);
		await resolveSession(db, a.token, SESSION_TOUCH_MS);
		expect((await seen())?.t).toBe(SESSION_TOUCH_MS);
	});

	it('writes no session for a sign-in whose account was deleted meanwhile', async () => {
		const a = await account('balapan@contoh.id', 0);
		const proof = await signInWithPassword(db, 'balapan@contoh.id', PASSWORD, 1);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, a.userId, proof.hash)).toBe(true);
		expect(await createPasswordSession(db, a.userId, proof.hash, 2)).toBeNull();
	});

	it('records last_login_at on a password session', async () => {
		const a = await account('login@contoh.id', 0);
		const proof = await signInWithPassword(db, 'login@contoh.id', PASSWORD, 50);
		if (!proof.ok) throw new Error('sign-in failed');
		await createPasswordSession(db, a.userId, proof.hash, 50);
		const row = await d1
			.prepare('select last_login_at as t from users where id = ?')
			.bind(a.userId)
			.first<{ t: number }>();
		expect(row?.t).toBe(50);
	});
});
