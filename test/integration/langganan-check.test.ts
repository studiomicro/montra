import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { CANDIDATE_NOT_FOUND } from '#lib/server/subscriptions/messages';
import { createTransaction } from '#lib/server/transactions/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { addDays, wibTodayString } from '#lib/shared/dates';
import {
	candidateFormValues,
	DETECT_ROWS_MAX,
	type SubscriptionCandidate
} from '#lib/shared/subscriptions-detect';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

// FN-26b subscription check on /langganan: detection from stored rows only, dismissals, the add prefill, one
// access rule, account deletion. Real local D1 (workerd), never remote; no AI anywhere in this path.

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/langganan/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const today = wibTodayString();

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
	const email = `periksa${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	return { user: { id: r.userId, email, name, createdAt: 0 }, spaceId: space.id };
}
type Person = Awaited<ReturnType<typeof person>>;

async function ev(
	who: Person | null,
	opts: { path?: string; form?: Record<string, string>; spaceCookie?: string; space?: string }
) {
	let space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	if (opts.space) space = { id: opts.space, kind: 'shared', name: 'x', role: 'member' };
	return fakeEvent({
		url: `http://localhost${opts.path ?? '/langganan'}`,
		routeId: '/(app)/langganan',
		db,
		user: who?.user ?? null,
		space,
		form: opts.form
	}).event as never;
}

const act = (
	who: Person,
	name: string,
	form: Record<string, string>,
	opts: { spaceCookie?: string; space?: string } = {}
) =>
	run(async () =>
		(page.actions as Record<string, Action>)[name]!(await ev(who, { form, ...opts }))
	);

async function loaded(who: Person, spaceCookie?: string, path = '/langganan') {
	const r = await run(async () => page.load(await ev(who, { path, spaceCookie })));
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value as unknown as {
		candidates: SubscriptionCandidate[];
		subscriptions: { name: string; catalogueId: string | null }[];
		loadError: string | null;
		open: Record<string, unknown>;
	};
}
const candidatesOf = async (who: Person, spaceCookie?: string) =>
	(await loaded(who, spaceCookie)).candidates;

