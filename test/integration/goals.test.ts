import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import {
	addContribution,
	deleteContribution,
	listContributions,
	MAX_CONTRIBUTIONS_PER_GOAL
} from '#lib/server/goals/contributions';
import { goalProgressPercent, goalSavedMinor, goalsSavedSums } from '#lib/server/goals/progress';
import {
	archiveGoal,
	createGoal,
	getGoal,
	listGoals,
	MAX_GOALS_PER_SPACE,
	restoreGoal,
	updateGoal,
	type GoalScope
} from '#lib/server/goals/repo';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import {
	createSharedSpace,
	listMembers,
	purgeSpaces,
	removeMember
} from '#lib/server/spaces/spaces';
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
	const email = `tabungan${++n}@contoh.id`;
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
	const scope: GoalScope = { spaceId: personal!.id, userId: r.userId };
	return { id: r.userId, email, scope };
}

async function goal(scope: GoalScope, targetAmountMinor = 125_000_000, name = 'Liburan', at = NOW) {
	const r = await createGoal(db, scope, { name, targetAmountMinor }, at);
	if (!r.ok) throw new Error(`create failed: ${r.reason}`);
	return r.id;
}

async function give(
	scope: GoalScope,
	goalId: string,
	amountMinor: number,
	note: string | null = null
) {
	const r = await addContribution(db, scope, goalId, { amountMinor, note }, NOW);
	if (!r.ok) throw new Error(`contribution failed: ${r.reason}`);
	return r.id;
}

async function sharedSpace() {
	const owner = await account('Pemilik');
	const member = await account('Anggota');
	const spaceId = (await createSharedSpace(db, owner.id, 'Keluarga', NOW))!;
	const invite = (await createInvite(db, { spaceId, userId: owner.id, replaces: '' }, NOW))!;
	await acceptInvite(db, invite.token, member.id, NOW);
	return {
		owner,
		member,
		spaceId,
		ownerScope: { spaceId, userId: owner.id } as GoalScope,
		memberScope: { spaceId, userId: member.id } as GoalScope
	};
}

const rawGoal = (id: string) =>
	d1.prepare('select * from goals where id = ?').bind(id).first<{
		seq: number;
		deleted_at: number | null;
		updated_at: number;
		currency: string;
	}>();

describe('createGoal / listGoals', () => {
	it('creates an IDR goal at 0 % with a fresh seq, listed oldest first', async () => {
		const p = await account();
		const a = await goal(p.scope, 100_000_00, 'A');
		const b = await goal(p.scope, 50_000_00, 'B', NOW + 1);
		const list = await listGoals(db, p.scope.spaceId);
		expect(list.map((g) => [g.id, g.savedMinor, g.percent, g.archived])).toEqual([
			[a, 0, 0, false],
			[b, 0, 0, false]
		]);
		const [ra, rb] = [await rawGoal(a), await rawGoal(b)];
		expect(ra!.currency).toBe('IDR');
		expect(rb!.seq).toBeGreaterThan(ra!.seq);
	});

	it('the SQL CHECK refuses a non-positive target even past validation', async () => {
		const p = await account();
		await expect(
			createGoal(db, p.scope, { name: 'X', targetAmountMinor: 0 }, NOW)
		).rejects.toThrow();
		await expect(
			d1
				.prepare(
					`insert into goals (id, space_id, name, target_amount_minor, created_at, updated_at, seq)
					 values ('g', ?, 'X', -1, 0, 0, 0)`
				)
				.bind(p.scope.spaceId)
				.run()
		).rejects.toThrow(/CHECK/);
	});

	it('holds the 50-goal cap exactly under 10 concurrent creates', async () => {
		const p = await account();
		for (let i = 0; i < MAX_GOALS_PER_SPACE - 3; i++) await goal(p.scope, 100, `G${i}`, NOW + i);
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				createGoal(db, p.scope, { name: `C${i}`, targetAmountMinor: 100 }, NOW + 100 + i)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(3);
		expect(results.filter((r) => !r.ok && r.reason === 'limit')).toHaveLength(7);
		expect(await listGoals(db, p.scope.spaceId)).toHaveLength(MAX_GOALS_PER_SPACE);
	});
});

