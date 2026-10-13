import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import {
	AMOUNT_INVALID,
	CONTRIBUTION_LIMIT,
	CONTRIBUTION_NOT_FOUND,
	GOAL_CHANGED,
	GOAL_LIMIT,
	GOAL_NAME_INVALID,
	GOAL_NOT_FOUND,
	GOALS_LOAD_FAILED,
	TARGET_INVALID
} from '#lib/server/goals/messages';
import { MAX_GOALS_PER_SPACE } from '#lib/server/goals/repo';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
// Lets one test make the goal list fail as if D1 were unavailable.
const failList = { on: false };
vi.mock('#lib/server/goals/repo', async (original) => {
	const real = await original<typeof import('#lib/server/goals/repo')>();
	return {
		...real,
		listGoals: (...args: Parameters<typeof real.listGoals>) => {
			if (failList.on) throw new Error('D1_ERROR: no such table');
			return real.listGoals(...args);
		}
	};
});

const kekayaan = await import('../../src/routes/(app)/dompet/+page.server');
const detail = await import('../../src/routes/(app)/kekayaan/tabungan/[id]/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

type Action = (event: never) => unknown;

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
	const email = `tabungan-rute${++n}@contoh.id`;
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
	opts: {
		path: string;
		routeId: string;
		params?: Record<string, string>;
		form?: Record<string, string>;
		spaceCookie?: string;
		headers?: Record<string, string>;
	}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	return fakeEvent({
		url: `http://localhost${opts.path}`,
		routeId: opts.routeId,
		db,
		user: who?.user ?? null,
		space,
		form: opts.form,
		headers: opts.headers,
		params: opts.params
	}).event as never;
}

const LIST = { routeId: '/(app)/dompet' };
const DETAIL = { routeId: '/(app)/kekayaan/tabungan/[id]' };

const loadList = async (who: Person | null, path = '/dompet', spaceCookie?: string) =>
	run(async () => kekayaan.load(await ev(who, { ...LIST, path, spaceCookie })));
const createGoal = async (who: Person, form: Record<string, string>, spaceCookie?: string) =>
	run(async () =>
		(kekayaan.actions as Record<string, Action>).createGoal!(
			await ev(who, { ...LIST, path: '/dompet', form, spaceCookie })
		)
	);
const loadGoal = async (who: Person | null, id: string, query = '', spaceCookie?: string) =>
	run(async () =>
		detail.load(
			await ev(who, {
				...DETAIL,
				path: `/kekayaan/tabungan/${id}${query}`,
				params: { id },
				spaceCookie
			})
		)
	);
const act = async (
	who: Person,
	name: string,
	id: string,
	form: Record<string, string>,
	spaceCookie?: string,
	headers?: Record<string, string>
) =>
	run(async () =>
		(detail.actions as Record<string, Action>)[name]!(
			await ev(who, {
				...DETAIL,
				path: `/kekayaan/tabungan/${id}`,
				params: { id },
				form,
				spaceCookie,
				headers
			})
		)
	);

interface LoadedGoal {
	id: string;
	name: string;
	updatedAt: number;
	savedMinor: number;
	targetAmountMinor: number;
	percent: number;
	archived: boolean;
}
async function goalsOf(who: Person, path = '/dompet', spaceCookie?: string) {
	const r = await loadList(who, path, spaceCookie);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.goals as LoadedGoal[];
}
async function goalPage(who: Person, id: string, query = '', spaceCookie?: string) {
	const r = await loadGoal(who, id, query, spaceCookie);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value as {
		goal: LoadedGoal;
		contributions: { id: string; amountMinor: number; note: string | null }[];
		more: boolean;
		open: string | null;
	};
}
async function newGoal(who: Person, name = 'Liburan', target = '1.250.000', spaceCookie?: string) {
	const r = await createGoal(who, { name, target }, spaceCookie);
	if (r.kind !== 'ok') throw new Error(`create failed: ${JSON.stringify(r)}`);
	const goals = await goalsOf(who, '/dompet', spaceCookie);
	return goals.find((g) => g.name === name)!;
}
const count = async (table: string) =>
	(await d1.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())!.n;