async function wallet(who: Person, spaceId = who.spaceId, name = 'Dompet') {
	const r = await createWallet(
		db,
		{ spaceId, userId: who.user.id },
		{
			name,
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: false,
			lastFour: null
		},
		Date.now()
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

/** One live transaction in `spaceId` (an expense by default), dated `daysAgo` WIB days before today. */
async function tx(
	who: Person,
	title: string,
	daysAgo: number,
	opts: {
		amountMinor?: number;
		spaceId?: string;
		type?: 'expense' | 'income' | 'transfer';
		walletId?: string;
		toWalletId?: string;
	} = {}
) {
	const spaceId = opts.spaceId ?? who.spaceId;
	const type = opts.type ?? 'expense';
	await ensurePresetCategories(db, spaceId);
	const categories = await listCategories(db, spaceId);
	const categoryId =
		type === 'transfer'
			? null
			: categories.find((c) => c.tileKey === (type === 'income' ? 'gaji' : 'tagihan'))!.id;
	const r = await createTransaction(
		db,
		{ spaceId, userId: who.user.id },
		{
			type,
			amountMinor: opts.amountMinor ?? 5_000_000,
			currency: 'IDR',
			walletId: opts.walletId ?? (await wallet(who, spaceId)),
			transferToWalletId: opts.toWalletId ?? null,
			categoryId,
			title,
			note: null,
			occurredOn: addDays(today, -daysAgo),
			occurredTime: null
		},
		Date.now()
	);
	if (!r.ok) throw new Error(`transaction failed: ${r.reason}`);
	return r.id;
}

const count = async (sql: string, ...binds: unknown[]) =>
	(await d1
		.prepare(sql)
		.bind(...binds)
		.first<{ n: number }>())!.n;
const dismissals = (spaceId: string) =>
	count(
		'select count(*) as n from subscription_dismissals where space_id = ? and deleted_at is null',
		spaceId
	);

describe('detection from stored rows (AC1–AC4, AC10)', () => {
	it('an empty space has no candidates and no error', async () => {
		const p = await person();
		expect(await loaded(p)).toMatchObject({ candidates: [], loadError: null });
	});

	it('one Netflix charge is a candidate carrying that real row: id, WIB date, exact amount', async () => {
		const p = await person();
		const id = await tx(p, 'NETFLIX.COM', 3, { amountMinor: 18_600_000 });
		expect(await candidatesOf(p)).toEqual([
			{
				matchKey: 'cat:netflix',
				name: 'Netflix',
				catalogueId: 'netflix',
				category: 'streaming',
				amountMinor: 18_600_000,
				currency: 'IDR',
				cadence: 'monthly',
				lastOccurredOn: addDays(today, -3),
				sourceRows: [
					{
						id,
						occurredOn: addDays(today, -3),
						amountMinor: 18_600_000,
						currency: 'IDR',
						title: 'NETFLIX.COM'
					}
				]
			}
		]);
	});

	it('the same amount at an unknown merchant ~a month apart is monthly; 10 and 40 days apart is nothing', async () => {
		const p = await person();
		const w = await wallet(p);
		const ids = [
			await tx(p, 'Kos Bu Ani', 2, { walletId: w }),
			await tx(p, 'Kos Bu Ani', 32, { walletId: w }),
			await tx(p, 'Kos Bu Ani', 61, { walletId: w })
		];
		await tx(p, 'Toko Maju', 2, { walletId: w });
		await tx(p, 'Toko Maju', 12, { walletId: w });
		await tx(p, 'Toko Maju', 52, { walletId: w });
		const [c, ...rest] = await candidatesOf(p);
		expect(rest).toEqual([]);
		expect(c).toMatchObject({ matchKey: 'kos bu ani', cadence: 'monthly', category: null });
		expect(c!.sourceRows.map((r) => r.id)).toEqual(ids);
	});

	it('Data demo rows, transfers, income, deleted rows and rows older than 90 days never count', async () => {
		const p = await person();
		const a = await wallet(p, p.spaceId, 'A');
		const b = await wallet(p, p.spaceId, 'B');
		const demo = await tx(p, 'Netflix', 1, { walletId: a });
		await d1.prepare('update transactions set is_demo = 1 where id = ?').bind(demo).run();
		await tx(p, 'Spotify', 1, { walletId: a, type: 'transfer', toWalletId: b });
		await tx(p, 'Disney+ Hotstar', 1, { walletId: a, type: 'income' });
		await tx(p, 'YouTube Premium', 90, { walletId: a });
		const gone = await tx(p, 'Vidio', 1, { walletId: a });
		await d1
			.prepare(
				`update transactions set deleted_at = 1, amount_minor = null, currency = null, wallet_id = null,
				category_id = null, occurred_on = null, occurred_at = null, title = null, note = null where id = ?`
			)
			.bind(gone)
			.run();
		expect(await candidatesOf(p)).toEqual([]);
		// Day 89 back is still inside the 90-day window.
		await tx(p, 'YouTube Premium', 89, { walletId: a });
		expect((await candidatesOf(p)).map((c) => c.matchKey)).toEqual(['cat:youtube-premium']);
	});

	it(`reads only the ${DETECT_ROWS_MAX} most recent expenses (bounded), across 300 distinct keys`, async () => {
		const p = await person();
		const w = await wallet(p);
		await tx(p, 'Kos Lama', 60, { walletId: w });
		await tx(p, 'Kos Lama', 30, { walletId: w });
		const template = await tx(p, 'Isi', 0, { walletId: w });
		// 300 newer one-off rows, each its own merchant: the two older Kos Lama rows fall outside the cap.
		const cols = (
			await d1.prepare('pragma table_info(transactions)').all<{ name: string }>()
		).results
			.map((c) => c.name)
			.filter((c) => c !== 'id' && c !== 'title');
		await d1.batch(
			Array.from({ length: DETECT_ROWS_MAX - 1 }, (_, i) =>
				d1
					.prepare(
						`insert into transactions (id, title, ${cols.join(', ')})
						select ?, ?, ${cols.join(', ')} from transactions where id = ?`
					)
					.bind(
						`bulk-${p.spaceId}-${i}`,
						`Toko Nomor ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26) % 26]}`,
						template
					)
			)
		);
		expect(await candidatesOf(p)).toEqual([]);
	});
});

describe('Bukan langganan (AC7, AC13)', () => {
	it('dismisses once; the candidate never comes back; a repeat is ok and adds nothing', async () => {
		const p = await person();
		await tx(p, 'Spotify', 4, { amountMinor: 5_499_000 });
		expect((await candidatesOf(p)).map((c) => c.matchKey)).toEqual(['cat:spotify']);
		expect(await act(p, 'dismissCandidate', { matchKey: 'cat:spotify' })).toEqual({
			kind: 'ok',
			value: { saved: 'dismissed', matchKey: 'cat:spotify' }
		});
		expect(await candidatesOf(p)).toEqual([]);
		// Unchanged source rows, a new charge: still dismissed.
		await tx(p, 'Spotify', 0, { amountMinor: 5_499_000 });
		expect(await candidatesOf(p)).toEqual([]);
		expect(await act(p, 'dismissCandidate', { matchKey: 'cat:spotify' })).toMatchObject({
			kind: 'ok'
		});
		expect(await dismissals(p.spaceId)).toBe(1);
		const row = await d1
			.prepare('select match_key, created_by from subscription_dismissals where space_id = ?')
			.bind(p.spaceId)
			.first();
		expect(row).toEqual({ match_key: 'cat:spotify', created_by: p.user.id });
	});

	it('an unknown, blank or over-long key is 404 and stores nothing (no arbitrary keys)', async () => {
		const p = await person();
		await tx(p, 'Spotify', 4);
		for (const matchKey of ['cat:netflix', 'apa saja', '', 'x'.repeat(65)])
			expect(await act(p, 'dismissCandidate', { matchKey })).toEqual({
				kind: 'fail',
				status: 404,
				data: { error: CANDIDATE_NOT_FOUND }
			});
		expect(await dismissals(p.spaceId)).toBe(0);
	});

	it('20 concurrent dismissals of one key leave exactly one live row, all answered ok', async () => {
		const p = await person();
		await tx(p, 'Biznet', 4);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => act(p, 'dismissCandidate', { matchKey: 'cat:biznet' }))
		);
		expect(results.every((r) => r.kind === 'ok')).toBe(true);
		expect(await dismissals(p.spaceId)).toBe(1);
	});
});