describe('progress = Σ live contributions', () => {
	it('totals reconcile: the shown percent equals the manual sum of the seeded contributions', async () => {
		const p = await account();
		const id = await goal(p.scope, 125_000_000);
		const fixture = [25_000_00, 300_000_00, 12_345_00, 1_00, 99_999_00];
		for (const amount of fixture) await give(p.scope, id, amount);
		const manual = fixture.reduce((a, b) => a + b, 0);
		const [listed] = await listGoals(db, p.scope.spaceId);
		expect(listed!.savedMinor).toBe(manual);
		expect(listed!.percent).toBe(Math.floor((manual * 100) / 125_000_000));
		expect(await goalSavedMinor(db, p.scope.spaceId, id)).toBe(manual);
		expect((await getGoal(db, p.scope.spaceId, id))!.percent).toBe(listed!.percent);
	});

	it('goalsSavedSums groups every goal of the space in one query and nothing of another space', async () => {
		const p = await account();
		const other = await account();
		const a = await goal(p.scope);
		const b = await goal(p.scope);
		const c = await goal(other.scope);
		await give(p.scope, a, 100);
		await give(p.scope, a, 250);
		await give(other.scope, c, 999);
		const sums = await goalsSavedSums(db, p.scope.spaceId);
		expect({ ...sums }).toEqual({ [a]: 350 });
		expect(sums[b] ?? 0).toBe(0);
		// Another space's goal id summed under this space: nothing.
		expect(await goalSavedMinor(db, p.scope.spaceId, c)).toBe(0);
	});

	it('over-saving reads above 100 % and the goal is met', async () => {
		const p = await account();
		const id = await goal(p.scope, 125_000_000);
		await give(p.scope, id, 135_000_000);
		const g = (await getGoal(db, p.scope.spaceId, id))!;
		expect(g.percent).toBe(108);
		expect(goalProgressPercent(g.savedMinor, g.targetAmountMinor)).toBe(108);
	});

	it('20 concurrent contributions: none lost, the sum is exact', async () => {
		const p = await account();
		const id = await goal(p.scope);
		const amounts = Array.from({ length: 20 }, (_, i) => (i + 1) * 1_000_00);
		const results = await Promise.all(
			amounts.map((amountMinor) =>
				addContribution(db, p.scope, id, { amountMinor, note: null }, NOW)
			)
		);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(await goalSavedMinor(db, p.scope.spaceId, id)).toBe(amounts.reduce((a, b) => a + b, 0));
		expect((await listContributions(db, p.scope.spaceId, id)).rows).toHaveLength(20);
	});

	it('refuses a contribution that would take the saved total past the exact-integer range', async () => {
		const p = await account();
		const id = await goal(p.scope, 100);
		await give(p.scope, id, Number.MAX_SAFE_INTEGER - 10);
		expect(await addContribution(db, p.scope, id, { amountMinor: 11, note: null }, NOW)).toEqual({
			ok: false,
			reason: 'too_large'
		});
		expect(
			await addContribution(db, p.scope, id, { amountMinor: 10, note: null }, NOW)
		).toMatchObject({
			ok: true
		});
		expect(await goalSavedMinor(db, p.scope.spaceId, id)).toBe(Number.MAX_SAFE_INTEGER);
	});

	it('the SQL CHECK refuses a zero or negative contribution', async () => {
		const p = await account();
		const id = await goal(p.scope);
		await expect(
			addContribution(db, p.scope, id, { amountMinor: -500, note: null }, NOW)
		).rejects.toThrow();
		expect(await goalSavedMinor(db, p.scope.spaceId, id)).toBe(0);
	});
});