describe('/dompet Tabungan section', () => {
	it('an account without goals gets an empty list next to its wallets', async () => {
		const p = await person();
		expect(await loadList(p)).toMatchObject({
			kind: 'ok',
			value: { goals: [], goalsError: null, openGoal: false, wallets: [], loadError: null }
		});
		expect(await loadList(p, '/dompet?target=baru')).toMatchObject({ value: { openGoal: true } });
	});

	it('a failing goal read becomes the section’s error state; the wallets still load', async () => {
		const p = await person();
		failList.on = true;
		try {
			expect(await loadList(p)).toMatchObject({
				kind: 'ok',
				value: { goals: [], goalsError: GOALS_LOAD_FAILED, loadError: null }
			});
		} finally {
			failList.on = false;
		}
	});

	it('createGoal saves; the reload shows Rp 0 of the target at 0 %', async () => {
		const p = await person();
		expect(await createGoal(p, { name: 'Liburan', target: '1.250.000' })).toEqual({
			kind: 'ok',
			value: { goalSaved: 'created' }
		});
		expect(await goalsOf(p)).toMatchObject([
			{
				name: 'Liburan',
				targetAmountMinor: 125_000_000,
				savedMinor: 0,
				percent: 0,
				archived: false
			}
		]);
	});

	it('refuses bad fields with field errors and writes nothing', async () => {
		const p = await person();
		const before = await count('goals');
		for (const [name, target] of [
			['​\u0000', '1.000'],
			['a'.repeat(61), '1.000'],
			['Ok', ''],
			['Ok', '0'],
			['Ok', '-5000'],
			['Ok', '12,50'],
			['Ok', 'abc']
		] as const) {
			const errors =
				name === 'Ok' ? { targetAmountMinor: TARGET_INVALID } : { name: GOAL_NAME_INVALID };
			expect(await createGoal(p, { name, target })).toEqual({
				kind: 'fail',
				status: 400,
				data: { goalAction: 'create', goalErrors: errors, goalValues: { name, target } }
			});
		}
		expect(await count('goals')).toBe(before);
	});

	it('answers 400 to a 20 KB body and 415 to a non-form body, never 500', async () => {
		const p = await person();
		const before = await count('goals');
		expect(await createGoal(p, { name: 'x'.repeat(20 * 1024), target: '1' })).toMatchObject({
			kind: 'error',
			status: 400
		});
		const plain = await run(async () =>
			(kekayaan.actions as Record<string, Action>).createGoal!(
				await ev(p, {
					...LIST,
					path: '/dompet',
					form: { name: 'A', target: '1' },
					headers: { 'content-type': 'text/plain' }
				})
			)
		);
		expect(plain).toMatchObject({ kind: 'error', status: 415 });
		expect(await count('goals')).toBe(before);
	});

	it('the 51st goal is refused with the cap message', async () => {
		const p = await person();
		for (let i = 0; i < MAX_GOALS_PER_SPACE; i++)
			expect(await createGoal(p, { name: `T${i}`, target: '1' })).toMatchObject({ kind: 'ok' });
		expect(await createGoal(p, { name: 'Lebih', target: '1' })).toEqual({
			kind: 'fail',
			status: 409,
			data: { goalError: GOAL_LIMIT }
		});
		expect(await goalsOf(p)).toHaveLength(MAX_GOALS_PER_SPACE);
	});
});