describe('Tambah from a candidate (AC6, AC8)', () => {
	it('the prefilled form posts through createSubscription; then the candidate is gone', async () => {
		const p = await person();
		const w = await wallet(p);
		await tx(p, 'Netflix', 5, { amountMinor: 18_600_000, walletId: w });
		await tx(p, 'Kos Bu Ani', 3, { walletId: w });
		await tx(p, 'Kos Bu Ani', 33, { walletId: w });
		const before = await candidatesOf(p);
		expect(before.map((c) => c.matchKey).sort()).toEqual(['cat:netflix', 'kos bu ani']);
		const subsBefore = await count(
			'select count(*) as n from subscriptions where space_id = ?',
			p.spaceId
		);
		// Nothing is created until the form is submitted.
		expect(subsBefore).toBe(0);
		const txBefore = await count(
			'select count(*) as n from transactions where space_id = ?',
			p.spaceId
		);
		for (const c of before)
			expect(await act(p, 'createSubscription', { ...candidateFormValues(c, 'id') })).toEqual({
				kind: 'ok',
				value: { saved: 'created' }
			});
		const after = await loaded(p);
		expect(after.candidates).toEqual([]);
		expect(after.subscriptions.map((s) => [s.name, s.catalogueId]).sort()).toEqual([
			['Kos Bu Ani', null],
			['Netflix', 'netflix']
		]);
		// No new transaction from adding.
		expect(
			await count('select count(*) as n from transactions where space_id = ?', p.spaceId)
		).toBe(txBefore);
	});

	it('a subscription typed by hand under a known name also hides the candidate', async () => {
		const p = await person();
		await tx(p, 'Bayar Netflix', 5);
		const r = await act(p, 'createSubscription', {
			name: 'Netflix Keluarga',
			category: 'streaming',
			amount: '186.000',
			currency: 'IDR',
			cycle: 'monthly',
			day: '15',
			weekday: '1',
			month: '1',
			reminderDays: '2'
		});
		expect(r).toMatchObject({ kind: 'ok' });
		expect(await candidatesOf(p)).toEqual([]);
	});

	it('?kandidat= and ?periksa=1 are read as bounded no-JavaScript open states', async () => {
		const p = await person();
		const r = await loaded(p, undefined, `/langganan?periksa=1&kandidat=${'k'.repeat(100)}`);
		expect(r.open).toMatchObject({ check: true, fromCheck: 'k'.repeat(64) });
	});
});

