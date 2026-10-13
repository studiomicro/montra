import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import type { AnggaranFigures } from '#lib/server/budgets/anggaran';
import { setCategoryBudget } from '#lib/server/budgets/category-repo';
import { BUDGET_CHANGED, BUDGET_CURRENCY_INVALID } from '#lib/server/budgets/messages';
import { CATEGORY_NOT_FOUND } from '#lib/server/categories/messages';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { categories } from '#lib/server/db/schema';
import { SPACE_JSON_TABLES, tablePages } from '#lib/server/export/tables';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import {
	createSharedSpace,
	listMembers,
	purgeSpaces,
	removeMember
} from '#lib/server/spaces/spaces';
import { bumpSpaceSeq, currentSpaceSeq } from '#lib/server/sync/seq';
import { createTransaction } from '#lib/server/transactions/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const anggaran = await import('../../src/routes/(app)/anggaran/+page.server');
const beranda = await import('../../src/routes/(app)/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = 1_800_000_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

type Handler = (event: never) => unknown;

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
	const email = `anggaran${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const scope: SpaceScope = { spaceId: personal, userId: r.userId };
	return { user: { id: r.userId, email, name, createdAt: 0 }, scope };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An /anggaran event; `stale` is a current space resolved earlier (a membership removed since). */
async function ev(
	who: Person | null,
	opts: {
		form?: Record<string, string>;
		url?: string;
		space?: string;
		stale?: App.Locals['space'];
		routeId?: string;
	} = {}
) {
	const space = opts.stale ?? (who ? await resolveCurrentSpace(db, who.user.id, opts.space) : null);
	return fakeEvent({
		url: `http://localhost${opts.url ?? '/anggaran'}`,
		routeId: opts.routeId ?? '/(app)/anggaran',
		db,
		user: who?.user ?? null,
		space,
		form: opts.form
	}).event as never;
}

const load = (who: Person | null, opts: Parameters<typeof ev>[1] = {}) =>
	run(async () => anggaran.load(await ev(who, opts)));
async function summaryOf(who: Person, space?: string): Promise<AnggaranFigures> {
	const r = await load(who, { space });
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.summary as AnggaranFigures;
}
const action = async (
	who: Person,
	name: 'setBudget' | 'deleteBudget' | 'setCategoryBudget' | 'deleteCategoryBudget',
	form: Record<string, string>,
	opts: { space?: string; stale?: App.Locals['space'] } = {}
) =>
	run(async () =>
		(anggaran.actions as Record<string, Handler>)[name]!(await ev(who, { form, ...opts }))
	);

const categoryRows = async (spaceId: string) =>
	(
		await d1
			.prepare(
				'select category_id, amount_minor, deleted_at from category_budgets where space_id = ?'
			)
			.bind(spaceId)
			.all<{ category_id: string; amount_minor: number; deleted_at: number | null }>()
	).results;

async function categoryId(scope: SpaceScope, tile: string) {
	await ensurePresetCategories(db, scope.spaceId, NOW);
	return (await listCategories(db, scope.spaceId)).find((c) => c.tileKey === tile)!.id;
}

async function spend(scope: SpaceScope, category: string, amountMinor: number) {
	const w = await createWallet(
		db,
		scope,
		{
			name: `W${++n}`,
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: false,
			lastFour: null
		},
		NOW
	);
	if (!w.ok) throw new Error('wallet failed');
	const r = await createTransaction(
		db,
		scope,
		{
			type: 'expense',
			amountMinor,
			currency: 'IDR',
			walletId: w.id,
			transferToWalletId: null,
			categoryId: category,
			title: 'Makan',
			note: null,
			occurredOn: wibTodayString(),
			occurredTime: null
		},
		NOW
	);
	if (!r.ok) throw new Error('tx failed');
}

async function sharedSpace() {
	const owner = await person('Pemilik');
	const member = await person('Anggota');
	const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
	const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
	await acceptInvite(db, invite.token, member.user.id, NOW);
	return { owner, member, spaceId };
}