describe('/kekayaan/tabungan/[id]', () => {
	it('contributions raise the progress only after the write; deleting one lowers it', async () => {
		const p = await person();
		const g = await newGoal(p, 'Laptop', '1.000.000');
		expect(await act(p, 'addContribution', g.id, { amount: '250.000', note: 'gaji' })).toEqual({
			kind: 'ok',
			value: { saved: 'contributed' }
		});
		await act(p, 'addContribution', g.id, { amount: '50000' });
		let page = await goalPage(p, g.id);
		expect(page.goal).toMatchObject({ savedMinor: 30_000_000, percent: 30 });
		expect(page.contributions.map((c) => [c.amountMinor, c.note])).toEqual([
			[5_000_000, null],
			[25_000_000, 'gaji']
		]);
		// The list row on /kekayaan shows the same figure.
		expect((await goalsOf(p))[0]).toMatchObject({ savedMinor: 30_000_000, percent: 30 });
		const big = page.contributions.find((c) => c.amountMinor === 25_000_000)!;
		expect(await act(p, 'deleteContribution', g.id, { contributionId: big.id })).toEqual({
			kind: 'ok',
			value: { saved: 'deleted' }
		});
		page = await goalPage(p, g.id);
		expect(page.goal).toMatchObject({ savedMinor: 5_000_000, percent: 5 });
		expect(page.contributions).toHaveLength(1);
		// Totals reconcile: the /kekayaan row equals the detail page and the list it links to.
		expect((await goalsOf(p))[0]).toMatchObject({ savedMinor: 5_000_000, percent: 5 });
	});

	it('answers the per-goal contribution cap with its message', async () => {
		const p = await person();
		const g = await newGoal(p);
		const spaceId = (await resolveCurrentSpace(db, p.user.id, undefined))!.id;
		await d1
			.prepare(
				`with recursive n(i) as (select 1 union all select i + 1 from n where i < 10000)
				 insert into goal_contributions (id, space_id, goal_id, amount_minor, created_at, updated_at, seq)
				 select lower(hex(randomblob(16))), ?, ?, 1, 1, 1, 0 from n`
			)
			.bind(spaceId, g.id)
			.run();
		expect(await act(p, 'addContribution', g.id, { amount: '1' })).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: CONTRIBUTION_LIMIT }
		});
	});

	it('refuses zero, blank, negative and decimal amounts, writing nothing', async () => {
		const p = await person();
		const g = await newGoal(p);
		const before = await count('goal_contributions');
		for (const amount of ['', '0', '-25.000', '25.000,50', 'x'])
			expect(await act(p, 'addContribution', g.id, { amount })).toMatchObject({
				kind: 'fail',
				status: 400,
				data: { action: 'contribute', errors: { amountMinor: AMOUNT_INVALID } }
			});
		expect(await count('goal_contributions')).toBe(before);
	});

	it('20 concurrent contributions through the action: all 200, sum exact', async () => {
		const p = await person();
		const g = await newGoal(p, 'Rumah', '100.000.000');
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				act(p, 'addContribution', g.id, { amount: String((i + 1) * 1000) })
			)
		);
		expect(results.every((r) => r.kind === 'ok')).toBe(true);
		expect((await goalPage(p, g.id)).goal.savedMinor).toBe(210 * 1000 * 100);
	});

	it('a second tab’s stale edit gets "changed meanwhile"; a malformed updatedAt never matches', async () => {
		const p = await person();
		const g = await newGoal(p);
		const form = (name: string) => ({ name, target: '2.000.000', updatedAt: String(g.updatedAt) });
		expect(await act(p, 'updateGoal', g.id, form('Tab satu'))).toEqual({
			kind: 'ok',
			value: { saved: 'updated' }
		});
		expect(await act(p, 'updateGoal', g.id, form('Tab dua'))).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: GOAL_CHANGED }
		});
		for (const updatedAt of ['', 'abc', '1e3', '-1', '9'.repeat(40)])
			expect(await act(p, 'updateGoal', g.id, { name: 'X', target: '1', updatedAt })).toMatchObject(
				{ kind: 'fail', status: 409 }
			);
		expect((await goalPage(p, g.id)).goal).toMatchObject({
			name: 'Tab satu',
			targetAmountMinor: 200_000_000
		});
	});

	it('archive hides the goal from the list but keeps its page, read-only; restore brings the same progress', async () => {
		const p = await person();
		const g = await newGoal(p, 'Motor', '10.000.000');
		await act(p, 'addContribution', g.id, { amount: '2.500.000' });
		const loaded = (await goalPage(p, g.id)).goal;
		expect(await act(p, 'archiveGoal', g.id, { updatedAt: String(loaded.updatedAt) })).toEqual({
			kind: 'ok',
			value: { saved: 'archived' }
		});
		expect(await goalsOf(p)).toEqual([]);
		const archivedList = await goalsOf(p, '/dompet?arsip=1');
		expect(archivedList).toMatchObject([{ id: g.id, archived: true, percent: 25 }]);
		const archived = await goalPage(p, g.id, '?tambah=1');
		expect(archived).toMatchObject({ goal: { archived: true, percent: 25 }, open: null });
		expect(await act(p, 'addContribution', g.id, { amount: '1' })).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: GOAL_CHANGED }
		});
		expect(
			await act(p, 'deleteContribution', g.id, { contributionId: archived.contributions[0]!.id })
		).toEqual({ kind: 'fail', status: 404, data: { error: CONTRIBUTION_NOT_FOUND } });
		expect(
			await act(p, 'restoreGoal', g.id, { updatedAt: String(archived.goal.updatedAt) })
		).toEqual({ kind: 'ok', value: { saved: 'restored' } });
		expect((await goalsOf(p))[0]).toMatchObject({ id: g.id, savedMinor: 250_000_000, percent: 25 });
	});

	it('opens the forms from the URL for the no-JavaScript path', async () => {
		const p = await person();
		const g = await newGoal(p);
		expect((await goalPage(p, g.id, '?ubah=1')).open).toBe('edit');
		expect((await goalPage(p, g.id, '?tambah=1')).open).toBe('contribute');
	});

	it('pages the history with ?sebelum and ignores a malformed cursor', async () => {
		const p = await person();
		const g = await newGoal(p);
		for (let i = 0; i < 52; i++) await act(p, 'addContribution', g.id, { amount: '1' });
		const first = await goalPage(p, g.id);
		expect(first.contributions).toHaveLength(50);
		expect(first.more).toBe(true);
		const last = first.contributions.at(-1)! as { id: string; createdAt?: number };
		const raw = await d1
			.prepare('select created_at from goal_contributions where id = ?')
			.bind(last.id)
			.first<{ created_at: number }>();
		const next = await goalPage(p, g.id, `?sebelum=${raw!.created_at}_${last.id}`);
		expect(next.contributions).toHaveLength(2);
		expect(next.more).toBe(false);
		expect((await goalPage(p, g.id, '?sebelum=%27%20or%201=1')).contributions).toHaveLength(50);
		// The saved figure is the SQL sum over all 52, not the shown page.
		expect(first.goal.savedMinor).toBe(52 * 100);
	});
});

