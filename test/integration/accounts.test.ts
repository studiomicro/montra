import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, SIGN_UP_ERRORS } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { PASSWORD_ERRORS } from '#lib/server/auth/password';
import { openLocalD1 } from '../helpers/d1';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

const count = async (table: string) =>
	(await d1.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())?.n ?? -1;
const totals = async () => ({
	users: await count('users'),
	passwords: await count('user_passwords'),
	spaces: await count('spaces'),
	members: await count('space_members'),
	sessions: await count('sessions')
});

const valid = (email: string) => ({
	name: 'Budi Santoso',
	email,
	password: 'kopi-pagi-2026',
	adultConfirmed: true,
	consentAccepted: true
});

describe('signUp', () => {
	it('creates user, credential, personal space, owner membership and session in one batch', async () => {
		const before = await totals();
		const r = await signUp(db, valid('Budi@Contoh.ID '), 1_800_000_000_000);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.token.length).toBeGreaterThan(30);
		const after = await totals();
		expect(after).toEqual({
			users: before.users + 1,
			passwords: before.passwords + 1,
			spaces: before.spaces + 1,
			members: before.members + 1,
			sessions: before.sessions + 1
		});
		const user = await d1
			.prepare('select * from users where id = ?')
			.bind(r.userId)
			.first<Record<string, unknown>>();
		expect(user?.email).toBe('budi@contoh.id');
		expect(user?.adult_confirmed_at).toBe(1_800_000_000_000);
		const member = await d1
			.prepare(
				'select m.role, s.kind from space_members m join spaces s on s.id = m.space_id where m.user_id = ?'
			)
			.bind(r.userId)
			.first<{ role: string; kind: string }>();
		expect(member).toEqual({ role: 'owner', kind: 'personal' });
		const session = await d1
			.prepare('select token_hash, expires_at from sessions where user_id = ?')
			.bind(r.userId)
			.first<{ token_hash: string; expires_at: number }>();
		// Only the hash is stored, never the token.
		expect(session?.token_hash).not.toBe(r.token);
		expect(session?.expires_at).toBe(1_800_000_000_000 + 30 * 24 * 3600 * 1000);
	});

	it('refuses without the 18+ confirmation and writes nothing', async () => {
		const before = await totals();
		const r = await signUp(db, { ...valid('rina@contoh.id'), adultConfirmed: false }, Date.now());
		expect(r).toEqual({ ok: false, errors: { adult: SIGN_UP_ERRORS.adultRequired } });
		expect(await totals()).toEqual(before);
	});

	it('refuses a short or common password with its reason and writes nothing', async () => {
		const before = await totals();
		const short = await signUp(db, { ...valid('rina@contoh.id'), password: 'abc1234' }, Date.now());
		expect(short).toEqual({ ok: false, errors: { password: PASSWORD_ERRORS.too_short } });
		const common = await signUp(
			db,
			{ ...valid('rina@contoh.id'), password: 'password' },
			Date.now()
		);
		expect(common).toEqual({ ok: false, errors: { password: PASSWORD_ERRORS.too_simple } });
		expect(await totals()).toEqual(before);
	});

	it('answers "E-mail sudah terdaftar" for a registered address, whatever its case', async () => {
		await signUp(db, valid('siti@contoh.id'), Date.now());
		const before = await totals();
		const r = await signUp(db, valid('SITI@contoh.id'), Date.now());
		expect(r).toEqual({ ok: false, errors: { email: SIGN_UP_ERRORS.emailTaken } });
		expect(await totals()).toEqual(before);
	});

	it('strips control and zero-width characters from the name and caps it', async () => {
		const r = await signUp(
			db,
			{ ...valid('dewi@contoh.id'), name: '​De\u0000wi‮ ' + 'x'.repeat(200) },
			Date.now()
		);
		expect(r.ok).toBe(true);
		const row = await d1
			.prepare('select name from users where email = ?')
			.bind('dewi@contoh.id')
			.first<{ name: string }>();
		expect(row?.name.startsWith('Dewi x')).toBe(true);
		expect(Array.from(row?.name ?? '')).toHaveLength(80);
	});

	it('refuses a name that is only invisible characters', async () => {
		const r = await signUp(db, { ...valid('kosong@contoh.id'), name: '​‌ ' }, Date.now());
		expect(r).toEqual({ ok: false, errors: { name: SIGN_UP_ERRORS.nameRequired } });
	});

	it('lets exactly one of 20 concurrent sign-ups with one e-mail succeed (probe: concurrency)', async () => {
		const before = await totals();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => signUp(db, valid('race@contoh.id'), Date.now()))
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const refused = results.filter((r) => !r.ok);
		expect(refused).toHaveLength(19);
		for (const r of refused)
			expect(r).toEqual({ ok: false, errors: { email: SIGN_UP_ERRORS.emailTaken } });
		const after = await totals();
		expect(after.users - before.users).toBe(1);
		expect(after.spaces - before.spaces).toBe(1);
		expect(after.members - before.members).toBe(1);
		expect(after.sessions - before.sessions).toBe(1);
	});
});