describe('/anggaran load', () => {
	it('sends a signed-out visitor to /masuk', async () => {
		expect(await load(null)).toMatchObject({ kind: 'redirect', status: 303, location: '/masuk' });
	});

	it('an empty space: no budget, every preset expense category listed without one', async () => {
		const p = await person();
		const s = await summaryOf(p);
		expect(s).toMatchObject({ budget: null, total: null, categories: [], currency: 'IDR' });
		const expense = (await listCategories(db, p.scope.spaceId)).filter((c) => c.kind === 'expense');
		expect(s.unbudgeted.map((c) => c.categoryId)).toEqual(expense.map((c) => c.id));
		expect(s.unbudgeted.every((c) => c.spentMinor === 0)).toBe(true);
	});

	it('opens a form from the URL: ?ubah=bulanan and a capped ?kategori=', async () => {
		const p = await person();
		expect(await load(p, { url: '/anggaran?ubah=bulanan' })).toMatchObject({
			value: { open: 'total' }
		});
		const long = 'x'.repeat(200);
		const r = await load(p, { url: `/anggaran?kategori=${long}` });
		if (r.kind !== 'ok') throw new Error('load failed');
		expect(r.value.open).toHaveLength(64);
	});

	it('the total reconciles with Beranda: same spending, same safe-to-spend', async () => {
		const p = await person();
		const makan = await categoryId(p.scope, 'makan');
		await spend(p.scope, makan, 1_530_000_00);
		expect(
			await action(p, 'setBudget', { amount: '6.500.000', currency: 'IDR', updatedAt: '' })
		).toMatchObject({ kind: 'ok', value: { saved: 'set' } });
		const s = await summaryOf(p);
		const b = await run(async () => beranda.load(await ev(p, { url: '/', routeId: '/(app)' })));
		if (b.kind !== 'ok') throw new Error('beranda load failed');
		const home = b.value.summary as { spentMinor: number; safeToSpend: unknown };
		expect(s.total?.spentMinor).toBe(home.spentMinor);
		expect(s.safeToSpend).toEqual(home.safeToSpend);
		expect(s.unbudgeted[0]).toMatchObject({ categoryId: makan, spentMinor: 1_530_000_00 });
	});
});

