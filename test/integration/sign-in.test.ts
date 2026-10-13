import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { LOCKOUT_MS, PASSWORD_MAX_FAILURES, signInWithPassword } from '#lib/server/auth/password';
import {
	countAttempt,
	overUserSlidingLimit,
	THROTTLE_MAX_ATTEMPTS,
	THROTTLE_WINDOW_MS
} from '#lib/server/auth/throttle';
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

async function account(email: string) {
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		0
	);
	if (!r.ok) throw new Error('setup failed');
	return r.userId;
}
const lockState = (userId: string) =>
	d1
		.prepare('select failed_count, locked_until from user_passwords where user_id = ?')
		.bind(userId)
		.first<{ failed_count: number; locked_until: number | null }>();

describe('signInWithPassword', () => {
	it('accepts the right password, case-insensitive e-mail, and returns the stored hash', async () => {
		const id = await account('benar@contoh.id');
		const r = await signInWithPassword(db, ' BENAR@contoh.id', PASSWORD, 1000);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.user.id).toBe(id);
			expect(r.hash.length).toBeGreaterThan(20);
		}
	});

	it('refuses a wrong password and an unknown e-mail alike', async () => {
		await account('salah@contoh.id');
		expect(await signInWithPassword(db, 'salah@contoh.id', 'bukan-ini-1', 1000)).toEqual({
			ok: false,
			error: 'invalid_credentials'
		});
		expect(await signInWithPassword(db, 'tidak-ada@contoh.id', PASSWORD, 1000)).toEqual({
			ok: false,
			error: 'invalid_credentials'
		});
	});

	it('locks after 5 wrong passwords: the 6th, even right, is refused until the lock expires', async () => {
		const id = await account('kunci@contoh.id');
		const t = 10_000;
		for (let i = 0; i < PASSWORD_MAX_FAILURES - 1; i++)
			expect((await signInWithPassword(db, 'kunci@contoh.id', `salah-${i}xx`, t)).ok).toBe(false);
		expect(await signInWithPassword(db, 'kunci@contoh.id', 'salah-5xxx', t)).toEqual({
			ok: false,
			error: 'locked'
		});
		expect(await lockState(id)).toEqual({ failed_count: 0, locked_until: t + LOCKOUT_MS });
		// Right password while locked: refused, lock untouched.
		expect(await signInWithPassword(db, 'kunci@contoh.id', PASSWORD, t + 1)).toEqual({
			ok: false,
			error: 'locked'
		});
		expect((await lockState(id))?.locked_until).toBe(t + LOCKOUT_MS);
		// After expiry the right password works and clears the lock.
		expect((await signInWithPassword(db, 'kunci@contoh.id', PASSWORD, t + LOCKOUT_MS)).ok).toBe(
			true
		);
		expect(await lockState(id)).toEqual({ failed_count: 0, locked_until: null });
	});

	it('counts concurrent wrong passwords exactly (guarded UPDATE, no read-then-write)', async () => {
		const id = await account('serentak@contoh.id');
		const results = await Promise.all(
			Array.from({ length: 4 }, (_, i) =>
				signInWithPassword(db, 'serentak@contoh.id', `salah-${i}xx`, 5000)
			)
		);
		expect(results.every((r) => !r.ok)).toBe(true);
		expect((await lockState(id))?.failed_count).toBe(4);
	});

	it('locks once under 20 concurrent wrong attempts and refuses a concurrent right one', async () => {
		const id = await account('banjir@contoh.id');
		const attempts = Array.from({ length: 20 }, (_, i) =>
			signInWithPassword(db, 'banjir@contoh.id', `salah-${i}xx`, 7000)
		);
		await Promise.all(attempts);
		const state = await lockState(id);
		expect(state?.locked_until).toBe(7000 + LOCKOUT_MS);
		expect((await signInWithPassword(db, 'banjir@contoh.id', PASSWORD, 7001)).ok).toBe(false);
	});

	it('a right password resets the failure count', async () => {
		const id = await account('reset@contoh.id');
		await signInWithPassword(db, 'reset@contoh.id', 'salah-1xx', 1);
		await signInWithPassword(db, 'reset@contoh.id', 'salah-2xx', 2);
		expect((await lockState(id))?.failed_count).toBe(2);
		expect((await signInWithPassword(db, 'reset@contoh.id', PASSWORD, 3)).ok).toBe(true);
		expect((await lockState(id))?.failed_count).toBe(0);
	});

	it('refuses a disabled account like a wrong password', async () => {
		const id = await account('nonaktif@contoh.id');
		await d1.prepare(`update users set status = 'disabled' where id = ?`).bind(id).run();
		expect(await signInWithPassword(db, 'nonaktif@contoh.id', PASSWORD, 1)).toEqual({
			ok: false,
			error: 'invalid_credentials'
		});
	});
});

