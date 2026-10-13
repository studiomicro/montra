import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { previewCsv } from '#lib/server/imports/csv-import';
import { updateViaApi } from '#lib/server/api/transactions';
import {
	createSplit,
	deleteSplit,
	getSplit,
	linkSplit,
	listSplits,
	owedToViewer,
	setParticipantPaid,
	unlinkSplit,
	updateSplit,
	type SplitFields
} from '#lib/server/patungan/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { pushQueuedWrite } from '#lib/server/sync/push';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import {
	createSharedSpace,
	leaveSpace,
	listMembers,
	purgeSpaces,
	removeMember
} from '#lib/server/spaces/spaces';
import { periodTotals, type TransactionFilter } from '#lib/server/transactions/aggregate';
import {
	createTransaction,
	deleteTransaction,
	getTransaction,
	updateTransaction
} from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { TEMPLATE_COLUMNS } from '#lib/shared/csv';
import { monthOf, monthRange, wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/**
 * FN-49 Patungan pass 1, D1-backed: both create paths (link an existing bill; write the payer's own share), the
 * equal/exact rounding through the real form action, every link/unlink/edit/delete cascade, the link lock on the
 * transaction edit paths, settling (never moves a total), the payment lock, payer-only writes, two users and two
 * spaces, a removed member, the space purge and the DB-level guards (CHECK, unique index, same-space trigger).
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const listPage = await import('../../src/routes/(app)/patungan/+page.server');
const newPage = await import('../../src/routes/(app)/patungan/baru/+page.server');
const splitPage = await import('../../src/routes/(app)/patungan/[id]/+page.server');
const editPage = await import('../../src/routes/(app)/patungan/[id]/ubah/+page.server');
const txEditPage = await import('../../src/routes/(app)/riwayat/[id]/edit/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.now();
const TODAY = wibTodayString(NOW);
const MONTH: TransactionFilter = {
	...monthRange(monthOf(TODAY)),
	type: 'expense',
	categoryId: null,
	walletId: null,
	q: null
};

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function person(name: string) {
	const email = `patungan${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const spaceId = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	return { user: { id: r.userId, email, name, createdAt: 0 }, spaceId };
}
type Person = Awaited<ReturnType<typeof person>>;
const scopeOf = (p: Person, spaceId = p.spaceId): SpaceScope => ({ spaceId, userId: p.user.id });

/** A wallet and the "makan" category in the space, and a helper writing expenses there. */
async function books(p: Person, spaceId = p.spaceId) {
	const scope = scopeOf(p, spaceId);
	await ensurePresetCategories(db, spaceId, NOW);
	const cats = await listCategories(db, spaceId);
	const w = await createWallet(
		db,
		scope,
		{
			name: 'BCA',
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		NOW
	);
	if (!w.ok) throw new Error('wallet failed');
	const makan = cats.find((c) => c.tileKey === 'makan')!.id;
	const gaji = cats.find((c) => c.tileKey === 'gaji')!.id;
	const tx = async (amountMinor: number, over: Partial<TransactionInput> = {}) => {
		const t = await createTransaction(
			db,
			scope,
			{
				type: 'expense',
				amountMinor,
				currency: 'IDR',
				walletId: w.id,
				transferToWalletId: null,
				categoryId: makan,
				title: 'Makan bareng',
				note: null,
				occurredOn: TODAY,
				occurredTime: null,
				...over
			},
			NOW
		);
		if (!t.ok) throw new Error('transaction failed');
		return t.id;
	};
	return { scope, walletId: w.id, makan, gaji, tx };
}

const spent = async (spaceId: string) =>
	(await periodTotals(db, spaceId, MONTH)).totals.find((t) => t.currency === 'IDR')?.outMinor ?? 0;

async function event(
	who: Person | null,
	path: string,
	opts: {
		routeId: string;
		form?: [string, string][];
		params?: Record<string, string>;
		space?: string;
		cookies?: Record<string, string>;
	}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, opts.space) : null;
	return fakeEvent({
		url: `http://localhost${path}`,
		routeId: opts.routeId,
		db,
		user: who?.user ?? null,
		space,
		form: opts.form,
		params: opts.params,
		cookies: opts.cookies
	}).event as never;
}

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
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status };
		throw e;
	}
}

/** The create form: title, mode and people; `bill` links that transaction, else wallet + category. */
function createForm(o: {
	clientId: string;
	mode?: string;
	amount?: string;
	bill?: string;
	walletId?: string;
	categoryId?: string;
	members?: string[];
	guests?: [string, string][];
	payerShare?: string;
	memberShares?: Record<string, string>;
	title?: string;
}): [string, string][] {
	const form: [string, string][] = [
		['clientId', o.clientId],
		['title', o.title ?? 'Makan bareng'],
		['occurredOn', TODAY],
		['mode', o.mode ?? 'equal'],
		['amount', o.amount ?? ''],
		['payerShare', o.payerShare ?? ''],
		['note', '']
	];
	if (o.bill) form.push(['bill', o.bill]);
	if (o.walletId) form.push(['walletId', o.walletId]);
	if (o.categoryId) form.push(['categoryId', o.categoryId]);
	for (const m of o.members ?? []) {
		form.push(['member', m]);
		form.push([`memberShare.${m}`, o.memberShares?.[m] ?? '']);
	}
	for (const [name, share] of o.guests ?? []) {
		form.push(['guestName', name]);
		form.push(['guestShare', share]);
	}
	// An empty guest row, as the form always posts: no guest.
	form.push(['guestName', '']);
	form.push(['guestShare', '']);
	return form;
}