describe('category budgets', () => {
	it('set, show with progress, update, a stale form, remove, and set again on the same row', async () => {
		const p = await person();
		const makan = await categoryId(p.scope, 'makan');
		await spend(p.scope, makan, 836_000_00);
		const set = await action(p, 'setCategoryBudget', {
			categoryId: makan,
			amount: '1.200.000',
			currency: 'IDR',
			updatedAt: ''
		});
		expect(set).toMatchObject({ kind: 'ok', value: { saved: 'categorySet' } });
		let s = await summaryOf(p);
		expect(s.categories).toHaveLength(1);
		expect(s.categories[0]).toMatchObject({
			categoryId: makan,
			budget: { amountMinor: 1_200_000_00 },
			progress: { spentMinor: 836_000_00, remainingMinor: 364_000_00 }
		});
		expect(s.unbudgeted.map((c) => c.categoryId)).not.toContain(makan);

		const updatedAt = String(s.categories[0]!.budget.updatedAt);
		expect(
			await action(p, 'setCategoryBudget', {
				categoryId: makan,
				amount: '800.000',
				currency: 'IDR',
				updatedAt
			})
		).toMatchObject({ kind: 'ok' });
		s = await summaryOf(p);
		expect(s.categories[0]!.progress).toMatchObject({ remainingMinor: -36_000_00, state: 'over' });

		// The first form's version is stale now: "changed meanwhile", nothing written.
		expect(
			await action(p, 'setCategoryBudget', {
				categoryId: makan,
				amount: '5',
				currency: 'IDR',
				updatedAt
			})
		).toMatchObject({ kind: 'fail', status: 409, data: { error: BUDGET_CHANGED } });
		expect(await action(p, 'deleteCategoryBudget', { categoryId: makan, updatedAt })).toMatchObject(
			{ kind: 'fail', status: 409 }
		);

		const fresh = String(s.categories[0]!.budget.updatedAt);
		expect(
			await action(p, 'deleteCategoryBudget', { categoryId: makan, updatedAt: fresh })
		).toMatchObject({ kind: 'ok', value: { saved: 'categoryDeleted' } });
		expect((await summaryOf(p)).categories).toEqual([]);
		expect(await categoryRows(p.scope.spaceId)).toEqual([
			{ category_id: makan, amount_minor: 0, deleted_at: expect.any(Number) }
		]);

		await action(p, 'setCategoryBudget', {
			categoryId: makan,
			amount: '100.000',
			currency: 'IDR',
			updatedAt: ''
		});
		expect(await categoryRows(p.scope.spaceId)).toEqual([
			{ category_id: makan, amount_minor: 100_000_00, deleted_at: null }
		]);
	});

	it('refuses an unknown, income, or another space’s category, and a currency the space does not hold', async () => {
		const a = await person();
		const b = await person();
		const theirs = await categoryId(b.scope, 'makan');
		const gaji = await categoryId(a.scope, 'gaji');
		for (const id of [theirs, gaji, 'nope', 'x'.repeat(100)])
			expect(
				await action(a, 'setCategoryBudget', {
					categoryId: id,
					amount: '1.000',
					currency: 'IDR',
					updatedAt: ''
				})
			).toMatchObject({ kind: 'fail', status: 404, data: { error: CATEGORY_NOT_FOUND } });
		const makan = await categoryId(a.scope, 'makan');
		expect(
			await action(a, 'setCategoryBudget', {
				categoryId: makan,
				amount: '1.000',
				currency: 'USD',
				updatedAt: ''
			})
		).toMatchObject({ kind: 'fail', status: 400, data: { error: BUDGET_CURRENCY_INVALID } });
		expect(await categoryRows(a.scope.spaceId)).toEqual([]);
		expect(await categoryRows(b.scope.spaceId)).toEqual([]);
	});

	it('20 concurrent first saves for one category leave exactly one live row', async () => {
		const p = await person();
		const makan = await categoryId(p.scope, 'makan');
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				setCategoryBudget(
					db,
					p.scope,
					makan,
					{ amountMinor: (i + 1) * 100, currency: 'IDR' },
					null,
					NOW
				)
			)
		);
		expect(results.filter((r) => r === 'ok')).toHaveLength(1);
		expect(results.filter((r) => r !== 'ok').every((r) => r === 'stale')).toBe(true);
		expect(await categoryRows(p.scope.spaceId)).toHaveLength(1);
	});

	it('tombstoning a category tombstones its budget in the same batch; the export holds none live', async () => {
		const p = await person();
		const makan = await categoryId(p.scope, 'makan');
		const kopi = await categoryId(p.scope, 'kopi');
		for (const id of [makan, kopi])
			await setCategoryBudget(db, p.scope, id, { amountMinor: 100, currency: 'IDR' }, null, NOW);
		// Categories have no delete action yet (owner decision C); a future path (sync, purge) writes a tombstone
		// the way every delete does: seq bumped first, then the guarded update, in one batch.
		const space = p.scope.spaceId;
		await db.batch([
			bumpSpaceSeq(db, space),
			db
				.update(categories)
				.set({ deletedAt: NOW + 5, updatedAt: NOW + 5, seq: currentSpaceSeq(space) })
				.where(and(eq(categories.id, makan), eq(categories.spaceId, space)))
		]);
		const seq = (await d1
			.prepare('select seq from space_seq where space_id = ?')
			.bind(space)
			.first<{ seq: number }>())!.seq;
		const row = await d1
			.prepare(
				'select amount_minor, deleted_at, updated_at, seq from category_budgets where category_id = ?'
			)
			.bind(makan)
			.first();
		expect(row).toEqual({ amount_minor: 0, deleted_at: NOW + 5, updated_at: NOW + 5, seq });
		// The other category's budget is untouched.
		expect(await categoryRows(space)).toContainEqual({
			category_id: kopi,
			amount_minor: 100,
			deleted_at: null
		});
		const s = await summaryOf(p);
		expect(s.categories.map((c) => c.categoryId)).toEqual([kopi]);
		expect(s.unbudgeted.map((c) => c.categoryId)).not.toContain(makan);
		// FN-31 export: the same reader the account ZIP uses lists only the live budget.
		const plan = SPACE_JSON_TABLES.find((t) => t.table === 'category_budgets')!;
		const exported = [];
		for await (const page of tablePages(db, plan, {
			kind: 'space',
			spaceId: space,
			userId: p.user.id
		}))
			exported.push(...page);
		expect(exported.map((r) => r.category_id)).toEqual([kopi]);
		// Tombstoning again (or another column update) never touches the tombstoned budget again.
		await d1.prepare('update categories set name = ? where id = ?').bind('Makan', makan).run();
		expect(
			await d1
				.prepare('select updated_at from category_budgets where category_id = ?')
				.bind(makan)
				.first()
		).toEqual({ updated_at: NOW + 5 });
	});

	it('the database refuses a budget for another space’s category (composite foreign key)', async () => {
		const a = await person();
		const b = await person();
		const theirs = await categoryId(b.scope, 'makan');
		await expect(
			d1
				.prepare(
					`insert into category_budgets (id, space_id, category_id, amount_minor, currency, created_at,
						updated_at, deleted_at, seq) values (?, ?, ?, 100, 'IDR', 1, 1, null, 1)`
				)
				.bind(crypto.randomUUID(), a.scope.spaceId, theirs)
				.run()
		).rejects.toThrow(/FOREIGN KEY/i);
		// The same insert for the space's own category is accepted: the key, not the statement, refused it.
		const mine = await categoryId(a.scope, 'makan');
		await d1
			.prepare(
				`insert into category_budgets (id, space_id, category_id, amount_minor, currency, created_at,
					updated_at, deleted_at, seq) values (?, ?, ?, 100, 'IDR', 1, 1, null, 1)`
			)
			.bind(crypto.randomUUID(), a.scope.spaceId, mine)
			.run();
		expect(await categoryRows(a.scope.spaceId)).toHaveLength(1);
		expect(await categoryRows(b.scope.spaceId)).toEqual([]);
	});
});

