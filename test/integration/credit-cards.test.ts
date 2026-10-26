import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { cardSummaries } from '#lib/server/cards/summary';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { summarizeNetWorth, netWorthSummary, writeSnapshots } from '#lib/server/net-worth/summary';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { periodTotals } from '#lib/server/transactions/aggregate';
import { createTransaction, MANUAL } from '#lib/server/transactions/repo';
import { walletTransactionsSums } from '#lib/server/transactions/wallet-sum';
import {
	applyTransferMatch,
	countTransferMatches,
	proposeTransferMatches,
	undoTransferMatch
} from '#lib/server/transfers/match';
import {
	CARD_DAY_INVALID,
	CARD_FIELD_ONLY,
	CARD_LIMIT_INVALID,
	CARD_TYPE_LOCKED,
	WALLET_CHANGED
} from '#lib/server/wallets/messages';
import { createWallet, getWallet } from '#lib/server/wallets/repo';
import type { TileKey } from '#lib/shared/transactions';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-55a (credit card wallets): the form, the type lock, the card summary (A2), the card page and its 404s, the bill
 * payment as a transfer, WIB month buckets, net worth (A4), card-payment pairing (A5) and the row rules (A6), across
 * two users and two spaces. Every figure is checked to the sen.
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const dompet = await import('../../src/routes/(app)/dompet/+page.server');
const kartu = await import('../../src/routes/(app)/dompet/kartu/[id]/+page.server');
const baru = await import('../../src/routes/(app)/riwayat/baru/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.parse('2026-10-13T03:00:00Z');
const TODAY = '2026-10-13';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function person(name = 'Uji') {
	const email = `kartu${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	return { user: { id: r.userId, email, name, createdAt: 0 }, scope };
}
type Person = Awaited<ReturnType<typeof person>>;

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

async function ev(
	who: Person,
	opts: {
		path?: string;
		form?: Record<string, string>;
		spaceCookie?: string;
		params?: Record<string, string>;
		routeId?: string;
	}
) {
	const space = await resolveCurrentSpace(db, who.user.id, opts.spaceCookie);
	return fakeEvent({
		url: `http://localhost${opts.path ?? '/dompet'}`,
		routeId: opts.routeId ?? '/(app)/dompet',
		db,
		user: who.user,
		space,
		form: opts.form,
		params: opts.params
	}).event as never;
}
type Action = (event: never) => unknown;
const postDompet = async (
	who: Person,
	name: string,
	form: Record<string, string>,
	spaceCookie?: string
) =>
	run(async () =>
		((dompet.actions as Record<string, Action>)[name] as Action)(
			await ev(who, { form, spaceCookie })
		)
	);
const loadDompet = async (who: Person, spaceCookie?: string) =>
	run(async () => dompet.load(await ev(who, { spaceCookie })));
const loadCard = async (who: Person, id: string, spaceCookie?: string) =>
	run(async () =>
		kartu.load(
			await ev(who, {
				path: `/dompet/kartu/${id}`,
				params: { id },
				spaceCookie,
				routeId: '/(app)/dompet/kartu/[id]'
			})
		)
	);

const cardForm = (over: Record<string, string> = {}) => ({
	name: 'Kartu Fiktif',
	type: 'kartu_kredit',
	currency: 'IDR',
	balanceMode: 'card',
	openingBalance: '1.250.000,50',
	creditLimit: '15.000.000',
	statementDay: '25',
	dueDay: '12',
	lastFour: '0001',
	...over
});