describe('one access rule (AC9) and account deletion (AC12)', () => {
	async function shared() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		await tx(owner, 'IndiHome', 6, { spaceId });
		return { owner, member, spaceId };
	}

	it('two users, two spaces: each sees only their own space’s candidates', async () => {
		const a = await person('A');
		const b = await person('B');
		await tx(a, 'Netflix', 2);
		await tx(b, 'Spotify', 2);
		expect((await candidatesOf(a)).map((c) => c.matchKey)).toEqual(['cat:netflix']);
		expect((await candidatesOf(b)).map((c) => c.matchKey)).toEqual(['cat:spotify']);
		// B cannot dismiss A's key: in B's space it is simply not a candidate.
		expect(await act(b, 'dismissCandidate', { matchKey: 'cat:netflix' })).toMatchObject({
			kind: 'fail',
			status: 404
		});
		expect(await dismissals(a.spaceId)).toBe(0);
		expect(await dismissals(b.spaceId)).toBe(0);
	});

	it('a member sees and dismisses the shared space’s candidates', async () => {
		const { owner, member, spaceId } = await shared();
		expect((await candidatesOf(member, spaceId)).map((c) => c.matchKey)).toEqual(['cat:indihome']);
		expect(
			await act(member, 'dismissCandidate', { matchKey: 'cat:indihome' }, { spaceCookie: spaceId })
		).toMatchObject({ kind: 'ok' });
		expect(await candidatesOf(owner, spaceId)).toEqual([]);
	});

	it('a non-member and a removed member get 404 on the load and the action; nothing is written', async () => {
		const { owner, member, spaceId } = await shared();
		const stranger = await person();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		for (const who of [stranger, member]) {
			expect(await run(async () => page.load(await ev(who, { space: spaceId })))).toEqual({
				kind: 'error',
				status: 404,
				body: { message: 'Not found', status: 404 }
			});
			expect(
				await act(who, 'dismissCandidate', { matchKey: 'cat:indihome' }, { space: spaceId })
			).toEqual({ kind: 'error', status: 404, body: { message: 'Not found', status: 404 } });
			// Their own current space never shows the shared space's rows.
			expect(await candidatesOf(who, spaceId)).toEqual([]);
		}
		expect(await dismissals(spaceId)).toBe(0);
	});

	it('account deletion purges the dismissals of a space they were last in; a shared space keeps its own', async () => {
		const { owner, member, spaceId } = await shared();
		await tx(owner, 'Spotify', 3);
		await act(owner, 'dismissCandidate', { matchKey: 'cat:spotify' });
		await act(owner, 'dismissCandidate', { matchKey: 'cat:indihome' }, { spaceCookie: spaceId });
		expect(await dismissals(owner.spaceId)).toBe(1);
		const proof = await signInWithPassword(db, owner.user.email, PASSWORD, 1);
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, owner.user.id, proof.hash)).toBe(true);
		expect(
			await count(
				'select count(*) as n from subscription_dismissals where space_id = ?',
				owner.spaceId
			)
		).toBe(0);
		expect(await dismissals(spaceId)).toBe(1);
		expect(
			await d1
				.prepare('select created_by from subscription_dismissals where space_id = ?')
				.bind(spaceId)
				.first()
		).toEqual({ created_by: null });
		expect(await candidatesOf(member, spaceId)).toEqual([]);
	});
});