describe('countAttempt (per-client throttle)', () => {
	it('allows THROTTLE_MAX_ATTEMPTS per window, then refuses', async () => {
		const now = 1_800_000_000_000;
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i++)
			expect(await countAttempt(db, 'sign-in:198.51.100.1', now)).toBe(false);
		expect(await countAttempt(db, 'sign-in:198.51.100.1', now)).toBe(true);
		// Another client and another scope have their own budgets.
		expect(await countAttempt(db, 'sign-in:198.51.100.2', now)).toBe(false);
		expect(await countAttempt(db, 'sign-up:198.51.100.1', now)).toBe(false);
	});

	it('counts 30 concurrent first attempts exactly: 20 allowed, 10 refused', async () => {
		const now = 1_800_000_600_000;
		const results = await Promise.all(
			Array.from({ length: 30 }, () => countAttempt(db, 'sign-in:203.0.113.50', now))
		);
		expect(results.filter((over) => !over)).toHaveLength(THROTTLE_MAX_ATTEMPTS);
	});

	it('starts a fresh budget in the next window', async () => {
		const now = 1_800_001_200_000;
		for (let i = 0; i <= THROTTLE_MAX_ATTEMPTS; i++)
			await countAttempt(db, 'sign-in:203.0.113.77', now);
		expect(await countAttempt(db, 'sign-in:203.0.113.77', now + 10 * 60 * 1000)).toBe(false);
	});
});

describe('overUserSlidingLimit (FN-16a red team L5)', () => {
	const MAX = 30;
	// A fixed 10-minute window edge: 1_800_000_000_000 is a multiple of THROTTLE_WINDOW_MS.
	const EDGE = 1_800_000_000_000;
	const over = (user: string, now: number) =>
		overUserSlidingLimit(db, user, now, 'statement-upload', MAX);

	it('never lets more than max through within any window, also around a fixed window’s edge', async () => {
		expect(EDGE % THROTTLE_WINDOW_MS).toBe(0);
		for (let i = 0; i < MAX; i++) expect(await over('geser-a', EDGE - 30_000)).toBe(false);
		// A fixed window starts over here; the sliding one does not.
		expect(await over('geser-a', EDGE + 30_000)).toBe(true);
		expect(await over('geser-a', EDGE + 8 * 60_000)).toBe(true);
		// Once those 30 lie more than a window back, the budget is there again.
		expect(await over('geser-a', EDGE - 30_000 + THROTTLE_WINDOW_MS + 60_000)).toBe(false);
		// Another user keeps their own budget.
		expect(await over('geser-b', EDGE + 30_000)).toBe(false);
	});

	it('cycle 2 L1: refused retries are not counted; the budget returns once the allowed ones age out', async () => {
		for (let i = 0; i < MAX; i++) expect(await over('geser-d', EDGE)).toBe(false);
		// Five retries a minute for twenty minutes: refused while the 30 are inside the window, allowed after.
		const answers: boolean[] = [];
		for (let m = 1; m <= 20; m++)
			for (let i = 0; i < 5; i++) answers.push(await over('geser-d', EDGE + m * 60_000 + i));
		expect(answers.slice(0, 50).every((refused) => refused)).toBe(true);
		expect(answers.slice(50, 55)).toEqual([false, false, false, false, false]);
		// The window still never holds more than MAX allowed (the L5 edge stays closed).
		expect(answers.filter((refused) => !refused).length).toBeLessThanOrEqual(MAX);
	});

	it('counts attempts spread over the window, and 40 concurrent ones exactly', async () => {
		for (let m = 0; m < 10; m++)
			for (let i = 0; i < 2; i++) expect(await over('geser-c', EDGE + m * 60_000)).toBe(false);
		const results = await Promise.all(
			Array.from({ length: 40 }, () => over('geser-c', EDGE + 9 * 60_000 + 30_000))
		);
		expect(results.filter((refused) => !refused)).toHaveLength(MAX - 20);
	});
});