const create = async (who: Person, form: [string, string][], space?: string) =>
	run(async () =>
		newPage.actions.create!(
			await event(who, '/patungan/baru', { routeId: '/(app)/patungan/baru', form, space })
		)
	);

const splitAction = async (
	name: keyof typeof splitPage.actions,
	who: Person,
	id: string,
	form: [string, string][] = [],
	space?: string
) =>
	run(async () =>
		(splitPage.actions[name] as (e: never) => unknown)(
			await event(who, `/patungan/${id}`, {
				routeId: '/(app)/patungan/[id]',
				form,
				params: { id },
				space
			})
		)
	);

const row = async (id: string) =>
	db.get<{
		amount_minor: number | null;
		currency: string | null;
		source: string;
		dedupe_key: string | null;
		patungan_split_id: string | null;
		patungan_effective_amount_minor: number | null;
		deleted_at: number | null;
	}>(sql`select amount_minor, currency, source, dedupe_key, patungan_split_id,
		patungan_effective_amount_minor, deleted_at from transactions where id = ${id}`);

const twoGuests: [string, string][] = [
	['Rina', ''],
	['Dodi', '']
];

describe('creating a split', () => {
	it('links an existing bill: its stored amount never changes, every total counts the payer share', async () => {
		const a = await person('Ayu');
		const b = await books(a);
		const bill = await b.tx(40_000_000);
		const before = await row(bill);
		const clientId = crypto.randomUUID();
		const r = await create(
			a,
			createForm({
				clientId,
				bill,
				guests: [
					['Rina', ''],
					['Dodi', ''],
					['Eko', '']
				]
			})
		);
		expect(r).toEqual({
			kind: 'redirect',
			status: 303,
			location: `/patungan/${clientId}?saved=created`
		});
		const split = (await getSplit(db, a.spaceId, clientId))!;
		expect(split.participants.map((p) => [p.displayName, p.shareAmountMinor, p.isPayer])).toEqual([
			['Ayu', 10_000_000, true],
			['Rina', 10_000_000, false],
			['Dodi', 10_000_000, false],
			['Eko', 10_000_000, false]
		]);
		expect(split.linked).toMatchObject({
			id: bill,
			amountMinor: 40_000_000,
			effectiveAmountMinor: 10_000_000
		});
		const after = await row(bill);
		expect({ ...after, patungan_split_id: null, patungan_effective_amount_minor: null }).toEqual({
			...before,
			patungan_split_id: null,
			patungan_effective_amount_minor: null
		});
		expect(after?.patungan_effective_amount_minor).toBe(10_000_000);
		expect(await spent(a.spaceId)).toBe(10_000_000);

		// A resend of the same form writes nothing twice and lands on the same split.
		const again = await create(
			a,
			createForm({
				clientId,
				bill,
				guests: [
					['Rina', ''],
					['Dodi', ''],
					['Eko', '']
				]
			})
		);
		expect(again).toMatchObject({
			kind: 'redirect',
			location: `/patungan/${clientId}?saved=created`
		});
		const count = await db.get<{ n: number }>(
			sql`select count(*) as n from patungan_splits where space_id = ${a.spaceId}`
		);
		expect(count?.n).toBe(1);
	});

	it('equal split: Rp 100.000 among 3 is 33.333, 33.333 and 33.334 for the payer (AC-1)', async () => {
		const a = await person('Ayu');
		const b = await books(a);
		const clientId = crypto.randomUUID();
		const r = await create(
			a,
			createForm({
				clientId,
				amount: '100.000',
				walletId: b.walletId,
				categoryId: b.makan,
				guests: twoGuests
			})
		);
		expect(r.kind).toBe('redirect');
		const split = (await getSplit(db, a.spaceId, clientId))!;
		expect(split.participants.map((p) => p.shareAmountMinor)).toEqual([
			3_333_400, 3_333_300, 3_333_300
		]);
		// No bill picked: exactly one new expense of the payer's own share only (AC-9).
		expect(split.linked).toMatchObject({
			amountMinor: 3_333_400,
			effectiveAmountMinor: 3_333_400,
			ownShare: true
		});
		const tx = await getTransaction(db, a.spaceId, split.linked!.id);
		expect(tx).toMatchObject({
			type: 'expense',
			amountMinor: 3_333_400,
			source: 'manual',
			walletId: b.walletId
		});
		expect(await spent(a.spaceId)).toBe(3_333_400);
	});

	it('exact split: amounts not adding up are refused per field and nothing is written (AC-3)', async () => {
		const a = await person('Ayu');
		const b = await books(a);
		const before = await db.get<{ n: number }>(sql`select count(*) as n from transactions`);
		const r = await create(
			a,
			createForm({
				clientId: crypto.randomUUID(),
				mode: 'exact',
				amount: '100.000',
				payerShare: '50.000',
				walletId: b.walletId,
				categoryId: b.makan,
				guests: [['Rina', '30.000']]
			})
		);
		expect(r).toMatchObject({ kind: 'fail', status: 400 });
		expect((r as unknown as { data: { errors: Record<string, string> } }).data.errors).toEqual({
			shares: 'Jumlah semua bagian harus sama dengan totalnya.'
		});
		const empty = await create(
			a,
			createForm({
				clientId: crypto.randomUUID(),
				mode: 'exact',
				amount: '100.000',
				payerShare: '',
				walletId: b.walletId,
				categoryId: b.makan,
				guests: [['Rina', '100.000']]
			})
		);
		expect(
			(empty as unknown as { data: { errors: Record<string, string> } }).data.errors.payerShare
		).toBe('Isi bagian setiap orang lebih dari 0.');
		expect(await db.get<{ n: number }>(sql`select count(*) as n from transactions`)).toEqual(
			before
		);
		expect(await listSplits(db, b.scope)).toEqual([]);

		const ok = await create(
			a,
			createForm({
				clientId: crypto.randomUUID(),
				mode: 'exact',
				amount: '100.000',
				payerShare: '70.000',
				walletId: b.walletId,
				categoryId: b.makan,
				guests: [['Rina', '30.000']]
			})
		);
		expect(ok.kind).toBe('redirect');
		expect(await spent(a.spaceId)).toBe(7_000_000);
	});

	it('refuses a bill that is not a live, real, unlinked expense of the space, or of another total (AC-10/11)', async () => {
		const a = await person('Ayu');
		const b = await books(a);
		const income = await b.tx(40_000_000, { type: 'income', categoryId: b.gaji });
		const other = await person('Citra');
		const ob = await books(other);
		const foreign = await ob.tx(40_000_000);
		for (const bill of [income, foreign, crypto.randomUUID()]) {
			const r = await create(
				a,
				createForm({ clientId: crypto.randomUUID(), bill, guests: twoGuests })
			);
			expect(r).toMatchObject({ kind: 'fail', status: 409 });
		}
		// Already linked to another split.
		const bill = await b.tx(40_000_000);
		expect(
			(await create(a, createForm({ clientId: crypto.randomUUID(), bill, guests: twoGuests }))).kind
		).toBe('redirect');
		expect(
			await create(a, createForm({ clientId: crypto.randomUUID(), bill, guests: twoGuests }))
		).toMatchObject({ kind: 'fail', status: 409 });
		// The repo refuses a total that is not the bill's exactly (the form fixes it, a forged call cannot).
		const loose = await b.tx(50_000_000);
		const fields: SplitFields = {
			title: 'X',
			occurredOn: TODAY,
			note: null,
			mode: 'equal',
			totalAmountMinor: 40_000_000,
			participants: [
				{
					kind: 'member',
					memberUserId: a.user.id,
					displayName: 'Ayu',
					shareAmountMinor: 20_000_000
				},
				{ kind: 'guest', memberUserId: null, displayName: 'Rina', shareAmountMinor: 20_000_000 }
			]
		};
		expect(
			await createSplit(
				db,
				b.scope,
				crypto.randomUUID(),
				fields,
				'IDR',
				{ kind: 'link', transactionId: loose },
				NOW
			)
		).toEqual({ ok: false, reason: 'bill' });
		expect((await row(loose))?.patungan_split_id).toBeNull();
	});

	it('10 concurrent creates linking the same bill: exactly one wins', async () => {
		const a = await person('Ayu');
		const b = await books(a);
		const bill = await b.tx(40_000_000);
		const fields: SplitFields = {
			title: 'X',
			occurredOn: TODAY,
			note: null,
			mode: 'equal',
			totalAmountMinor: 40_000_000,
			participants: [
				{
					kind: 'member',
					memberUserId: a.user.id,
					displayName: 'Ayu',
					shareAmountMinor: 20_000_000
				},
				{ kind: 'guest', memberUserId: null, displayName: 'Rina', shareAmountMinor: 20_000_000 }
			]
		};
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				createSplit(
					db,
					b.scope,
					crypto.randomUUID(),
					fields,
					'IDR',
					{ kind: 'link', transactionId: bill },
					NOW
				)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const splits = await db.get<{ n: number }>(
			sql`select count(*) as n from patungan_splits where space_id = ${a.spaceId}`
		);
		expect(splits?.n).toBe(1);
	});
});

