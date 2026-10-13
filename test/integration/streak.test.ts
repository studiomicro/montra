import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { closeDay, STREAK_LOOKBACK_DAYS, streakSummary } from '#lib/server/streak/repo';
import { addDays, wibDateString, wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

// FN-34: "Tutup hari" and the account-wide streak, through the repo and Beranda's load and closeDay action.

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const beranda = await import('../../src/routes/(app)/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = 1_800_000_000_000;
/** 31 Oct 2026 23:30 WIB (16:30 UTC) and 1 Nov 2026 00:30 WIB (17:30 UTC): the same UTC date. */
const LAST_OF_MONTH_2330 = Date.UTC(2026, 9, 31, 16, 30);
const FIRST_OF_MONTH_0030 = Date.UTC(2026, 9, 31, 17, 30);

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());
afterEach(() => vi.restoreAllMocks());

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value)) return { kind: 'fail' as const, status: value.status };
		return { kind: 'ok' as const, value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status };
		throw e;
	}
}

let n = 0;
async function person(name = 'Uji') {
	const email = `streak${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	return { user: { id: r.userId, email, name, createdAt: 0 }, personal };
}
type Person = Awaited<ReturnType<typeof person>>;

async function ev(who: Person | null, space?: string, form?: Record<string, string>) {
	const resolved = who ? await resolveCurrentSpace(db, who.user.id, space) : null;
	return fakeEvent({
		url: 'http://localhost/',
		routeId: '/(app)',
		db,
		user: who?.user ?? null,
		space: resolved,
		form
	}).event as never;
}
const load = async (who: Person | null, space?: string) =>
	run(async () => beranda.load(await ev(who, space)));
const close = async (who: Person | null, space?: string, form: Record<string, string> = {}) =>
	run(async () =>
		(beranda.actions as Record<string, (e: never) => unknown>).closeDay!(await ev(who, space, form))
	);
const streakOf = async (who: Person, space?: string) => {
	const r = await load(who, space);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.streak;
};
const rows = async (userId: string) =>
	(await d1
		.prepare('select count(*) as n from day_closures where user_id = ?')
		.bind(userId)
		.first<{ n: number }>())!.n;

describe('streakSummary', () => {
	it('a user who never closed a day has a streak of 0 (criterion 13)', async () => {
		const p = await person();
		expect(await streakSummary(db, p.user.id, '2026-10-08')).toEqual({
			current: 0,
			closedToday: false
		});
	});

	it('grows by exactly one per unbroken WIB day closed (criterion 4)', async () => {
		const p = await person();
		const today = '2026-10-08';
		await closeDay(db, p.user.id, addDays(today, -1), NOW);
		await closeDay(db, p.user.id, today, NOW);
		expect(await streakSummary(db, p.user.id, today)).toEqual({ current: 2, closedToday: true });
		await closeDay(db, p.user.id, addDays(today, -2), NOW);
		expect((await streakSummary(db, p.user.id, today)).current).toBe(3);
		// The next day, while it is still open, yesterday's run still counts.
		expect(await streakSummary(db, p.user.id, addDays(today, 1))).toEqual({
			current: 3,
			closedToday: false
		});
	});

	it('a gap resets the streak to 0 and is never filled in (criterion 5)', async () => {
		const p = await person();
		const today = '2026-10-08';
		await closeDay(db, p.user.id, addDays(today, -3), NOW);
		expect(await streakSummary(db, p.user.id, today)).toEqual({ current: 0, closedToday: false });
		expect(await rows(p.user.id)).toBe(1);
	});

	it('reads at most STREAK_LOOKBACK_DAYS days back (bounded scan)', async () => {
		const p = await person();
		const today = '2026-10-08';
		const days = Array.from({ length: STREAK_LOOKBACK_DAYS + 5 }, (_, i) => addDays(today, -i));
		await d1.batch(
			days.map((d, i) =>
				d1
					.prepare(
						'insert into day_closures (id, user_id, closed_on, created_at, updated_at) values (?, ?, ?, ?, ?)'
					)
					.bind(`bulk-${n}-${i}`, p.user.id, d, NOW, NOW)
			)
		);
		expect((await streakSummary(db, p.user.id, today)).current).toBe(STREAK_LOOKBACK_DAYS);
	});
});

describe('closing the day', () => {
	it('Beranda offers the close while today is open, then shows it closed across reloads (criteria 1–3)', async () => {
		const p = await person();
		expect(await streakOf(p)).toEqual({ current: 0, closedToday: false });
		expect(await close(p)).toEqual({ kind: 'ok', value: { saved: 'closed' } });
		expect(await rows(p.user.id)).toBe(1);
		const today = wibTodayString();
		const row = await d1
			.prepare('select closed_on from day_closures where user_id = ?')
			.bind(p.user.id)
			.first<{ closed_on: string }>();
		// Today is the server's WIB date, never the UTC one (they differ 00:00–07:00 WIB).
		expect([today, wibTodayString(Date.now() - 60_000)]).toContain(row!.closed_on);
		expect(await streakOf(p)).toEqual({ current: 1, closedToday: true });
		expect(await streakOf(p)).toEqual({ current: 1, closedToday: true });
	});

	it('23:30 WIB on the last day of a month and 00:30 WIB on the first are two days (criterion 6)', async () => {
		const p = await person();
		const now = vi.spyOn(Date, 'now');
		now.mockReturnValue(LAST_OF_MONTH_2330);
		expect(await close(p)).toMatchObject({ kind: 'ok' });
		now.mockReturnValue(FIRST_OF_MONTH_0030);
		expect(await close(p)).toMatchObject({ kind: 'ok' });
		now.mockRestore();
		const days = await d1
			.prepare('select closed_on from day_closures where user_id = ? order by closed_on')
			.bind(p.user.id)
			.all<{ closed_on: string }>();
		expect(days.results.map((r) => r.closed_on)).toEqual(['2026-10-31', '2026-11-01']);
		// Both instants share the UTC date 2026-10-31: bucketing by UTC would have made them one day.
		expect(new Date(LAST_OF_MONTH_2330).toISOString().slice(0, 10)).toBe(
			new Date(FIRST_OF_MONTH_0030).toISOString().slice(0, 10)
		);
		expect(await streakSummary(db, p.user.id, wibDateString(FIRST_OF_MONTH_0030))).toEqual({
			current: 2,
			closedToday: true
		});
	});

	it('20 concurrent closes of the same day (two tabs, retries) leave exactly one row (criterion 7)', async () => {
		const p = await person();
		const results = await Promise.all(Array.from({ length: 20 }, () => close(p)));
		expect(results.every((r) => r.kind === 'ok')).toBe(true);
		const direct = await Promise.all(
			Array.from({ length: 20 }, () => closeDay(db, p.user.id, '2026-01-15', NOW))
		);
		expect(direct.every(Boolean)).toBe(true);
		expect(await rows(p.user.id)).toBe(2);
	});

	it('two devices closing the same day: the second sees it closed and adds nothing', async () => {
		const p = await person();
		expect(await closeDay(db, p.user.id, '2026-10-08', NOW)).toBe(true);
		expect(await closeDay(db, p.user.id, '2026-10-08', NOW + 1_000)).toBe(true);
		expect(await rows(p.user.id)).toBe(1);
	});

	it('a signed-out visitor is sent to /masuk and writes nothing', async () => {
		const total = async () =>
			(await d1.prepare('select count(*) as n from day_closures').first<{ n: number }>())!.n;
		const before = await total();
		expect(await close(null)).toMatchObject({ kind: 'redirect', status: 303, location: '/masuk' });
		expect(await total()).toBe(before);
	});

	it('closing for an account that no longer exists writes nothing', async () => {
		expect(await closeDay(db, 'no-such-user', '2026-10-08', NOW)).toBe(false);
		expect(await rows('no-such-user')).toBe(0);
	});
});

describe('one account-wide streak (criteria 8, 9)', () => {
	async function shared() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		return { owner, member, spaceId };
	}

	it('closing from the shared space’s Beranda shows on the personal one, and not for the other member', async () => {
		const { owner, member, spaceId } = await shared();
		expect(await close(member, spaceId)).toMatchObject({ kind: 'ok' });
		expect(await streakOf(member, spaceId)).toEqual({ current: 1, closedToday: true });
		expect(await streakOf(member, member.personal)).toEqual({ current: 1, closedToday: true });
		expect(await rows(member.user.id)).toBe(1);
		// The owner of the same space keeps their own streak.
		expect(await streakOf(owner, spaceId)).toEqual({ current: 0, closedToday: false });
		expect(await rows(owner.user.id)).toBe(0);
	});

	it('no id or date in the form can reach another account or another day', async () => {
		const a = await person('A');
		const b = await person('B');
		expect(
			await close(a, undefined, { userId: b.user.id, user_id: b.user.id, closedOn: '2020-01-01' })
		).toMatchObject({ kind: 'ok' });
		expect(await rows(b.user.id)).toBe(0);
		const days = await d1
			.prepare('select closed_on from day_closures where user_id = ?')
			.bind(a.user.id)
			.all<{ closed_on: string }>();
		expect(days.results.map((r) => r.closed_on)).not.toContain('2020-01-01');
	});

	it('a removed member naming the shared space closes only their own day, in their personal space', async () => {
		const { owner, member, spaceId } = await shared();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		// The cookie names the old space; the gate resolves the personal space instead.
		expect(await close(member, spaceId)).toMatchObject({ kind: 'ok' });
		expect(await rows(member.user.id)).toBe(1);
		expect(await rows(owner.user.id)).toBe(0);
	});

	it('a removed member whose request still carries the stale shared space closes their own day (red team L1)', async () => {
		const { owner, member, spaceId } = await shared();
		// The space was resolved for this request before the removal landed: locals.space is stale.
		const stale = await ev(member, spaceId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		expect(
			await run(() => (beranda.actions as Record<string, (e: never) => unknown>).closeDay!(stale))
		).toMatchObject({ kind: 'ok', value: { saved: 'closed' } });
		expect(await rows(member.user.id)).toBe(1);
		expect(await rows(owner.user.id)).toBe(0);
	});

	it('closing the day still needs a signed-in account', async () => {
		expect(await close(null)).toMatchObject({ kind: 'redirect', status: 303, location: '/masuk' });
	});
});

describe('failure and account deletion', () => {
	it('a failing streak read leaves the rest of Beranda loaded (criterion 10)', async () => {
		const p = await person();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		await d1.prepare('alter table day_closures rename to day_closures_away').run();
		try {
			const r = await load(p);
			expect(r.kind).toBe('ok');
			if (r.kind !== 'ok') return;
			expect(r.value.streak).toBeNull();
			expect(r.value.summary).not.toBeNull();
			expect(r.value.loadError).toBeNull();
		} finally {
			await d1.prepare('alter table day_closures_away rename to day_closures').run();
		}
		// The log line names the error class only, never a query with its parameters.
		expect(errors).toHaveBeenCalledWith('beranda: streak failed', expect.any(String));
		expect(String(errors.mock.calls[0]?.[1])).not.toContain(p.user.id);
	});

	it('closures go with the account', async () => {
		const p = await person();
		await closeDay(db, p.user.id, '2026-10-08', NOW);
		const proof = await signInWithPassword(db, p.user.email, PASSWORD, NOW);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, p.user.id, proof.hash, NOW)).toBe(true);
		expect(await rows(p.user.id)).toBe(0);
	});
});

describe('migration 0024: closed_on is always a real YYYY-MM-DD date', () => {
	const insert = (id: string, userId: string, day: string) =>
		d1
			.prepare(
				'insert into day_closures (id, user_id, closed_on, created_at, updated_at) values (?, ?, ?, ?, ?)'
			)
			.bind(id, userId, day, NOW, NOW)
			.run();

	it('refuses an insert of any other form, accepts a valid date', async () => {
		const p = await person();
		for (const [i, bad] of [
			'2026-10-8',
			'2026-02-30',
			'2026-13-01',
			'2026-10-08 00:00',
			'08/10/2026',
			'20261008',
			'',
			'kemarin'
		].entries())
			await expect(insert(`bad-${n}-${i}`, p.user.id, bad), bad).rejects.toThrow(
				/closed_on must be YYYY-MM-DD/
			);
		await insert(`good-${n}`, p.user.id, '2026-02-28');
		expect(await rows(p.user.id)).toBe(1);
	});

	it('refuses an update to another form, so a stored date stays valid', async () => {
		const p = await person();
		await insert(`upd-${n}`, p.user.id, '2026-10-08');
		await expect(
			d1
				.prepare('update day_closures set closed_on = ? where user_id = ?')
				.bind('2026-10-08T00:00', p.user.id)
				.run()
		).rejects.toThrow(/closed_on must be YYYY-MM-DD/);
		await d1
			.prepare('update day_closures set closed_on = ? where user_id = ?')
			.bind('2026-10-09', p.user.id)
			.run();
		const row = await d1
			.prepare('select closed_on from day_closures where user_id = ?')
			.bind(p.user.id)
			.first<{ closed_on: string }>();
		expect(row?.closed_on).toBe('2026-10-09');
	});
});