async function card(scope: SpaceScope, over: Partial<Parameters<typeof createWallet>[2]> = {}) {
	const r = await createWallet(
		db,
		scope,
		{
			name: 'Kartu',
			type: 'kartu_kredit',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: false,
			lastFour: null,
			creditLimitMinor: null,
			statementDay: null,
			dueDay: null,
			...over
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}
async function bank(scope: SpaceScope, name = 'Bank') {
	const r = await createWallet(
		db,
		scope,
		{
			name,
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 1000000000,
			isFavourite: true,
			lastFour: null
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

async function categoryOf(spaceId: string, tile: TileKey, kind: 'expense' | 'income') {
	await ensurePresetCategories(db, spaceId, NOW);
	const c = (await listCategories(db, spaceId)).find(
		(x) => x.isPreset && x.tileKey === tile && x.kind === kind
	);
	if (!c) throw new Error(`no preset ${tile}`);
	return c.id;
}

async function row(
	scope: SpaceScope,
	r: {
		type: 'expense' | 'income' | 'transfer';
		amount: number;
		wallet: string;
		to?: string;
		tile?: TileKey;
		on: string;
		time?: string;
		demo?: boolean;
		currency?: string;
	}
) {
	const categoryId =
		r.type === 'transfer'
			? null
			: await categoryOf(
					scope.spaceId,
					r.tile ?? (r.type === 'expense' ? 'belanja' : 'lain'),
					r.type
				);
	const created = await createTransaction(
		db,
		scope,
		{
			type: r.type,
			amountMinor: r.amount,
			currency: r.currency ?? 'IDR',
			walletId: r.wallet,
			transferToWalletId: r.to ?? null,
			categoryId,
			title: 'Fiktif',
			note: null,
			occurredOn: r.on,
			occurredTime: r.time ?? '12:00'
		},
		NOW,
		r.demo ? { ...MANUAL, isDemo: true } : MANUAL
	);
	if (!created.ok) throw new Error(`row failed: ${created.reason}`);
	return created.id;
}

let batchN = 0;
/** A stored card statement (and its import batch) as an import would leave it (wallet convention). */
async function storeStatement(
	scope: SpaceScope,
	walletId: string,
	s: { date: string; due?: string | null; next: number; minimum?: number | null; previous?: number }
) {
	const batchId = `batch-${++batchN}`;
	await d1
		.prepare(
			`insert into import_batches (id, space_id, source, row_count, imported_count, skipped_count, created_at,
				updated_at, seq, wallet_id) values (?, ?, 'statement', 0, 0, 0, ?, ?, 1, ?)`
		)
		.bind(batchId, scope.spaceId, NOW, NOW, walletId)
		.run();
	await d1
		.prepare(
			`insert into card_statements (id, space_id, wallet_id, import_batch_id, statement_date, due_date,
				previous_balance_minor, new_balance_minor, minimum_payment_minor, currency, created_at, updated_at, seq)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'IDR', ?, ?, 1)`
		)
		.bind(
			`st-${batchN}`,
			scope.spaceId,
			walletId,
			batchId,
			s.date,
			s.due ?? null,
			s.previous ?? 0,
			s.next,
			s.minimum ?? null,
			NOW,
			NOW
		)
		.run();
	return batchId;
}

async function summaryOf(scope: SpaceScope, walletId: string, today = TODAY) {
	const w = (await getWallet(db, scope.spaceId, walletId))!;
	const sums = await walletTransactionsSums(db, scope.spaceId);
	const [s] = await cardSummaries(
		db,
		scope.spaceId,
		[{ ...w, balanceMinor: w.openingBalanceMinor + (sums.get(w.id) ?? 0) }],
		today
	);
	return s!;
}

describe('card wallet form (AC 1-4)', () => {
	it('AC 1: limit, statement day, due day, last 4 and a debt with sen save exactly and survive a reload', async () => {
		const p = await person();
		expect(await postDompet(p, 'createWallet', cardForm())).toEqual({
			kind: 'ok',
			value: { saved: 'created' }
		});
		const loaded = await loadDompet(p);
		if (loaded.kind !== 'ok') throw new Error('load failed');
		const [w] = loaded.value.wallets as {
			id: string;
			openingBalanceMinor: number;
			balanceMinor: number;
			creditLimitMinor: number;
			statementDay: number;
			dueDay: number;
			lastFour: string;
		}[];
		expect(w).toMatchObject({
			openingBalanceMinor: -125000050,
			balanceMinor: -125000050,
			creditLimitMinor: 1500000000,
			statementDay: 25,
			dueDay: 12,
			lastFour: '0001'
		});
		// The dompet row's card line: available = limit − owed, to the sen; the next due day from today (WIB).
		expect(loaded.value.cards).toEqual([
			expect.objectContaining({
				walletId: w!.id,
				owedMinor: 125000050,
				available: { kind: 'available', minor: 1374999950 },
				due: expect.objectContaining({ date: expect.stringMatching(/-12$/) })
			})
		]);
	});

	it('AC 1: an overpaid card is stored positive; plain wording keeps the negative box', async () => {
		const p = await person();
		await postDompet(
			p,
			'createWallet',
			cardForm({ name: 'Lebih', overpaid: 'on', openingBalance: '50.000,25' })
		);
		await postDompet(
			p,
			'createWallet',
			cardForm({
				name: 'Polos',
				balanceMode: 'plain',
				openingBalance: '25.000',
				negative: 'on',
				creditLimit: '',
				statementDay: '',
				dueDay: ''
			})
		);
		const loaded = await loadDompet(p);
		const ws = (loaded.kind === 'ok' ? loaded.value.wallets : []) as {
			name: string;
			openingBalanceMinor: number;
		}[];
		expect(Object.fromEntries(ws.map((w) => [w.name, w.openingBalanceMinor]))).toEqual({
			Lebih: 5000025,
			Polos: -2500000
		});
	});

	it('AC 2: card fields sent with type Bank are refused with a field message; nothing is stored', async () => {
		const p = await person();
		const before = await d1.prepare('select count(*) as n from wallets').first<{ n: number }>();
		for (const field of ['creditLimit', 'statementDay', 'dueDay'] as const) {
			const form = cardForm({
				type: 'bank',
				balanceMode: 'plain',
				openingBalance: '0',
				creditLimit: '',
				statementDay: '',
				dueDay: '',
				[field]: field === 'creditLimit' ? '1.000' : '5'
			});
			const r = await postDompet(p, 'createWallet', form);
			expect(r).toMatchObject({ kind: 'fail', status: 400 });
			const key = field === 'creditLimit' ? 'creditLimitMinor' : field;
			expect((r as unknown as { data: { errors: Record<string, string> } }).data.errors[key]).toBe(
				CARD_FIELD_ONLY
			);
		}
		expect(await d1.prepare('select count(*) as n from wallets').first<{ n: number }>()).toEqual(
			before
		);
	});

	it('AC 3: days and limits outside the rules are refused, never rounded; "" clears', async () => {
		const p = await person();
		for (const day of ['0', '32', '12.5', '-1', '1e1', 'abc'])
			expect(await postDompet(p, 'createWallet', cardForm({ statementDay: day }))).toMatchObject({
				kind: 'fail',
				data: { errors: { statementDay: CARD_DAY_INVALID } }
			});
		for (const limit of ['0', '-1', '1.000.000,001', '100.000.000.001', '12,345'])
			expect(await postDompet(p, 'createWallet', cardForm({ creditLimit: limit }))).toMatchObject({
				kind: 'fail',
				data: { errors: { creditLimitMinor: CARD_LIMIT_INVALID } }
			});
		expect(
			await postDompet(
				p,
				'createWallet',
				cardForm({ creditLimit: '', statementDay: '', dueDay: '' })
			)
		).toEqual({ kind: 'ok', value: { saved: 'created' } });
		const loaded = await loadDompet(p);
		const [w] = (loaded.kind === 'ok' ? loaded.value.wallets : []) as Record<string, unknown>[];
		expect(w).toMatchObject({ creditLimitMinor: null, statementDay: null, dueDay: null });
		// The largest limit (10^13 sen) is accepted exactly.
		expect(
			await postDompet(
				p,
				'createWallet',
				cardForm({ name: 'Besar', creditLimit: '100.000.000.000' })
			)
		).toEqual({ kind: 'ok', value: { saved: 'created' } });
	});

	it('AC 4: a card with a live statement cannot become Bank; a Bank wallet can become a card', async () => {
		const p = await person();
		const cardId = await card(p.scope, { creditLimitMinor: 1000 });
		await storeStatement(p.scope, cardId, { date: '2026-09-25', next: -1000 });
		const w = (await getWallet(db, p.scope.spaceId, cardId))!;
		const r = await postDompet(p, 'updateWallet', {
			...cardForm({
				type: 'bank',
				balanceMode: 'plain',
				openingBalance: '0',
				creditLimit: '',
				statementDay: '',
				dueDay: '',
				lastFour: ''
			}),
			walletId: cardId,
			updatedAt: String(w.updatedAt)
		});
		expect(r).toEqual({ kind: 'fail', status: 409, data: { error: CARD_TYPE_LOCKED } });
		expect(await getWallet(db, p.scope.spaceId, cardId)).toEqual(w);

		const bankId = await bank(p.scope);
		const b = (await getWallet(db, p.scope.spaceId, bankId))!;
		expect(
			await postDompet(p, 'updateWallet', {
				name: 'Bank',
				type: 'kartu_kredit',
				currency: 'IDR',
				balanceMode: 'plain',
				openingBalance: '10.000.000',
				walletId: bankId,
				updatedAt: String(b.updatedAt)
			})
		).toEqual({ kind: 'ok', value: { saved: 'updated' } });
		expect(await getWallet(db, p.scope.spaceId, bankId)).toMatchObject({
			type: 'kartu_kredit',
			creditLimitMinor: null,
			statementDay: null,
			dueDay: null
		});
	});

	it('two tabs: the stale card edit answers "changed meanwhile" (updated_at compare)', async () => {
		const p = await person();
		const cardId = await card(p.scope);
		const w = (await getWallet(db, p.scope.spaceId, cardId))!;
		const edit = (limit: string) =>
			postDompet(p, 'updateWallet', {
				...cardForm({ creditLimit: limit, lastFour: '' }),
				walletId: cardId,
				updatedAt: String(w.updatedAt)
			});
		const results = await Promise.all([edit('1.000'), edit('2.000')]);
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
		expect(results.filter((r) => r.kind === 'fail')).toEqual([
			{ kind: 'fail', status: 409, data: { error: WALLET_CHANGED } }
		]);
	});

	it('AC 18: a USD card takes cents (12,50 → 1250) on its form', async () => {
		const p = await person();
		await postDompet(
			p,
			'createWallet',
			cardForm({ currency: 'USD', openingBalance: '12,50', creditLimit: '1.000,00' })
		);
		const loaded = await loadDompet(p);
		const [w] = (loaded.kind === 'ok' ? loaded.value.wallets : []) as Record<string, unknown>[];
		expect(w).toMatchObject({
			currency: 'USD',
			openingBalanceMinor: -1250,
			creditLimitMinor: 100000
		});
	});
});

describe('card summary (AC 5-8)', () => {
	it('AC 5: available to the sen; over the limit is named; no limit, no line; a credit balance owes nothing', async () => {
		const p = await person();
		const a = await card(p.scope, {
			openingBalanceMinor: -125000050,
			creditLimitMinor: 1500000000
		});
		const over = await card(p.scope, {
			name: 'Over',
			openingBalanceMinor: -200,
			creditLimitMinor: 100
		});
		const none = await card(p.scope, { name: 'None', openingBalanceMinor: -5 });
		const credit = await card(p.scope, {
			name: 'Credit',
			openingBalanceMinor: 500,
			creditLimitMinor: 100
		});
		expect((await summaryOf(p.scope, a)).available).toEqual({
			kind: 'available',
			minor: 1374999950
		});
		expect((await summaryOf(p.scope, over)).available).toEqual({ kind: 'over' });
		expect((await summaryOf(p.scope, none)).available).toBeNull();
		expect(await summaryOf(p.scope, credit)).toMatchObject({
			owedMinor: 0,
			creditMinor: 500,
			available: { kind: 'available', minor: 100 }
		});
	});

	it('AC 6/7: paid, remaining and unbilled use only rows after the statement date; mismatch shown, never written', async () => {
		const p = await person();
		const bankId = await bank(p.scope);
		// The wallet owes exactly the printed new balance N = 1.250.000,50 at the statement date.
		const cardId = await card(p.scope, { openingBalanceMinor: -125000050, dueDay: 12 });
		await storeStatement(p.scope, cardId, {
			date: '2026-09-25',
			due: '2026-10-12',
			next: -125000050,
			minimum: 6250000
		});
		// A payment dated ON the statement date is inside the printed balance: not "paid since".
		await row(p.scope, {
			type: 'transfer',
			amount: 1,
			wallet: bankId,
			to: cardId,
			on: '2026-09-25'
		});
		await row(p.scope, {
			type: 'transfer',
			amount: 100000000,
			wallet: bankId,
			to: cardId,
			on: '2026-09-30'
		});
		await row(p.scope, { type: 'expense', amount: 2500000, wallet: cardId, on: '2026-10-01' });
		await row(p.scope, {
			type: 'income',
			amount: 500000,
			wallet: cardId,
			tile: 'lain',
			on: '2026-10-02'
		});
		const s = await summaryOf(p.scope, cardId);
		expect(s.bill).toMatchObject({
			paidMinor: 100000000,
			remainingMinor: 25000050,
			unbilledMinor: 2000000,
			statement: { statementDate: '2026-09-25', minimumPaymentMinor: 6250000 }
		});
		// The wallet: −125000050 + 1 + 100000000 − 2500000 + 500000 = −27000049; expected −27000050: 1 sen apart.
		expect(s.bill?.gapMinor).toBe(1);
		// Paid (remaining > 0) and past the printed due date (2026-10-12, today 2026-10-13): late by one WIB day.
		expect(s.due).toEqual({ kind: 'late', days: 1, date: '2026-10-12' });
		const adjustments = await d1
			.prepare(`select count(*) as n from transactions where space_id = ? and type = 'adjustment'`)
			.bind(p.scope.spaceId)
			.first<{ n: number }>();
		expect(adjustments?.n).toBe(0);
		// A payment larger than N: "Lunas", never a negative remainder; the next typed due day.
		await row(p.scope, {
			type: 'transfer',
			amount: 200000000,
			wallet: bankId,
			to: cardId,
			on: '2026-10-05'
		});
		const paid = await summaryOf(p.scope, cardId);
		expect(paid.bill?.remainingMinor).toBe(0);
		expect(paid.due).toEqual({ kind: 'in', days: 30, date: '2026-11-12' });
	});

	it('a "transfer"-tile income row in the card counts as paid and as an unmatched payment; demo rows never count (AC 45)', async () => {
		const p = await person();
		const cardId = await card(p.scope, { openingBalanceMinor: -1000000 });
		await storeStatement(p.scope, cardId, { date: '2026-09-25', next: -1000000 });
		await row(p.scope, {
			type: 'income',
			amount: 400000,
			wallet: cardId,
			tile: 'transfer',
			on: '2026-09-28'
		});
		await row(p.scope, {
			type: 'expense',
			amount: 999999,
			wallet: cardId,
			on: '2026-09-28',
			demo: true
		});
		await row(p.scope, {
			type: 'income',
			amount: 7,
			wallet: cardId,
			tile: 'transfer',
			on: '2026-09-28',
			demo: true
		});
		const s = await summaryOf(p.scope, cardId);
		expect(s).toMatchObject({
			owedMinor: 600000,
			unmatchedPayments: 1,
			bill: { paidMinor: 400000, remainingMinor: 600000, unbilledMinor: 0, gapMinor: 0 }
		});
	});

	it('AC 8: no stored statement: the next typed due day, clamped, from the WIB date', async () => {
		const p = await person();
		const cardId = await card(p.scope, { dueDay: 31 });
		expect((await summaryOf(p.scope, cardId, '2026-02-10')).due).toEqual({
			kind: 'in',
			days: 18,
			date: '2026-02-28'
		});
		expect((await summaryOf(p.scope, cardId, '2028-02-10')).due).toMatchObject({
			date: '2028-02-29'
		});
	});

	it('AC 40: summaries bind their ids once as JSON (more than 100 ids, no bound-parameter failure)', async () => {
		const p = await person();
		const cardId = await card(p.scope, { openingBalanceMinor: -1 });
		const many = Array.from({ length: 150 }, (_, i) => ({
			id: i === 0 ? cardId : `x-${i}`,
			currency: 'IDR',
			balanceMinor: -1,
			creditLimitMinor: null,
			dueDay: null
		}));
		const out = await cardSummaries(db, p.scope.spaceId, many, TODAY);
		expect(out).toHaveLength(150);
		expect(out[0]).toMatchObject({ walletId: cardId, owedMinor: 1, bill: null });
	});
});

describe('card page /dompet/kartu/[id] (AC 9, 36)', () => {
	it('a member sees the summary; another space, archived, bank and malformed ids are the same 404', async () => {
		const a = await person('A');
		const b = await person('B');
		const cardA = await card(a.scope, { openingBalanceMinor: -5000, creditLimitMinor: 10000 });
		const cardB = await card(b.scope);
		const bankA = await bank(a.scope);
		const archived = await card(a.scope, { name: 'Arsip' });
		await d1.prepare('update wallets set deleted_at = ? where id = ?').bind(NOW, archived).run();
		const ok = await loadCard(a, cardA);
		expect(ok).toMatchObject({
			kind: 'ok',
			value: {
				card: { id: cardA, creditLimitMinor: 10000 },
				balanceMinor: -5000,
				summary: { owedMinor: 5000, available: { kind: 'available', minor: 5000 } },
				loadError: null
			}
		});
		const answers = await Promise.all(
			[cardB, archived, bankA, 'x'.repeat(500), "'; drop table wallets; --"].map((id) =>
				loadCard(a, id)
			)
		);
		for (const r of answers)
			expect(r).toEqual({
				kind: 'error',
				status: 404,
				body: { message: 'Not found', status: 404 }
			});
	});

	it('a removed member gets the same 404 on the card page and the edit action', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const cardId = await card({ spaceId, userId: owner.user.id });
		expect(await loadCard(member, cardId, spaceId)).toMatchObject({ kind: 'ok' });
		const stale = await resolveCurrentSpace(db, member.user.id, spaceId);
		const memberRow = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: memberRow.id }, NOW);
		// A session still holding the old space (resolved before the removal) is refused by requireSpaceAccess.
		const staleLoad = await run(async () =>
			kartu.load(
				fakeEvent({
					url: `http://localhost/dompet/kartu/${cardId}`,
					routeId: '/(app)/dompet/kartu/[id]',
					db,
					user: member.user,
					space: stale,
					params: { id: cardId }
				}).event as never
			)
		);
		expect(staleLoad).toMatchObject({ kind: 'error', status: 404 });
		// The space cookie no longer resolves: the member's own space is used, where the id is not.
		expect(await loadCard(member, cardId, spaceId)).toEqual({
			kind: 'error',
			status: 404,
			body: { message: 'Not found', status: 404 }
		});
		const w = (await getWallet(db, spaceId, cardId))!;
		const edit = await postDompet(
			member,
			'updateWallet',
			{ ...cardForm({ lastFour: '' }), walletId: cardId, updatedAt: String(w.updatedAt) },
			spaceId
		);
		expect(edit).toMatchObject({ kind: 'fail', status: 404 });
		expect(await getWallet(db, spaceId, cardId)).toEqual(w);
	});
});

describe('paying the bill is a transfer (AC 10, 11, 17)', () => {
	it('AC 10: "Bayar tagihan" prefills a transfer to the card; saving moves both balances, totals unchanged', async () => {
		const p = await person();
		const bankId = await bank(p.scope);
		const cardId = await card(p.scope, { openingBalanceMinor: -125000050 });
		await storeStatement(p.scope, cardId, {
			date: '2026-09-25',
			next: -125000000,
			minimum: 5000000
		});
		const page = await run(async () =>
			baru.load(
				await ev(p, {
					path: `/riwayat/baru?type=transfer&ke=${cardId}&isi=tagihan`,
					routeId: '/(app)/riwayat/baru'
				})
			)
		);
		expect(page).toMatchObject({
			kind: 'ok',
			value: {
				values: {
					type: 'transfer',
					walletId: bankId,
					transferToWalletId: cardId,
					amount: '1.250.000'
				},
				cardFill: {
					cardId,
					bill: { minor: 125000000, typeable: true },
					minimum: { minor: 5000000, typeable: true }
				}
			}
		});
		// Another space's card id prefills nothing.
		const other = await person();
		const foreign = await run(async () =>
			baru.load(
				await ev(other, {
					path: `/riwayat/baru?type=transfer&ke=${cardId}`,
					routeId: '/(app)/riwayat/baru'
				})
			)
		);
		expect(foreign).toMatchObject({
			value: { cardFill: null, values: { transferToWalletId: '' } }
		});

		const period = {
			from: '2026-10-01',
			to: '2026-10-31',
			type: null,
			categoryId: null,
			walletId: null,
			q: null
		};
		const before = await periodTotals(db, p.scope.spaceId, period);
		await row(p.scope, {
			type: 'transfer',
			amount: 125000000,
			wallet: bankId,
			to: cardId,
			on: '2026-10-05'
		});
		const after = await periodTotals(db, p.scope.spaceId, period);
		expect(after.totals).toEqual(before.totals);
		expect(after.transferCount).toBe(before.transferCount + 1);
		const sums = await walletTransactionsSums(db, p.scope.spaceId);
		expect(1000000000 + (sums.get(bankId) ?? 0)).toBe(875000000);
		expect(-125000050 + (sums.get(cardId) ?? 0)).toBe(-50);
	});

	it('AC 11: a purchase counts on its WIB purchase date; the November payment is not November spending', async () => {
		const p = await person();
		const bankId = await bank(p.scope);
		const cardId = await card(p.scope);
		// 23:30 WIB on 31 October and 00:30 WIB on 1 November: occurred_on is the WIB date.
		await row(p.scope, {
			type: 'expense',
			amount: 2500000,
			wallet: cardId,
			on: '2026-10-31',
			time: '23:30'
		});
		await row(p.scope, {
			type: 'expense',
			amount: 1100000,
			wallet: cardId,
			on: '2026-11-01',
			time: '00:30'
		});
		await row(p.scope, {
			type: 'transfer',
			amount: 2500000,
			wallet: bankId,
			to: cardId,
			on: '2026-11-05'
		});
		const month = (from: string, to: string) =>
			periodTotals(db, p.scope.spaceId, {
				from,
				to,
				type: null,
				categoryId: null,
				walletId: null,
				q: null
			});
		expect((await month('2026-10-01', '2026-10-31')).totals).toEqual([
			{ currency: 'IDR', inMinor: 0, outMinor: 2500000 }
		]);
		expect((await month('2026-11-01', '2026-11-30')).totals).toEqual([
			{ currency: 'IDR', inMinor: 0, outMinor: 1100000 }
		]);
	});

	it('AC 17: fees and interest are card expenses in their month (biaya-bank); a refund is income, nothing netted', async () => {
		const p = await person();
		const cardId = await card(p.scope);
		await row(p.scope, {
			type: 'expense',
			amount: 7500000,
			wallet: cardId,
			tile: 'biaya-bank',
			on: '2026-10-25'
		});
		await row(p.scope, {
			type: 'expense',
			amount: 12345678,
			wallet: cardId,
			tile: 'biaya-bank',
			on: '2026-10-25'
		});
		await row(p.scope, {
			type: 'income',
			amount: 5000000,
			wallet: cardId,
			tile: 'lain',
			on: '2026-10-26'
		});
		const t = await periodTotals(db, p.scope.spaceId, {
			from: '2026-10-01',
			to: '2026-10-31',
			type: null,
			categoryId: null,
			walletId: cardId,
			q: null
		});
		expect(t).toMatchObject({
			expenseCount: 2,
			incomeCount: 1,
			totals: [{ currency: 'IDR', inMinor: 5000000, outMinor: 19845678 }]
		});
	});
});

describe('net worth: card debt on the Utang line (AC 12)', () => {
	it('a negative card balance is in debt, the total is unchanged, a card at or above zero stays in wallets', () => {
		const book = { coins: new Map(), fx: new Map(), gold: null } as unknown as Parameters<
			typeof summarizeNetWorth
		>[2];
		const wallets = [
			{ currency: 'IDR', balanceMinor: 500000000, type: 'bank' as const },
			{ currency: 'IDR', balanceMinor: -125000050, type: 'kartu_kredit' as const },
			{ currency: 'IDR', balanceMinor: 0, type: 'kartu_kredit' as const },
			{ currency: 'IDR', balanceMinor: 700, type: 'kartu_kredit' as const }
		];
		const withCards = summarizeNetWorth(wallets, [], book, NOW);
		const legacy = summarizeNetWorth(
			wallets.map(({ currency, balanceMinor }) => ({ currency, balanceMinor })),
			[],
			book,
			NOW
		);
		expect(withCards.totalMinor).toBe(legacy.totalMinor);
		expect(withCards.totalMinor).toBe(375000650);
		expect(withCards.classes).toEqual([
			{ cls: 'wallets', minor: 500000700 },
			{ cls: 'debt', minor: -125000050 }
		]);
		expect(legacy.classes).toEqual([{ cls: 'wallets', minor: 375000650 }]);
	});

	it('FN-53: the daily snapshot stores the card debt in its per-class split (total unchanged)', async () => {
		const p = await person();
		await bank(p.scope);
		await card(p.scope, { openingBalanceMinor: -125000050 });
		const book = { coins: new Map(), fx: new Map(), gold: null } as unknown as Parameters<
			typeof writeSnapshots
		>[1];
		for (let i = 0; i < 5; i++) await writeSnapshots(db, book, NOW + i, () => 1000);
		const snap = await d1
			.prepare('select total_minor, classes from net_worth_snapshots where space_id = ?')
			.bind(p.scope.spaceId)
			.first<{ total_minor: number; classes: string }>();
		expect(snap?.total_minor).toBe(874999950);
		expect(JSON.parse(snap!.classes)).toEqual({ wallets: 1000000000, debt: -125000050 });
	});

	it('the stored summary (and so the snapshot) reads the card from D1', async () => {
		const p = await person();
		await bank(p.scope);
		await card(p.scope, { openingBalanceMinor: -125000050 });
		const book = { coins: new Map(), fx: new Map(), gold: null } as unknown as Parameters<
			typeof netWorthSummary
		>[2];
		const s = await netWorthSummary(db, p.scope.spaceId, book, NOW);
		expect(s.totalMinor).toBe(1000000000 - 125000050);
		expect(s.classes).toEqual([
			{ cls: 'wallets', minor: 1000000000 },
			{ cls: 'debt', minor: -125000050 }
		]);
	});
});

describe('card payment pairing (AC 14-16, 39)', () => {
	async function setup() {
		const p = await person();
		const bankId = await bank(p.scope);
		const cardId = await card(p.scope, { openingBalanceMinor: -100000000 });
		return { p, bankId, cardId };
	}

	it('AC 14: a "kartu-kredit" bank debit and the card\'s payment 2 days later pair, merge into one transfer and undo exactly', async () => {
		const { p, bankId, cardId } = await setup();
		const debit = await row(p.scope, {
			type: 'expense',
			amount: 100000000,
			wallet: bankId,
			tile: 'kartu-kredit',
			on: '2026-10-12'
		});
		const credit = await row(p.scope, {
			type: 'income',
			amount: 100000000,
			wallet: cardId,
			tile: 'transfer',
			on: '2026-10-14'
		});
		const before = await d1
			.prepare('select * from transactions where id in (?, ?) order by id')
			.bind(debit, credit)
			.all();
		const preview = await proposeTransferMatches(db, p.scope.spaceId);
		expect(preview.groups).toHaveLength(1);
		const pair = preview.groups[0]!.pairs[0]!;
		expect(pair).toMatchObject({ kind: 'card', debit: { id: debit }, credit: { id: credit } });
		const applied = await applyTransferMatch(
			db,
			p.scope,
			{
				debitId: debit,
				creditId: credit,
				debitUpdatedAt: pair.debit.updatedAt,
				creditUpdatedAt: pair.credit.updatedAt
			},
			NOW + 1
		);
		expect(applied.status).toBe('ok');
		const merged = await d1
			.prepare(
				'select id, type, transfer_to_wallet_id, category_id, deleted_at, dedupe_key from transactions where id in (?, ?) order by id'
			)
			.bind(debit, credit)
			.all();
		expect(merged.results.find((r) => r.id === debit)).toMatchObject({
			type: 'transfer',
			transfer_to_wallet_id: cardId,
			category_id: null,
			deleted_at: null
		});
		expect(merged.results.find((r) => r.id === credit)).toMatchObject({ deleted_at: NOW + 1 });
		const sums = await walletTransactionsSums(db, p.scope.spaceId);
		expect(sums.get(bankId)).toBe(-100000000);
		expect(sums.get(cardId)).toBe(100000000);
		const october = await periodTotals(db, p.scope.spaceId, {
			from: '2026-10-01',
			to: '2026-10-31',
			type: null,
			categoryId: null,
			walletId: null,
			q: null
		});
		expect(october.totals).toEqual([]);
		if (applied.status !== 'ok') throw new Error('not merged');
		expect(await undoTransferMatch(db, p.scope, applied.linkId, NOW + 2)).toBe('ok');
		const restored = await d1
			.prepare('select * from transactions where id in (?, ?) order by id')
			.bind(debit, credit)
			.all();
		const content = (r: Record<string, unknown>) =>
			Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'updated_at' && k !== 'seq'));
		expect(restored.results.map(content)).toEqual(before.results.map(content));
	});

	it('AC 15: 4 days later no pair; 1 day before a pair; two candidates are one ambiguous group; one sen apart no pair', async () => {
		const { p, bankId, cardId } = await setup();
		await row(p.scope, {
			type: 'expense',
			amount: 100000000,
			wallet: bankId,
			tile: 'kartu-kredit',
			on: '2026-10-12'
		});
		await row(p.scope, {
			type: 'income',
			amount: 100000000,
			wallet: cardId,
			tile: 'transfer',
			on: '2026-10-16'
		});
		await row(p.scope, {
			type: 'income',
			amount: 100000001,
			wallet: cardId,
			tile: 'transfer',
			on: '2026-10-13'
		});
		expect(await countTransferMatches(db, p.scope.spaceId)).toBe(0);
		await row(p.scope, {
			type: 'income',
			amount: 100000000,
			wallet: cardId,
			tile: 'transfer',
			on: '2026-10-11'
		});
		expect(await countTransferMatches(db, p.scope.spaceId)).toBe(1);
		await row(p.scope, {
			type: 'income',
			amount: 100000000,
			wallet: cardId,
			tile: 'transfer',
			on: '2026-10-15'
		});
		const preview = await proposeTransferMatches(db, p.scope.spaceId);
		expect(preview.groups).toHaveLength(1);
		expect(preview.groups[0]).toMatchObject({ ambiguous: true });
		expect(preview.groups[0]!.pairs).toHaveLength(2);
	});

	it('AC 16: no card wallet, no proposal (the debit stays spending); a credit in a non-card wallet keeps the ±1 day rule', async () => {
		const p = await person();
		const bankId = await bank(p.scope);
		const other = await bank(p.scope, 'Tabungan');
		await row(p.scope, {
			type: 'expense',
			amount: 5000000,
			wallet: bankId,
			tile: 'kartu-kredit',
			on: '2026-10-12'
		});
		await row(p.scope, {
			type: 'income',
			amount: 5000000,
			wallet: other,
			tile: 'transfer',
			on: '2026-10-13'
		});
		expect(await countTransferMatches(db, p.scope.spaceId)).toBe(0);
		const t = await periodTotals(db, p.scope.spaceId, {
			from: '2026-10-01',
			to: '2026-10-31',
			type: 'expense',
			categoryId: null,
			walletId: null,
			q: null
		});
		expect(t.totals).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: 5000000 }]);
		// An own transfer pair (transfer tiles) two days apart is still not a pair.
		await row(p.scope, {
			type: 'expense',
			amount: 700,
			wallet: bankId,
			tile: 'transfer',
			on: '2026-10-12'
		});
		await row(p.scope, {
			type: 'income',
			amount: 700,
			wallet: other,
			tile: 'transfer',
			on: '2026-10-14'
		});
		expect(await countTransferMatches(db, p.scope.spaceId)).toBe(0);
	});

	it('cross-space: another space\'s card pair is "missing"; 20 concurrent confirms merge the pair once', async () => {
		const { p, bankId, cardId } = await setup();
		const debit = await row(p.scope, {
			type: 'expense',
			amount: 300,
			wallet: bankId,
			tile: 'transfer',
			on: '2026-10-12'
		});
		const credit = await row(p.scope, {
			type: 'income',
			amount: 300,
			wallet: cardId,
			tile: 'transfer',
			on: '2026-10-15'
		});
		const [pair] = (await proposeTransferMatches(db, p.scope.spaceId)).groups[0]!.pairs;
		const choice = {
			debitId: debit,
			creditId: credit,
			debitUpdatedAt: pair!.debit.updatedAt,
			creditUpdatedAt: pair!.credit.updatedAt
		};
		const stranger = await person();
		expect(await applyTransferMatch(db, stranger.scope, choice, NOW)).toEqual({
			status: 'missing'
		});
		const results = await Promise.all(
			Array.from({ length: 20 }, () => applyTransferMatch(db, p.scope, choice, NOW + 5))
		);
		expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
		const links = await d1
			.prepare('select count(*) as n from transfer_links where space_id = ? and undone_at is null')
			.bind(p.scope.spaceId)
			.first<{ n: number }>();
		expect(links?.n).toBe(1);
	});
});