describe('a linked bill', () => {
	async function linked() {
		const a = await person('Ayu');
		const b = await books(a);
		const bill = await b.tx(40_000_000);
		const id = crypto.randomUUID();
		await create(
			a,
			createForm({
				clientId: id,
				bill,
				guests: [
					['Rina', ''],
					['Dodi', ''],
					['Eko', '']
				]
			})
		);
		return { a, b, bill, id };
	}

	it('keeps its amount, currency and type on every edit path; the rest stays editable (AC-12)', async () => {
		const { a, b, bill } = await linked();
		const current = (await getTransaction(db, a.spaceId, bill))!;
		const base: TransactionInput = {
			type: 'expense',
			amountMinor: current.amountMinor,
			currency: 'IDR',
			walletId: b.walletId,
			transferToWalletId: null,
			categoryId: b.makan,
			title: current.title,
			note: null,
			occurredOn: TODAY,
			occurredTime: null
		};
		expect(
			await updateTransaction(
				db,
				b.scope,
				bill,
				{ ...base, amountMinor: 30_000_000 },
				current.updatedAt,
				NOW
			)
		).toBe('linked');
		expect(
			await updateTransaction(
				db,
				b.scope,
				bill,
				{ ...base, type: 'income', categoryId: b.gaji },
				current.updatedAt,
				NOW
			)
		).toBe('linked');
		// The edit page says why.
		const page = await run(async () =>
			txEditPage.actions.update!(
				await event(a, `/riwayat/${bill}/edit`, {
					routeId: '/(app)/riwayat/[id]/edit',
					params: { id: bill },
					form: [
						['type', 'expense'],
						['amount', '300.000'],
						['walletId', b.walletId],
						['categoryId', b.makan],
						['title', 'Makan bareng'],
						['note', ''],
						['occurredOn', TODAY],
						['occurredTime', ''],
						['updatedAt', String(current.updatedAt)]
					]
				})
			)
		);
		expect(page).toMatchObject({
			kind: 'fail',
			status: 409,
			data: {
				error:
					'Transaksi ini tertaut ke patungan. Lepas tautannya dulu untuk mengubah jumlah, mata uang atau jenisnya.'
			}
		});
		expect((await row(bill))?.amount_minor).toBe(40_000_000);
		// Title, note and date are free.
		expect(
			await updateTransaction(
				db,
				b.scope,
				bill,
				{ ...base, title: 'Makan malam', note: 'Ulang tahun' },
				current.updatedAt,
				NOW
			)
		).toBe('ok');
		expect((await row(bill))?.patungan_effective_amount_minor).toBe(10_000_000);
	});

	it('editing the shares while unlocked moves the counted share in the same write (AC-13)', async () => {
		const { a, b, id } = await linked();
		const split = (await getSplit(db, a.spaceId, id))!;
		const r = await run(async () =>
			editPage.actions.update!(
				await event(a, `/patungan/${id}/ubah`, {
					routeId: '/(app)/patungan/[id]/ubah',
					params: { id },
					form: [
						['updatedAt', String(split.updatedAt)],
						['title', 'Makan bareng'],
						['occurredOn', TODAY],
						['note', ''],
						['mode', 'exact'],
						// Ignored: a linked bill fixes the total.
						['amount', '1'],
						['payerShare', '250.000'],
						['guestName', 'Rina'],
						['guestShare', '150.000']
					]
				})
			)
		);
		expect(r).toMatchObject({ kind: 'redirect', location: `/patungan/${id}?saved=updated` });
		const after = (await getSplit(db, a.spaceId, id))!;
		expect(after.participants.map((p) => p.shareAmountMinor)).toEqual([25_000_000, 15_000_000]);
		expect(after.linked?.effectiveAmountMinor).toBe(25_000_000);
		expect(await spent(a.spaceId)).toBe(25_000_000);
		expect((await row(after.linked!.id))?.amount_minor).toBe(40_000_000);
		// The old participant rows are content-free tombstones.
		const dead = await db.all<{ display_name: string | null }>(
			sql`select display_name from patungan_participants where split_id = ${id} and deleted_at is not null`
		);
		expect(dead.length).toBe(4);
		expect(dead.every((d) => d.display_name === null)).toBe(true);
		void b;
	});

	it('"Lepas tautan" counts the transaction in full again; it can be linked back (AC-14)', async () => {
		const { a, bill, id } = await linked();
		expect(await splitAction('unlink', a, id)).toMatchObject({
			kind: 'redirect',
			location: `/patungan/${id}?saved=unlinked`
		});
		expect(await row(bill)).toMatchObject({
			patungan_split_id: null,
			patungan_effective_amount_minor: null,
			amount_minor: 40_000_000
		});
		expect(await spent(a.spaceId)).toBe(40_000_000);
		expect((await getSplit(db, a.spaceId, id))!.linked).toBeNull();
		expect(await splitAction('link', a, id, [['transaction', bill]])).toMatchObject({
			kind: 'redirect'
		});
		expect(await spent(a.spaceId)).toBe(10_000_000);
		expect(await linkSplit(db, { spaceId: a.spaceId, userId: a.user.id }, id, bill, NOW)).toBe(
			'already'
		);
	});

	it('deleting the split unlinks the bill, never deletes it (AC-15)', async () => {
		const { a, bill, id } = await linked();
		const split = (await getSplit(db, a.spaceId, id))!;
		const r = await splitAction('delete', a, id, [['updatedAt', String(split.updatedAt)]]);
		expect(r).toMatchObject({ kind: 'redirect', location: '/patungan?saved=deleted' });
		expect(await row(bill)).toMatchObject({
			deleted_at: null,
			patungan_split_id: null,
			amount_minor: 40_000_000
		});
		expect(await spent(a.spaceId)).toBe(40_000_000);
		const tomb = await db.get<{ title: string | null; total: number | null }>(
			sql`select title, total_amount_minor as total from patungan_splits where id = ${id}`
		);
		expect(tomb).toEqual({ title: null, total: null });
		const people = await db.get<{ n: number }>(
			sql`select count(*) as n from patungan_participants where split_id = ${id} and deleted_at is null`
		);
		expect(people?.n).toBe(0);
	});

	it('deleting the bill through Riwayat unlinks it with no Patungan code; nothing is recreated (AC-16)', async () => {
		const { a, b, bill, id } = await linked();
		const before = await db.get<{ n: number }>(
			sql`select count(*) as n from transactions where space_id = ${a.spaceId}`
		);
		const current = (await getTransaction(db, a.spaceId, bill))!;
		expect(await deleteTransaction(db, b.scope, bill, current.updatedAt, NOW)).toBe('ok');
		expect(await row(bill)).toMatchObject({
			amount_minor: null,
			patungan_split_id: null,
			patungan_effective_amount_minor: null
		});
		expect(await spent(a.spaceId)).toBe(0);
		const split = (await getSplit(db, a.spaceId, id))!;
		expect(split.linked).toBeNull();
		expect(split.participants).toHaveLength(4);
		expect(
			await db.get<{ n: number }>(
				sql`select count(*) as n from transactions where space_id = ${a.spaceId}`
			)
		).toEqual(before);
	});

	it('settling never moves a total; it is idempotent and locks the shares (AC-17, AC-20, locking)', async () => {
		const { a, b, id } = await linked();
		const split = (await getSplit(db, a.spaceId, id))!;
		const rina = split.participants[1]!;
		const totals = async () => [
			await periodTotals(db, a.spaceId, MONTH),
			await owedToViewer(db, b.scope)
		];
		const [periodBefore] = await totals();
		expect(await owedToViewer(db, b.scope)).toEqual([{ currency: 'IDR', owedMinor: 30_000_000 }]);
		expect(await splitAction('settle', a, id, [['participant', rina.id]])).toMatchObject({
			kind: 'redirect'
		});
		expect(await splitAction('settle', a, id, [['participant', rina.id]])).toMatchObject({
			kind: 'redirect'
		});
		const [periodAfter, owedAfter] = await totals();
		expect(periodAfter).toEqual(periodBefore);
		expect(owedAfter).toEqual([{ currency: 'IDR', owedMinor: 20_000_000 }]);
		const settled = (await getSplit(db, a.spaceId, id))!;
		expect(settled.participants[1]).toMatchObject({ paidAmountMinor: 10_000_000 });
		expect(settled.participants[1]!.paidAt).not.toBeNull();
		expect(settled.locked).toBe(true);
		// The payer's own row cannot be settled (nobody owes themselves).
		expect(await setParticipantPaid(db, b.scope, id, settled.participants[0]!.id, true, NOW)).toBe(
			'missing'
		);

		// Locked: people and shares are refused server-side; title/date/note still work.
		const fields: SplitFields = {
			title: 'X',
			occurredOn: TODAY,
			note: null,
			mode: 'equal',
			totalAmountMinor: 40_000_000,
			participants: [
				{
					kind: 'member',
					memberUserId: a.user.id,
					displayName: 'Ayu',
					shareAmountMinor: 20_000_000
				},
				{ kind: 'guest', memberUserId: null, displayName: 'Rina', shareAmountMinor: 20_000_000 }
			]
		};
		expect(await updateSplit(db, b.scope, id, fields, settled.updatedAt, NOW)).toBe('locked');
		const details = await run(async () =>
			editPage.actions.details!(
				await event(a, `/patungan/${id}/ubah`, {
					routeId: '/(app)/patungan/[id]/ubah',
					params: { id },
					form: [
						['updatedAt', String(settled.updatedAt)],
						['title', 'Makan malam'],
						['occurredOn', TODAY],
						['note', 'Lunas sebagian']
					]
				})
			)
		);
		expect(details).toMatchObject({ kind: 'redirect' });
		expect((await getSplit(db, a.spaceId, id))!.title).toBe('Makan malam');
		// "Batalkan lunas" undoes a mistaken tap.
		expect(await splitAction('unsettle', a, id, [['participant', rina.id]])).toMatchObject({
			kind: 'redirect'
		});
		expect((await getSplit(db, a.spaceId, id))!.locked).toBe(false);
	});

	it('the offline queue and the public API refuse the amount change too (two devices, FN-38)', async () => {
		const { a, b, bill } = await linked();
		const current = (await getTransaction(db, a.spaceId, bill))!;
		const queued = await pushQueuedWrite(
			db,
			a.user.id,
			{
				clientId: crypto.randomUUID(),
				accountId: a.user.id,
				spaceId: a.spaceId,
				kind: 'transaction.update',
				targetId: bill,
				expectedUpdatedAt: current.updatedAt,
				payload: [
					['type', 'expense'],
					['amount', '300.000'],
					['walletId', b.walletId],
					['categoryId', b.makan],
					['title', 'Makan bareng'],
					['note', ''],
					['occurredOn', TODAY],
					['occurredTime', '']
				]
			},
			NOW,
			'id'
		);
		expect(queued.status).toBe(400);
		expect(queued.body).toMatchObject({
			result: 'invalid',
			message:
				'Transaksi ini tertaut ke patungan. Lepas tautannya dulu untuk mengubah jumlah, mata uang atau jenisnya.'
		});
		await expect(
			updateViaApi(
				db,
				b.scope,
				bill,
				{ amount_minor: 30_000_000, expected_updated_at: current.updatedAt } as never,
				NOW
			)
		).rejects.toMatchObject({ status: 409, code: 'linked' });
		expect((await row(bill))?.amount_minor).toBe(40_000_000);
	});

	it('20 concurrent "Tandai lunas" and 20 concurrent resends of one create hold exactly', async () => {
		const { a, b, id } = await linked();
		const rina = (await getSplit(db, a.spaceId, id))!.participants[1]!;
		const settled = await Promise.all(
			Array.from({ length: 20 }, () => setParticipantPaid(db, b.scope, id, rina.id, true, NOW))
		);
		expect(new Set(settled)).toEqual(new Set(['ok']));
		expect((await getSplit(db, a.spaceId, id))!.participants[1]).toMatchObject({
			paidAmountMinor: 10_000_000
		});
		const clientId = crypto.randomUUID();
		const fields: SplitFields = {
			title: 'Kopi',
			occurredOn: TODAY,
			note: null,
			mode: 'equal',
			totalAmountMinor: 2_000_000,
			participants: [
				{
					kind: 'member',
					memberUserId: a.user.id,
					displayName: 'Ayu',
					shareAmountMinor: 1_000_000
				},
				{ kind: 'guest', memberUserId: null, displayName: 'Rina', shareAmountMinor: 1_000_000 }
			]
		};
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				createSplit(
					db,
					b.scope,
					clientId,
					fields,
					'IDR',
					{
						kind: 'own',
						transactionId: crypto.randomUUID(),
						walletId: b.walletId,
						categoryId: b.makan
					},
					NOW
				)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.every((r) => r.ok || r.reason === 'already')).toBe(true);
		const own = await db.get<{ n: number }>(
			sql`select count(*) as n from transactions where patungan_split_id = ${clientId}`
		);
		expect(own?.n).toBe(1);
	});

	it('a stale edit or delete form gets "changed meanwhile", never an overwrite', async () => {
		const { a, b, id } = await linked();
		const split = (await getSplit(db, a.spaceId, id))!;
		const fields: SplitFields = {
			title: 'X',
			occurredOn: TODAY,
			note: null,
			mode: 'equal',
			totalAmountMinor: 40_000_000,
			participants: [
				{
					kind: 'member',
					memberUserId: a.user.id,
					displayName: 'Ayu',
					shareAmountMinor: 20_000_000
				},
				{ kind: 'guest', memberUserId: null, displayName: 'Rina', shareAmountMinor: 20_000_000 }
			]
		};
		expect(await updateSplit(db, b.scope, id, fields, split.updatedAt, NOW)).toBe('ok');
		expect(await updateSplit(db, b.scope, id, fields, split.updatedAt, NOW)).toBe('stale');
		expect(await deleteSplit(db, b.scope, id, split.updatedAt, NOW)).toBe('stale');
		expect((await getSplit(db, a.spaceId, id))!.participants).toHaveLength(2);
	});

	it('a statement-import duplicate check still matches the linked row (AC-18)', async () => {
		const { a } = await linked();
		const file =
			[
				TEMPLATE_COLUMNS.join(','),
				TEMPLATE_COLUMNS.map((c) =>
					c === 'date'
						? TODAY
						: c === 'type'
							? 'expense'
							: c === 'merchant'
								? 'Makan bareng'
								: c === 'amount'
									? '400000'
									: c === 'wallet_source'
										? 'BCA'
										: ''
				).join(',')
			].join('\n') + '\n';
		const preview = await previewCsv(db, a.spaceId, { fileText: file, format: null });
		expect(preview).toMatchObject({ ok: true, counts: { possibleDuplicates: 1 } });
	});
});