describe('deleteContribution (the only way down)', () => {
	it('tombstones the row content-free (no amount, note, author or time) and lowers the saved amount', async () => {
		const p = await account();
		const id = await goal(p.scope);
		await give(p.scope, id, 50_000_00);
		const mistake = await give(p.scope, id, 500_000_00, 'salah ketik');
		expect(await deleteContribution(db, p.scope, id, mistake, NOW + 1)).toBe('ok');
		expect(await goalSavedMinor(db, p.scope.spaceId, id)).toBe(50_000_00);
		expect({ ...(await goalsSavedSums(db, p.scope.spaceId)) }).toEqual({ [id]: 50_000_00 });
		const row = await d1
			.prepare(
				`select id, goal_id, space_id, deleted_at, amount_minor, note, created_by_user_id, created_at
				 from goal_contributions where id = ?`
			)
			.bind(mistake)
			.first();
		expect(row).toEqual({
			id: mistake,
			goal_id: id,
			space_id: p.scope.spaceId,
			deleted_at: NOW + 1,
			amount_minor: null,
			note: null,
			created_by_user_id: null,
			created_at: null
		});
		expect((await listContributions(db, p.scope.spaceId, id)).rows.map((c) => c.id)).not.toContain(
			mistake
		);
		// Twice: already gone.
		expect(await deleteContribution(db, p.scope, id, mistake, NOW + 2)).toBe('missing');
	});

	it('refuses a contribution of another goal or another space (scoped by space AND goal)', async () => {
		const p = await account();
		const other = await account();
		const a = await goal(p.scope);
		const b = await goal(p.scope);
		const theirs = await goal(other.scope);
		const inA = await give(p.scope, a, 100);
		const inTheirs = await give(other.scope, theirs, 100);
		expect(await deleteContribution(db, p.scope, b, inA, NOW)).toBe('missing');
		expect(await deleteContribution(db, p.scope, theirs, inTheirs, NOW)).toBe('missing');
		expect(await deleteContribution(db, p.scope, a, inTheirs, NOW)).toBe('missing');
		expect(await goalSavedMinor(db, p.scope.spaceId, a)).toBe(100);
		expect(await goalSavedMinor(db, other.scope.spaceId, theirs)).toBe(100);
	});

	it('refuses adding to another space’s goal', async () => {
		const p = await account();
		const other = await account();
		const theirs = await goal(other.scope);
		expect(await addContribution(db, p.scope, theirs, { amountMinor: 1, note: null }, NOW)).toEqual(
			{
				ok: false,
				reason: 'missing'
			}
		);
		expect(await goalSavedMinor(db, other.scope.spaceId, theirs)).toBe(0);
	});
});

describe('updateGoal, archiveGoal, restoreGoal', () => {
	it('a second tab’s stale edit is refused; the first stays', async () => {
		const p = await account();
		const id = await goal(p.scope);
		const loaded = (await getGoal(db, p.scope.spaceId, id))!;
		expect(
			await updateGoal(
				db,
				p.scope,
				id,
				{ name: 'Tab satu', targetAmountMinor: 1 },
				loaded.updatedAt,
				NOW
			)
		).toBe('ok');
		expect(
			await updateGoal(
				db,
				p.scope,
				id,
				{ name: 'Tab dua', targetAmountMinor: 2 },
				loaded.updatedAt,
				NOW
			)
		).toBe('stale');
		const after = (await getGoal(db, p.scope.spaceId, id))!;
		expect(after).toMatchObject({ name: 'Tab satu', targetAmountMinor: 1 });
		expect(after.updatedAt).toBeGreaterThan(loaded.updatedAt);
	});

	it('archive keeps the contribution log; restore brings back the same progress', async () => {
		const p = await account();
		const id = await goal(p.scope, 1_000_000_00);
		await give(p.scope, id, 250_000_00);
		await give(p.scope, id, 50_000_00);
		const before = (await getGoal(db, p.scope.spaceId, id))!;
		expect(await archiveGoal(db, p.scope, id, before.updatedAt, NOW + 5)).toBe('ok');
		expect(await listGoals(db, p.scope.spaceId)).toEqual([]);
		expect(await getGoal(db, p.scope.spaceId, id)).toBeNull();
		const live = await d1
			.prepare(
				'select count(*) as n from goal_contributions where goal_id = ? and deleted_at is null'
			)
			.bind(id)
			.first<{ n: number }>();
		expect(live!.n).toBe(2);
		// An archived goal is read-only.
		expect(await addContribution(db, p.scope, id, { amountMinor: 1, note: null }, NOW)).toEqual({
			ok: false,
			reason: 'archived'
		});
		const archived = (await getGoal(db, p.scope.spaceId, id, { includeArchived: true }))!;
		expect(archived).toMatchObject({ archived: true, savedMinor: 300_000_00, percent: 30 });
		expect(await restoreGoal(db, p.scope, id, archived.updatedAt, NOW + 6)).toBe('ok');
		const restored = (await getGoal(db, p.scope.spaceId, id))!;
		expect(restored).toMatchObject({ archived: false, savedMinor: 300_000_00, percent: 30 });
	});

	it('another space’s goal is missing for every write', async () => {
		const p = await account();
		const other = await account();
		const theirs = await goal(other.scope);
		const g = (await getGoal(db, other.scope.spaceId, theirs))!;
		const input = { name: 'Diambil', targetAmountMinor: 1 };
		expect(await updateGoal(db, p.scope, theirs, input, g.updatedAt, NOW)).toBe('missing');
		expect(await archiveGoal(db, p.scope, theirs, g.updatedAt, NOW)).toBe('missing');
		expect(await restoreGoal(db, p.scope, theirs, g.updatedAt, NOW)).toBe('missing');
		expect((await getGoal(db, other.scope.spaceId, theirs))!.name).toBe('Liburan');
	});

	it('a removed member’s writes change nothing', async () => {
		const s = await sharedSpace();
		const id = await goal(s.memberScope);
		await give(s.memberScope, id, 100);
		const row = (await listMembers(db, s.spaceId, s.owner.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId: s.spaceId, actorUserId: s.owner.id, memberId: row.id }, NOW);
		const g = (await getGoal(db, s.spaceId, id))!;
		expect(await createGoal(db, s.memberScope, { name: 'X', targetAmountMinor: 1 }, NOW)).toEqual({
			ok: false,
			reason: 'gone'
		});
		expect(
			await addContribution(db, s.memberScope, id, { amountMinor: 1, note: null }, NOW)
		).toEqual({ ok: false, reason: 'missing' });
		const [c] = (await listContributions(db, s.spaceId, id)).rows;
		expect(await deleteContribution(db, s.memberScope, id, c!.id, NOW)).toBe('missing');
		expect(await archiveGoal(db, s.memberScope, id, g.updatedAt, NOW)).toBe('stale');
		expect(await goalSavedMinor(db, s.spaceId, id)).toBe(100);
	});
});