describe('/anggaran: one access rule', () => {
	it('a shared space’s category budgets are shared by its members and never leak to another space', async () => {
		const { owner, member, spaceId } = await sharedSpace();
		const makan = await categoryId({ spaceId, userId: owner.user.id }, 'makan');
		expect(
			await action(
				member,
				'setCategoryBudget',
				{ categoryId: makan, amount: '500.000', currency: 'IDR', updatedAt: '' },
				{ space: spaceId }
			)
		).toMatchObject({ kind: 'ok' });
		expect((await summaryOf(owner, spaceId)).categories.map((c) => c.categoryId)).toEqual([makan]);
		// Neither member's personal space sees it.
		expect((await summaryOf(owner)).categories).toEqual([]);
		expect((await summaryOf(member)).categories).toEqual([]);
	});

	it('a removed member gets 404 on load and on every action, and nothing is written', async () => {
		const { owner, member, spaceId } = await sharedSpace();
		const makan = await categoryId({ spaceId, userId: owner.user.id }, 'makan');
		await setCategoryBudget(
			db,
			{ spaceId, userId: owner.user.id },
			makan,
			{ amountMinor: 100, currency: 'IDR' },
			null,
			NOW
		);
		const stale = await resolveCurrentSpace(db, member.user.id, spaceId);
		expect(stale?.id).toBe(spaceId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);

		expect(await load(member, { stale })).toMatchObject({ kind: 'error', status: 404 });
		const updatedAt = String((await summaryOf(owner, spaceId)).categories[0]!.budget.updatedAt);
		for (const [name, form] of [
			['setCategoryBudget', { categoryId: makan, amount: '9', currency: 'IDR', updatedAt }],
			['deleteCategoryBudget', { categoryId: makan, updatedAt }],
			['setBudget', { amount: '9', currency: 'IDR', updatedAt: '' }]
		] as const)
			expect(await action(member, name, form, { stale })).toMatchObject({
				kind: 'error',
				status: 404
			});
		// The repo repeats the check: a write that slipped past the gate changes nothing.
		expect(
			await setCategoryBudget(
				db,
				{ spaceId, userId: member.user.id },
				makan,
				{ amountMinor: 9, currency: 'IDR' },
				Number(updatedAt),
				NOW
			)
		).toBe('gone');
		expect(await categoryRows(spaceId)).toEqual([
			{ category_id: makan, amount_minor: 100, deleted_at: null }
		]);
	});

	it('purgeSpaces deletes the space’s category budgets and nothing of another space', async () => {
		const a = await person();
		const b = await person();
		for (const p of [a, b])
			await setCategoryBudget(
				db,
				p.scope,
				await categoryId(p.scope, 'makan'),
				{ amountMinor: 100, currency: 'IDR' },
				null,
				NOW
			);
		await db.batch(purgeSpaces(db, sql`select ${a.scope.spaceId}`, () => sql`1`) as never);
		expect(await categoryRows(a.scope.spaceId)).toEqual([]);
		expect(await categoryRows(b.scope.spaceId)).toHaveLength(1);
	});
});

describe('FN-47: a budget in a currency with cents', () => {
	it('a CNY budget of 1.234,56 (id) is stored as 123456 and comes back unchanged; 3 digits refused', async () => {
		const p = await person();
		const w = await createWallet(
			db,
			p.scope,
			{
				name: 'Alipay',
				type: 'e_wallet',
				currency: 'CNY',
				openingBalanceMinor: 0,
				isFavourite: true,
				lastFour: null
			},
			NOW
		);
		if (!w.ok) throw new Error('wallet failed');
		expect(
			await action(p, 'setBudget', { amount: '1.234,567', currency: 'CNY', updatedAt: '' })
		).toMatchObject({ kind: 'fail', status: 400 });
		expect(
			await action(p, 'setBudget', { amount: '1.234,56', currency: 'CNY', updatedAt: '' })
		).toMatchObject({ kind: 'ok', value: { saved: 'set' } });
		const s = await summaryOf(p);
		expect(s.currency).toBe('CNY');
		expect(s.budget).toMatchObject({ amountMinor: 123_456, currency: 'CNY' });
		expect(s.total?.budgetMinor).toBe(123_456);
	});
});