describe('who may do what', () => {
	it('any member sees a split, only the payer changes it; another space and a removed member see nothing', async () => {
		const owner = await person('Ayu');
		const member = await person('Bima');
		const outsider = await person('Citra');
		const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(
			db,
			{ spaceId: shared, userId: owner.user.id, replaces: '' },
			NOW
		))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const b = await books(owner, shared);
		const bill = await b.tx(30_000_000);
		const id = crypto.randomUUID();
		// Bima is picked as a member participant; his name is snapshotted from his account.
		const r = await create(
			owner,
			createForm({ clientId: id, bill, members: [member.user.id] }),
			shared
		);
		expect(r.kind).toBe('redirect');
		const split = (await getSplit(db, shared, id))!;
		expect(split.participants.map((p) => [p.displayName, p.kind, p.shareAmountMinor])).toEqual([
			['Ayu', 'member', 15_000_000],
			['Bima', 'member', 15_000_000]
		]);

		// Bima sees it and what he owes, but every write is refused.
		const list = await run(async () =>
			listPage.load(await event(member, '/patungan', { routeId: '/(app)/patungan', space: shared }))
		);
		expect(
			(list as unknown as { value: { splits: { viewerOwesMinor: number }[] } }).value.splits[0]!
				.viewerOwesMinor
		).toBe(15_000_000);
		const detail = await run(async () =>
			splitPage.load(
				await event(member, `/patungan/${id}`, {
					routeId: '/(app)/patungan/[id]',
					params: { id },
					space: shared
				})
			)
		);
		expect(detail).toMatchObject({ kind: 'ok', value: { isPayer: false } });
		const bimaRow = split.participants[1]!.id;
		expect(
			await splitAction('settle', member, id, [['participant', bimaRow]], shared)
		).toMatchObject({
			kind: 'fail',
			status: 403
		});
		expect(await splitAction('unlink', member, id, [], shared)).toMatchObject({
			kind: 'fail',
			status: 403
		});
		expect(
			await splitAction('delete', member, id, [['updatedAt', String(split.updatedAt)]], shared)
		).toMatchObject({ kind: 'fail', status: 403 });
		expect((await row(bill))?.patungan_split_id).toBe(id);

		// Citra (another user, her own space) gets the same 404 as for an id that does not exist.
		const foreign = await run(async () =>
			splitPage.load(
				await event(outsider, `/patungan/${id}`, {
					routeId: '/(app)/patungan/[id]',
					params: { id }
				})
			)
		);
		const missing = await run(async () =>
			splitPage.load(
				await event(outsider, `/patungan/x`, {
					routeId: '/(app)/patungan/[id]',
					params: { id: crypto.randomUUID() }
				})
			)
		);
		expect(foreign).toEqual({ kind: 'error', status: 404 });
		expect(missing).toEqual(foreign);
		expect(await splitAction('settle', outsider, id, [['participant', bimaRow]])).toMatchObject({
			kind: 'fail',
			status: 404
		});
		expect(await unlinkSplit(db, scopeOf(outsider), id, NOW)).toBe('missing');
		expect(await listSplits(db, scopeOf(outsider))).toEqual([]);

		// Removed from the space, Bima is refused by the space access gate itself.
		const row2 = (await listMembers(db, shared, owner.user.id)).find((m) => m.name === 'Bima')!;
		await removeMember(db, { spaceId: shared, actorUserId: owner.user.id, memberId: row2.id }, NOW);
		const gone = await run(async () =>
			splitPage.load(
				await event(member, `/patungan/${id}`, {
					routeId: '/(app)/patungan/[id]',
					params: { id }
				})
			)
		);
		expect(gone).toMatchObject({ kind: 'error', status: 404 });
		// His share keeps the name it had.
		expect((await getSplit(db, shared, id))!.participants[1]!.displayName).toBe('Bima');
	});

	it('the database keeps a link inside one space and one live transaction per split', async () => {
		const a = await person('Ayu');
		const b = await books(a);
		const other = await person('Citra');
		const ob = await books(other);
		const id = crypto.randomUUID();
		await create(a, createForm({ clientId: id, bill: await b.tx(20_000_000), guests: twoGuests }));
		const theirs = await ob.tx(20_000_000);
		await expect(
			d1
				.prepare(
					'update transactions set patungan_split_id = ?, patungan_effective_amount_minor = 1 where id = ?'
				)
				.bind(id, theirs)
				.run()
		).rejects.toThrow(/another space/);
		const second = await b.tx(20_000_000);
		await expect(
			d1
				.prepare(
					'update transactions set patungan_split_id = ?, patungan_effective_amount_minor = 1 where id = ?'
				)
				.bind(id, second)
				.run()
		).rejects.toThrow(/UNIQUE/);
		// An effective amount above the stored amount, or a link without one, is refused by the CHECK.
		await expect(
			d1
				.prepare(
					'update transactions set patungan_effective_amount_minor = amount_minor + 1 where patungan_split_id = ?'
				)
				.bind(id)
				.run()
		).rejects.toThrow(/CHECK/);
	});

	it('purging a space removes its splits, participants and share links', async () => {
		const a = await person('Ayu');
		const b = await books(a);
		const shared = (await createSharedSpace(db, a.user.id, 'Kos', NOW))!;
		const sb = await books(a, shared);
		await create(
			a,
			createForm({
				clientId: crypto.randomUUID(),
				bill: await sb.tx(20_000_000),
				guests: twoGuests
			}),
			shared
		);
		await create(
			a,
			createForm({ clientId: crypto.randomUUID(), bill: await b.tx(20_000_000), guests: twoGuests })
		);
		await d1
			.prepare(
				`insert into patungan_share_links (id, split_id, space_id, token_hash, expires_at, created_at, updated_at)
				select 'l1', id, space_id, 'h1', 1, 1, 1 from patungan_splits where space_id = ?`
			)
			.bind(shared)
			.run();
		await db.batch(
			purgeSpaces(db, sql`select ${shared}`, () => sql`1`, NOW) as unknown as Parameters<
				typeof db.batch
			>[0]
		);
		for (const table of [
			'patungan_splits',
			'patungan_participants',
			'patungan_share_links',
			'transactions'
		]) {
			const left = await d1
				.prepare(`select count(*) as n from ${table} where space_id = ?`)
				.bind(shared)
				.first<{ n: number }>();
			expect(left?.n, table).toBe(0);
		}
		expect(await listSplits(db, b.scope)).toHaveLength(1);
	});
});