describe('contribution tombstone CHECK (D1 directly)', () => {
	const insert = (spaceId: string, goalId: string, cols: Record<string, unknown>) => {
		const row = {
			id: crypto.randomUUID(),
			space_id: spaceId,
			goal_id: goalId,
			updated_at: NOW,
			seq: 0,
			...cols
		};
		const names = Object.keys(row);
		return d1
			.prepare(
				`insert into goal_contributions (${names.join(', ')}) values (${names.map(() => '?').join(', ')})`
			)
			.bind(...Object.values(row))
			.run();
	};

	it('a live row must carry its amount and time; a deleted row must carry none of its content', async () => {
		const p = await account();
		const id = await goal(p.scope);
		const live = { amount_minor: 100, created_at: NOW, created_by_user_id: p.id, note: 'x' };
		await expect(insert(p.scope.spaceId, id, live)).resolves.toBeTruthy();
		await expect(insert(p.scope.spaceId, id, { ...live, amount_minor: null })).rejects.toThrow(
			/CHECK/
		);
		await expect(insert(p.scope.spaceId, id, { ...live, created_at: null })).rejects.toThrow(
			/CHECK/
		);
		await expect(insert(p.scope.spaceId, id, { ...live, amount_minor: 0 })).rejects.toThrow(
			/CHECK/
		);
		await expect(insert(p.scope.spaceId, id, { deleted_at: NOW })).resolves.toBeTruthy();
		for (const kept of [
			{ amount_minor: 100 },
			{ note: 'x' },
			{ created_by_user_id: p.id },
			{ created_at: NOW }
		])
			await expect(insert(p.scope.spaceId, id, { deleted_at: NOW, ...kept })).rejects.toThrow(
				/CHECK/
			);
	});
});

describe('contribution cap per goal', () => {
	it(`holds ${MAX_CONTRIBUTIONS_PER_GOAL} live rows exactly under 10 concurrent adds; deleted rows do not count`, async () => {
		const p = await account();
		const id = await goal(p.scope);
		const other = await goal(p.scope);
		// Seed up to 5 below the cap in one statement (fast), all 1 sen.
		await d1
			.prepare(
				`with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
				 insert into goal_contributions (id, space_id, goal_id, amount_minor, created_at, updated_at, seq)
				 select lower(hex(randomblob(16))), ?, ?, 1, ?, ?, 0 from n`
			)
			.bind(MAX_CONTRIBUTIONS_PER_GOAL - 5, p.scope.spaceId, id, NOW, NOW)
			.run();
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				addContribution(db, p.scope, id, { amountMinor: 1, note: null }, NOW + 1)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(5);
		expect(results.filter((r) => !r.ok && r.reason === 'limit')).toHaveLength(5);
		expect(await goalSavedMinor(db, p.scope.spaceId, id)).toBe(MAX_CONTRIBUTIONS_PER_GOAL);
		// Another goal of the same space is not affected.
		expect(
			(await addContribution(db, p.scope, other, { amountMinor: 1, note: null }, NOW)).ok
		).toBe(true);
		// Deleting one frees one place.
		const [newest] = (await listContributions(db, p.scope.spaceId, id, { limit: 1 })).rows;
		expect(await deleteContribution(db, p.scope, id, newest!.id, NOW + 2)).toBe('ok');
		expect(
			(await addContribution(db, p.scope, id, { amountMinor: 1, note: null }, NOW + 3)).ok
		).toBe(true);
		expect(await addContribution(db, p.scope, id, { amountMinor: 1, note: null }, NOW + 4)).toEqual(
			{
				ok: false,
				reason: 'limit'
			}
		);
	});
});