describe('one access rule', () => {
	async function sharedWithGoal() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const goal = await newGoal(owner, 'Umrah', '50.000.000', spaceId);
		await act(owner, 'addContribution', goal.id, { amount: '1.000.000' }, spaceId);
		const page = await goalPage(owner, goal.id, '', spaceId);
		return { owner, member, spaceId, goal: page.goal, contribution: page.contributions[0]! };
	}

	it('a member sees and adds to the shared space’s goals', async () => {
		const { member, spaceId, goal } = await sharedWithGoal();
		expect((await goalsOf(member, '/dompet', spaceId)).map((g) => g.id)).toEqual([goal.id]);
		expect(
			await act(member, 'addContribution', goal.id, { amount: '500.000' }, spaceId)
		).toMatchObject({ kind: 'ok' });
		expect((await goalPage(member, goal.id, '', spaceId)).goal.savedMinor).toBe(150_000_000);
	});

	it('a non-member and a removed member get the unknown-id answer on the page and every action', async () => {
		const { owner, member, spaceId, goal, contribution } = await sharedWithGoal();
		const stranger = await person();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		const snapshot = async () =>
			JSON.stringify([
				(await d1.prepare('select * from goals where space_id = ?').bind(spaceId).all()).results,
				(
					await d1
						.prepare('select * from goal_contributions where space_id = ?')
						.bind(spaceId)
						.all()
				).results
			]);
		const before = await snapshot();
		const unknown = crypto.randomUUID();
		const forms = (cid: string) => ({
			addContribution: { amount: '1' },
			deleteContribution: { contributionId: cid },
			updateGoal: { name: 'Diambil', target: '1', updatedAt: String(goal.updatedAt) },
			archiveGoal: { updatedAt: String(goal.updatedAt) },
			restoreGoal: { updatedAt: String(goal.updatedAt) }
		});
		for (const who of [stranger, member]) {
			// Even naming the shared space in the cookie: it is re-validated and falls back to their own space.
			expect((await goalsOf(who, '/dompet?arsip=1', spaceId)).map((g) => g.id)).not.toContain(
				goal.id
			);
			const theirs = await loadGoal(who, goal.id, '', spaceId);
			const missing = await loadGoal(who, unknown, '', spaceId);
			expect(theirs).toEqual({
				kind: 'error',
				status: 404,
				body: { message: 'Not found', status: 404 }
			});
			expect(missing).toEqual(theirs);
			for (const [name, form] of Object.entries(forms(contribution.id))) {
				const a = await act(who, name, goal.id, form, spaceId);
				const b = await act(
					who,
					name,
					unknown,
					forms(crypto.randomUUID())[name as 'archiveGoal'],
					spaceId
				);
				expect(a).toEqual({
					kind: 'fail',
					status: 404,
					data: {
						error: name === 'deleteContribution' ? CONTRIBUTION_NOT_FOUND : GOAL_NOT_FOUND
					}
				});
				expect(b).toEqual(a);
			}
		}
		expect(await snapshot()).toBe(before);
	});

	it('a contribution id of another goal in the same space is refused like an unknown one', async () => {
		const { owner, spaceId, contribution } = await sharedWithGoal();
		const other = await newGoal(owner, 'Lain', '1.000', spaceId);
		const r = await act(
			owner,
			'deleteContribution',
			other.id,
			{ contributionId: contribution.id },
			spaceId
		);
		const u = await act(
			owner,
			'deleteContribution',
			other.id,
			{ contributionId: crypto.randomUUID() },
			spaceId
		);
		expect(r).toEqual({ kind: 'fail', status: 404, data: { error: CONTRIBUTION_NOT_FOUND } });
		expect(u).toEqual(r);
	});

	it('a stale current space (membership removed after the request resolved it) gets the helper’s 404', async () => {
		const { owner, member, spaceId, goal } = await sharedWithGoal();
		const stale = await resolveCurrentSpace(db, member.user.id, spaceId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		const event = (form?: Record<string, string>) =>
			fakeEvent({
				url: `http://localhost/kekayaan/tabungan/${goal.id}`,
				routeId: DETAIL.routeId,
				db,
				user: member.user,
				space: stale,
				params: { id: goal.id },
				form
			}).event as never;
		expect(await run(() => detail.load(event()))).toMatchObject({ kind: 'error', status: 404 });
		expect(
			await run(() =>
				(detail.actions as Record<string, Action>).addContribution!(event({ amount: '1' }))
			)
		).toMatchObject({ kind: 'error', status: 404 });
	});

	it('a signed-out visitor is sent to /masuk', async () => {
		expect(await loadGoal(null, crypto.randomUUID())).toMatchObject({
			kind: 'redirect',
			status: 303,
			location: '/masuk'
		});
	});

	it('user-facing answers never carry an id', async () => {
		const { owner, spaceId, goal, contribution } = await sharedWithGoal();
		const r = await act(
			owner,
			'deleteContribution',
			goal.id,
			{ contributionId: 'x'.repeat(100) },
			spaceId
		);
		expect(r).toMatchObject({ kind: 'fail', status: 404 });
		expect(JSON.stringify(r)).not.toContain(goal.id);
		expect(JSON.stringify(r)).not.toContain(contribution.id);
		expect(JSON.stringify(r)).not.toContain('xxxx');
	});
});