describe('red team L1: a Data demo split is read-only on the server', () => {
	it('unlink then link a real Rp 45.000 expense on the demo split: refused, totals unchanged', async () => {
		const { demoSeedStatements } = await import('../../scripts/demo-seed');
		const a = await person('Ayu');
		const b = await books(a);
		for (const statement of demoSeedStatements(TODAY)) await d1.prepare(statement).run();
		const demoId = `demo-split-1-${a.spaceId}`;
		const demo = (await getSplit(db, a.spaceId, demoId))!;
		expect(demo.isDemo).toBe(true);
		const real = await b.tx(4_500_000, { title: 'Makan siang' });
		const before = await spent(a.spaceId);
		expect(before).toBe(4_500_000);

		expect(await splitAction('unlink', a, demoId)).toMatchObject({ kind: 'fail', status: 404 });
		expect(await unlinkSplit(db, b.scope, demoId, NOW)).toBe('missing');
		// Even with the demo row unlinked by hand, the real expense cannot become its bill.
		await d1
			.prepare(
				'update transactions set patungan_split_id = null, patungan_effective_amount_minor = null where patungan_split_id = ?'
			)
			.bind(demoId)
			.run();
		expect(await splitAction('link', a, demoId, [['transaction', real]])).toMatchObject({
			kind: 'fail',
			status: 404
		});
		expect(await linkSplit(db, b.scope, demoId, real, NOW)).toBe('missing');
		expect(
			await splitAction('ownShare', a, demoId, [
				['walletId', b.walletId],
				['categoryId', b.makan]
			])
		).toMatchObject({ kind: 'fail', status: 404 });
		const rina = demo.participants[1]!;
		expect(await setParticipantPaid(db, b.scope, demoId, rina.id, true, NOW)).toBe('missing');
		const fields: SplitFields = {
			title: 'X',
			occurredOn: TODAY,
			note: null,
			mode: 'equal',
			totalAmountMinor: 4_500_000,
			participants: [
				{
					kind: 'member',
					memberUserId: a.user.id,
					displayName: 'Ayu',
					shareAmountMinor: 2_250_000
				},
				{ kind: 'guest', memberUserId: null, displayName: 'Rina', shareAmountMinor: 2_250_000 }
			]
		};
		expect(await updateSplit(db, b.scope, demoId, fields, demo.updatedAt, NOW)).toBe('missing');
		const update = await run(async () =>
			editPage.actions.update!(
				await event(a, `/patungan/${demoId}/ubah`, {
					routeId: '/(app)/patungan/[id]/ubah',
					params: { id: demoId },
					form: [
						['updatedAt', String(demo.updatedAt)],
						['title', 'X'],
						['occurredOn', TODAY],
						['note', ''],
						['mode', 'equal'],
						['guestName', 'Rina']
					]
				})
			)
		);
		expect(update).toMatchObject({ kind: 'fail', status: 404 });
		expect(await deleteSplit(db, b.scope, demoId, demo.updatedAt, NOW)).toBe('missing');
		expect((await row(real))?.patungan_split_id).toBeNull();
		expect(await spent(a.spaceId)).toBe(before);
		expect((await getSplit(db, a.spaceId, demoId))!.title).toBe('Makan siang (demo)');
	});
});