describe('listContributions', () => {
	it('pages newest first with a cursor and names who added each one', async () => {
		const s = await sharedSpace();
		const id = await goal(s.ownerScope);
		for (let i = 0; i < 5; i++)
			await addContribution(
				db,
				i % 2 ? s.memberScope : s.ownerScope,
				id,
				{ amountMinor: (i + 1) * 100, note: `n${i}` },
				NOW + i
			);
		const first = await listContributions(db, s.spaceId, id, { limit: 2 });
		expect(first.rows.map((r) => r.amountMinor)).toEqual([500, 400]);
		expect(first.rows.map((r) => r.author)).toEqual(['Pemilik', 'Anggota']);
		expect(first.more).toBe(true);
		const last = first.rows.at(-1)!;
		const next = await listContributions(db, s.spaceId, id, {
			limit: 2,
			cursor: { createdAt: last.createdAt, id: last.id }
		});
		expect(next.rows.map((r) => r.amountMinor)).toEqual([300, 200]);
		const end = await listContributions(db, s.spaceId, id, {
			limit: 2,
			cursor: { createdAt: next.rows[1]!.createdAt, id: next.rows[1]!.id }
		});
		expect(end).toMatchObject({ more: false });
		expect(end.rows.map((r) => r.amountMinor)).toEqual([100]);
	});

	it('lists nothing for another space’s goal', async () => {
		const p = await account();
		const other = await account();
		const theirs = await goal(other.scope);
		await give(other.scope, theirs, 100);
		expect(await listContributions(db, p.scope.spaceId, theirs)).toEqual({ rows: [], more: false });
	});
});

describe('space and account deletion', () => {
	const rowsOf = async (table: string, spaceId: string) =>
		(await d1
			.prepare(`select count(*) as n from ${table} where space_id = ?`)
			.bind(spaceId)
			.first<{ n: number }>())!.n;

	it('purgeSpaces removes the space’s goals and contributions (archived ones too) and nothing else', async () => {
		const p = await account();
		const other = await account();
		const a = await goal(p.scope);
		const b = await goal(p.scope);
		await give(p.scope, a, 100);
		await give(p.scope, b, 100);
		const gb = (await getGoal(db, p.scope.spaceId, b))!;
		await archiveGoal(db, p.scope, b, gb.updatedAt, NOW + 1);
		const theirs = await goal(other.scope);
		await give(other.scope, theirs, 100);
		await db.batch(purgeSpaces(db, sql`select ${p.scope.spaceId}`, () => sql`1`) as never);
		expect(await rowsOf('goals', p.scope.spaceId)).toBe(0);
		expect(await rowsOf('goal_contributions', p.scope.spaceId)).toBe(0);
		expect(await rowsOf('goals', other.scope.spaceId)).toBe(1);
		expect(await rowsOf('goal_contributions', other.scope.spaceId)).toBe(1);
	});

	it('deleting a member’s account keeps their contribution in the shared space, without their name', async () => {
		const s = await sharedSpace();
		const id = await goal(s.ownerScope);
		await give(s.memberScope, id, 7_500_00);
		const proof = await signInWithPassword(db, s.member.email, PASSWORD, NOW);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, s.member.id, proof.hash, NOW)).toBe(true);
		const [c] = (await listContributions(db, s.spaceId, id)).rows;
		expect(c).toMatchObject({ amountMinor: 7_500_00, author: null });
		expect(await goalSavedMinor(db, s.spaceId, id)).toBe(7_500_00);
	});

	it('deleting the account deletes its personal space’s goals', async () => {
		const p = await account();
		const id = await goal(p.scope);
		await give(p.scope, id, 100);
		const proof = await signInWithPassword(db, p.email, PASSWORD, NOW);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, p.id, proof.hash, NOW)).toBe(true);
		expect(await rowsOf('goals', p.scope.spaceId)).toBe(0);
		expect(await rowsOf('goal_contributions', p.scope.spaceId)).toBe(0);
	});
});