describe('red team L2 (owner decision): the Pemilik may unlink or delete a split whose payer has gone', () => {
	async function sharedSplit() {
		const owner = await person('Ayu');
		const payer = await person('Bima');
		const member = await person('Citra');
		const shared = (await createSharedSpace(db, owner.user.id, 'Kos', NOW))!;
		const invite = (await createInvite(
			db,
			{ spaceId: shared, userId: owner.user.id, replaces: '' },
			NOW
		))!;
		for (const who of [payer, member]) await acceptInvite(db, invite.token, who.user.id, NOW);
		const b = await books(owner, shared);
		const bill = await b.tx(30_000_000);
		const id = crypto.randomUUID();
		expect(
			(await create(payer, createForm({ clientId: id, bill, guests: twoGuests }), shared)).kind
		).toBe('redirect');
		// Citra's own split stays hers whatever happens to Bima.
		const own = crypto.randomUUID();
		await create(
			member,
			createForm({ clientId: own, bill: await b.tx(20_000_000), guests: twoGuests }),
			shared
		);
		return { owner, payer, member, shared, bill, id, own };
	}
	const updatedAt = async (spaceId: string, id: string) =>
		String((await getSplit(db, spaceId, id))!.updatedAt);

	it('while the payer is still a member, the Pemilik gets 403 like any other member', async () => {
		const s = await sharedSplit();
		expect(await splitAction('unlink', s.owner, s.id, [], s.shared)).toMatchObject({
			kind: 'fail',
			status: 403
		});
		expect(
			await splitAction(
				'delete',
				s.owner,
				s.id,
				[['updatedAt', await updatedAt(s.shared, s.id)]],
				s.shared
			)
		).toMatchObject({ kind: 'fail', status: 403 });
		expect((await row(s.bill))?.patungan_split_id).toBe(s.id);
	});

	it('removed: an Anggota still gets 403; the Pemilik unlinks (bill in full again) and deletes', async () => {
		const s = await sharedSplit();
		const bima = (await listMembers(db, s.shared, s.owner.user.id)).find((m) => m.name === 'Bima')!;
		await removeMember(
			db,
			{ spaceId: s.shared, actorUserId: s.owner.user.id, memberId: bima.id },
			NOW
		);
		expect(await splitAction('unlink', s.member, s.id, [], s.shared)).toMatchObject({
			kind: 'fail',
			status: 403
		});
		const detail = await run(async () =>
			splitPage.load(
				await event(s.owner, `/patungan/${s.id}`, {
					routeId: '/(app)/patungan/[id]',
					params: { id: s.id },
					space: s.shared
				})
			)
		);
		expect(detail).toMatchObject({ kind: 'ok', value: { canRescue: true, isPayer: false } });
		const before = await spent(s.shared);
		expect(await splitAction('unlink', s.owner, s.id, [], s.shared)).toMatchObject({
			kind: 'redirect'
		});
		expect(await row(s.bill)).toMatchObject({ patungan_split_id: null, amount_minor: 30_000_000 });
		expect(await spent(s.shared)).toBe(before - 10_000_000 + 30_000_000);
		// Only unlink and delete: settling and editing stay the payer's.
		const rina = (await getSplit(db, s.shared, s.id))!.participants[1]!;
		expect(
			await splitAction('settle', s.owner, s.id, [['participant', rina.id]], s.shared)
		).toMatchObject({
			kind: 'fail',
			status: 403
		});
		expect(
			await splitAction(
				'delete',
				s.owner,
				s.id,
				[['updatedAt', await updatedAt(s.shared, s.id)]],
				s.shared
			)
		).toMatchObject({ kind: 'redirect', location: '/patungan?saved=deleted' });
		expect(await getSplit(db, s.shared, s.id)).toBeNull();
		expect((await getSplit(db, s.shared, s.own))!.linked).not.toBeNull();
	});

	it('left by themselves: the Pemilik deletes the still-linked split, the bill counts in full', async () => {
		const s = await sharedSplit();
		expect(await leaveSpace(db, { spaceId: s.shared, userId: s.payer.user.id }, NOW)).toBe(true);
		expect(
			await splitAction(
				'delete',
				s.member,
				s.id,
				[['updatedAt', await updatedAt(s.shared, s.id)]],
				s.shared
			)
		).toMatchObject({ kind: 'fail', status: 403 });
		expect(
			await splitAction(
				'delete',
				s.owner,
				s.id,
				[['updatedAt', await updatedAt(s.shared, s.id)]],
				s.shared
			)
		).toMatchObject({ kind: 'redirect' });
		expect(await row(s.bill)).toMatchObject({ patungan_split_id: null, deleted_at: null });
	});

	it('account deleted: the Pemilik unlinks; doing it again is a no-op', async () => {
		const s = await sharedSplit();
		const hash = (await db.get<{ hash: string }>(
			sql`select hash from user_passwords where user_id = ${s.payer.user.id}`
		))!.hash;
		expect(await deleteAccount(db, s.payer.user.id, hash, NOW)).toBe(true);
		expect((await getSplit(db, s.shared, s.id))!.createdByUserId).toBeNull();
		expect(await unlinkSplit(db, scopeOf(s.member, s.shared), s.id, NOW)).toBe('forbidden');
		expect(await unlinkSplit(db, scopeOf(s.owner, s.shared), s.id, NOW)).toBe('ok');
		expect(await unlinkSplit(db, scopeOf(s.owner, s.shared), s.id, NOW)).toBe('ok');
		expect((await row(s.bill))?.patungan_split_id).toBeNull();
	});
});
