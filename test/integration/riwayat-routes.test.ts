import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import {
	AMOUNT_INVALID,
	AMOUNT_TOO_LARGE,
	CATEGORY_NOT_FOUND,
	TRANSACTION_CHANGED,
	TRANSFER_CURRENCY,
	TRANSFER_SAME_WALLET,
	WALLET_NOT_FOUND
} from '#lib/server/transactions/messages';
import { CURRENCY_LOCKED } from '#lib/server/wallets/messages';
import { wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const riwayat = await import('../../src/routes/(app)/riwayat/+page.server');
const baru = await import('../../src/routes/(app)/riwayat/baru/+page.server');
const edit = await import('../../src/routes/(app)/riwayat/[id]/edit/+page.server');
const kategori = await import('../../src/routes/(app)/pengaturan/kategori/+page.server');
const kekayaan = await import('../../src/routes/(app)/dompet/+page.server');

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
	const email = `riwayat${++n}@contoh.id`;
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
		url: string;
		routeId: string;
		form?: Record<string, string>;
		spaceCookie?: string;
		params?: Record<string, string>;
		headers?: Record<string, string>;
		cookies?: Record<string, string>;
	}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	const made = fakeEvent({
		url: `http://localhost${opts.url}`,
		routeId: opts.routeId,
		db,
		user: who?.user ?? null,
		space,
		form: opts.form,
		params: opts.params,
		headers: opts.headers,
		cookies: opts.cookies
	});
	lastJar = made.jar;
	return made.event as never;
}
/** The cookie jar of the last event built: what a handler left for the next request (one browser). */
let lastJar = new Map<string, string>();
const carried = () => Object.fromEntries(lastJar);

const R = {
	list: '/(app)/riwayat',
	baru: '/(app)/riwayat/baru',
	edit: '/(app)/riwayat/[id]/edit',
	kategori: '/(app)/pengaturan/kategori',
	kekayaan: '/(app)/dompet'
};

const loadList = async (
	who: Person | null,
	query = '',
	space?: string,
	cookies?: Record<string, string>
) =>
	run(async () =>
		riwayat.load(
			await ev(who, { url: `/riwayat${query}`, routeId: R.list, spaceCookie: space, cookies })
		)
	);
const loadEdit = async (who: Person, id: string, space?: string) =>
	run(async () =>
		edit.load(
			await ev(who, {
				url: `/riwayat/${id}/edit`,
				routeId: R.edit,
				params: { id },
				spaceCookie: space
			})
		)
	);
const create = async (who: Person, form: Record<string, string>, space?: string) =>
	run(async () =>
		(baru.actions as Record<string, Handler>).create!(
			await ev(who, { url: '/riwayat/baru', routeId: R.baru, form, spaceCookie: space })
		)
	);
const editAction = async (
	who: Person,
	name: 'update' | 'delete',
	id: string,
	form: Record<string, string>,
	space?: string
) =>
	run(async () =>
		(edit.actions as Record<string, Handler>)[name]!(
			await ev(who, {
				url: `/riwayat/${id}/edit`,
				routeId: R.edit,
				params: { id },
				form,
				spaceCookie: space
			})
		)
	);
const categoryAction = async (
	who: Person,
	name: string,
	form: Record<string, string>,
	space?: string
) =>
	run(async () =>
		(kategori.actions as Record<string, Handler>)[name]!(
			await ev(who, { url: '/pengaturan/kategori', routeId: R.kategori, form, spaceCookie: space })
		)
	);
const walletAction = async (
	who: Person,
	name: string,
	form: Record<string, string>,
	space?: string
) =>
	run(async () =>
		(kekayaan.actions as Record<string, Handler>)[name]!(
			await ev(who, { url: '/dompet', routeId: R.kekayaan, form, spaceCookie: space })
		)
	);

async function spaceOf(who: Person, space?: string) {
	return (await resolveCurrentSpace(db, who.user.id, space))!.id;
}

/** A person with two IDR wallets and a USD wallet in their current space, categories seeded. */
async function setup(who?: Person, space?: string) {
	const p = who ?? (await person());
	for (const [name, currency] of [
		['BCA', 'IDR'],
		['GoPay', 'IDR'],
		['Wise', 'USD']
	] as const)
		await walletAction(
			p,
			'createWallet',
			{ name, type: 'bank', currency, openingBalance: '100.000', lastFour: '' },
			space
		);
	const loaded = await run(async () =>
		baru.load(await ev(p, { url: '/riwayat/baru', routeId: R.baru, spaceCookie: space }))
	);
	if (loaded.kind !== 'ok') throw new Error('load failed');
	const wallets = loaded.value.wallets as { id: string; name: string }[];
	const cats = loaded.value.categories as { id: string; tileKey: string }[];
	const id = (name: string) => wallets.find((w) => w.name === name)!.id;
	return {
		p,
		space: await spaceOf(p, space),
		bca: id('BCA'),
		gopay: id('GoPay'),
		wise: id('Wise'),
		kopi: cats.find((c) => c.tileKey === 'kopi')!.id,
		gaji: cats.find((c) => c.tileKey === 'gaji')!.id
	};
}
type Setup = Awaited<ReturnType<typeof setup>>;

const expense = (s: Setup, over: Record<string, string> = {}) => ({
	type: 'expense',
	amount: '25.000',
	walletId: s.bca,
	categoryId: s.kopi,
	title: 'Kopi susu',
	note: '',
	occurredOn: wibTodayString(),
	occurredTime: '',
	...over
});

async function rowIds(who: Person, space?: string): Promise<string[]> {
	const r = await loadList(who, '', space);
	if (r.kind !== 'ok') throw new Error('list failed');
	const page = r.value.page as { days: { rows: { id: string }[] }[] };
	return page.days.flatMap((d) => d.rows.map((x) => x.id));
}
const txCount = async (spaceId: string) =>
	(await d1
		.prepare('select count(*) as n from transactions where space_id = ?')
		.bind(spaceId)
		.first<{ n: number }>())!.n;

describe('/riwayat', () => {
	it('sends a signed-out visitor to /masuk', async () => {
		expect(await loadList(null)).toMatchObject({
			kind: 'redirect',
			status: 303,
			location: '/masuk'
		});
	});

	it('true-empty and filtered-empty are told apart', async () => {
		const s = await setup();
		let r = await loadList(s.p);
		expect(r).toMatchObject({ kind: 'ok', value: { hasAny: false, loadError: null } });
		await create(s.p, expense(s));
		r = await loadList(s.p, '?q=tidak-ada');
		expect(r).toMatchObject({ kind: 'ok', value: { hasAny: true } });
		expect((r as unknown as { value: { page: { days: unknown[] } } }).value.page.days).toEqual([]);
	});

	it('create → redirect to Riwayat; the row is there on reload, in today’s WIB group', async () => {
		const s = await setup();
		expect(await create(s.p, expense(s))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/riwayat?saved=created'
		});
		const r = await loadList(s.p, '?saved=created', undefined, carried());
		const value = (r as unknown as { value: Record<string, unknown> }).value;
		expect(value.saved).toBe('created');
		// FN-44 L1: the notice is one-shot; a reload of the same URL shows no success.
		const again = await loadList(s.p, '?saved=created', undefined, carried());
		expect((again as unknown as { value: Record<string, unknown> }).value.saved).toBeNull();
		const page = value.page as { days: { date: string; rows: { amountMinor: number }[] }[] };
		expect(page.days[0]!.date).toBe(wibTodayString());
		expect(page.days[0]!.rows[0]!.amountMinor).toBe(2_500_000);
		expect(value.totals).toMatchObject({
			count: 1,
			totals: [{ currency: 'IDR', inMinor: 0, outMinor: 2_500_000 }]
		});
	});

	it('a crafted ?saved= without a confirmed write shows no success (FN-44 L1)', async () => {
		const s = await setup();
		for (const kind of ['created', 'updated', 'deleted', 'adjusted']) {
			const r = await loadList(s.p, `?saved=${kind}`);
			expect((r as unknown as { value: Record<string, unknown> }).value.saved).toBeNull();
		}
		// A refused write leaves no notice either.
		expect(await create(s.p, expense(s, { amount: 'x' }))).toMatchObject({ kind: 'fail' });
		const r = await loadList(s.p, '?saved=created', undefined, carried());
		expect((r as unknown as { value: Record<string, unknown> }).value.saved).toBeNull();
	});

	it('the header and chip counts come from periodTotals for the same filter', async () => {
		const s = await setup();
		await create(s.p, expense(s));
		await create(s.p, expense(s, { type: 'income', categoryId: s.gaji, amount: '1.000.000' }));
		await create(
			s.p,
			expense(s, { type: 'transfer', transferToWalletId: s.gopay, categoryId: '' })
		);
		const r = (await loadList(s.p, '?type=expense')) as unknown as {
			value: Record<string, unknown>;
		};
		expect(r.value.totals).toMatchObject({ count: 1, incomeCount: 0 });
		expect(r.value.chipTotals).toMatchObject({ count: 3, expenseCount: 1, incomeCount: 1 });
	});

	it('the Transfer chip lists transfers only; its header counts them, the chips count every type', async () => {
		const s = await setup();
		await create(s.p, expense(s));
		await create(
			s.p,
			expense(s, { type: 'transfer', transferToWalletId: s.gopay, categoryId: '' })
		);
		const r = (await loadList(s.p, '?type=transfer')) as unknown as {
			value: {
				totals: unknown;
				chipTotals: unknown;
				page: { days: { rows: { type: string }[] }[] };
			};
		};
		expect(r.value.page.days.flatMap((d) => d.rows.map((row) => row.type))).toEqual(['transfer']);
		expect(r.value.totals).toMatchObject({ count: 1, transferCount: 1, totals: [] });
		expect(r.value.chipTotals).toMatchObject({ count: 2, expenseCount: 1, transferCount: 1 });
	});

	it('`?pilih=` opens the Kategori or Dompet picker without JavaScript; anything else opens none', async () => {
		const s = await setup();
		const pick = async (query: string) =>
			((await loadList(s.p, query)) as unknown as { value: { pick: unknown } }).value.pick;
		expect(await pick('?pilih=kategori')).toBe('kategori');
		expect(await pick('?pilih=dompet')).toBe('dompet');
		expect(await pick('?pilih=__proto__')).toBeNull();
		expect(await pick('')).toBeNull();
	});

	it('a long search term (60+ characters) never errors', async () => {
		const s = await setup();
		const r = await loadList(s.p, `?q=${'a'.repeat(70)}`);
		expect(r).toMatchObject({ kind: 'ok', value: { loadError: null } });
	});
});

describe('/riwayat/baru: refusals (each a normal form answer, JavaScript or not)', () => {
	it('echoes values with a field error and writes nothing', async () => {
		const s = await setup();
		const r = await create(s.p, expense(s, { amount: '0' }));
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { amountMinor: AMOUNT_INVALID }, values: { title: 'Kopi susu' } }
		});
		expect(await txCount(s.space)).toBe(0);
	});

	it('refuses a same-wallet or cross-currency transfer', async () => {
		const s = await setup();
		const t = (to: string) => expense(s, { type: 'transfer', transferToWalletId: to });
		expect(await create(s.p, t(s.bca))).toMatchObject({
			status: 400,
			data: { errors: { transferToWalletId: TRANSFER_SAME_WALLET } }
		});
		expect(await create(s.p, t(s.wise))).toMatchObject({
			status: 400,
			data: { errors: { transferToWalletId: TRANSFER_CURRENCY } }
		});
		expect(await txCount(s.space)).toBe(0);
	});

	it('another space’s wallet or category reads as not found, never a 500 or a row', async () => {
		const s = await setup();
		const other = await setup();
		expect(await create(s.p, expense(s, { walletId: other.bca }))).toMatchObject({
			status: 400,
			data: { errors: { walletId: WALLET_NOT_FOUND } }
		});
		expect(await create(s.p, expense(s, { categoryId: other.kopi }))).toMatchObject({
			status: 400,
			data: { errors: { categoryId: CATEGORY_NOT_FOUND } }
		});
		expect(await txCount(s.space)).toBe(0);
		expect(await txCount(other.space)).toBe(0);
	});

	it('a hidden category is not offered and not accepted for a new transaction', async () => {
		const s = await setup();
		await categoryAction(s.p, 'hideCategory', { categoryId: s.kopi });
		expect(await create(s.p, expense(s))).toMatchObject({
			status: 400,
			data: { errors: { categoryId: CATEGORY_NOT_FOUND } }
		});
	});

	it('refuses a non-form or oversized body with 415/400, never 500', async () => {
		const s = await setup();
		const json = await run(async () =>
			(baru.actions as Record<string, Handler>).create!(
				await ev(s.p, {
					url: '/riwayat/baru',
					routeId: R.baru,
					form: expense(s),
					headers: { 'content-type': 'application/json' }
				})
			)
		);
		expect(json).toMatchObject({ kind: 'error', status: 415 });
		const big = await create(s.p, expense(s, { note: 'x'.repeat(20_000) }));
		expect(big).toMatchObject({ kind: 'error', status: 400 });
	});
});

describe('/riwayat/[id]/edit', () => {
	async function withRow() {
		const s = await setup();
		await create(s.p, expense(s));
		const [id] = await rowIds(s.p);
		const loaded = await loadEdit(s.p, id!);
		if (loaded.kind !== 'ok') throw new Error('edit load failed');
		const tx = loaded.value.transaction as { id: string; updatedAt: number };
		return { s, id: id!, updatedAt: String(tx.updatedAt) };
	}

	it('saves an edit, then refuses a second tab’s stale save with FN-04’s phrase', async () => {
		const { s, id, updatedAt } = await withRow();
		const form = expense(s, { amount: '30.000', updatedAt });
		expect(await editAction(s.p, 'update', id, form)).toMatchObject({
			kind: 'redirect',
			location: '/riwayat?saved=updated'
		});
		const shown = await loadList(s.p, '?saved=updated', undefined, carried());
		expect((shown as unknown as { value: Record<string, unknown> }).value.saved).toBe('updated');
		expect(await editAction(s.p, 'update', id, { ...form, amount: '99.000' })).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: TRANSACTION_CHANGED }
		});
		expect(await editAction(s.p, 'update', id, { ...form, updatedAt: 'x' })).toMatchObject({
			status: 409
		});
	});

	it('keeps a now-hidden category selectable for the transaction that uses it', async () => {
		const { s, id, updatedAt } = await withRow();
		await categoryAction(s.p, 'hideCategory', { categoryId: s.kopi });
		const loaded = (await loadEdit(s.p, id)) as unknown as {
			value: { categories: { id: string }[] };
		};
		expect(loaded.value.categories.some((c) => c.id === s.kopi)).toBe(true);
		expect(
			await editAction(s.p, 'update', id, expense(s, { title: 'Baru', updatedAt }))
		).toMatchObject({ kind: 'redirect' });
	});

	it('deletes (stale-guarded); the row leaves the list and the balance', async () => {
		const { s, id, updatedAt } = await withRow();
		expect(await editAction(s.p, 'delete', id, { updatedAt: '1' })).toMatchObject({ status: 409 });
		expect(await editAction(s.p, 'delete', id, { updatedAt })).toMatchObject({
			kind: 'redirect',
			location: '/riwayat?saved=deleted'
		});
		const shown = await loadList(s.p, '?saved=deleted', undefined, carried());
		expect((shown as unknown as { value: Record<string, unknown> }).value.saved).toBe('deleted');
		expect(await rowIds(s.p)).toEqual([]);
		expect(await loadEdit(s.p, id)).toMatchObject({ kind: 'error', status: 404 });
		expect(await editAction(s.p, 'delete', id, { updatedAt })).toMatchObject({ status: 404 });
	});

	it('concurrent edit and delete from two tabs: one wins, the other is refused, no 500', async () => {
		const { s, id, updatedAt } = await withRow();
		const results = await Promise.all([
			editAction(s.p, 'update', id, expense(s, { amount: '1', updatedAt })),
			editAction(s.p, 'delete', id, { updatedAt })
		]);
		expect(results.filter((r) => r.kind === 'redirect')).toHaveLength(1);
		expect(results.filter((r) => r.kind === 'fail')).toHaveLength(1);
	});
});

describe('one access rule across spaces (pre-handoff cross-space probe)', () => {
	async function sharedWithRow() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const s = await setup(owner, spaceId);
		await create(owner, expense(s), spaceId);
		const [id] = await rowIds(owner, spaceId);
		const loaded = (await loadEdit(owner, id!, spaceId)) as unknown as {
			value: { transaction: { updatedAt: number } };
		};
		return {
			owner,
			member,
			spaceId,
			s,
			id: id!,
			updatedAt: String(loaded.value.transaction.updatedAt)
		};
	}

	it('a member works on the shared space’s transactions', async () => {
		const { member, spaceId, id } = await sharedWithRow();
		expect(await rowIds(member, spaceId)).toEqual([id]);
		expect(await loadEdit(member, id, spaceId)).toMatchObject({ kind: 'ok' });
	});

	it('a non-member gets the same 404 as for a missing id, and writes nothing', async () => {
		const { s, id, updatedAt, spaceId } = await sharedWithRow();
		const stranger = await person('Orang lain');
		const missing = await loadEdit(stranger, crypto.randomUUID());
		expect(await loadEdit(stranger, id)).toEqual(missing);
		expect(await loadEdit(stranger, id, spaceId)).toEqual(missing); // cookie for a space not theirs
		expect(missing).toMatchObject({ kind: 'error', status: 404, body: { message: 'Not found' } });
		expect(await editAction(stranger, 'update', id, expense(s, { updatedAt }))).toMatchObject({
			status: 404
		});
		expect(await editAction(stranger, 'delete', id, { updatedAt })).toMatchObject({ status: 404 });
		expect(await rowIds(stranger, spaceId)).toEqual([]);
		// The stranger's categories page never shows or touches the shared space's categories.
		for (const name of ['hideCategory', 'showCategory'])
			expect(await categoryAction(stranger, name, { categoryId: s.kopi })).toMatchObject({
				status: 404
			});
		expect(
			await categoryAction(stranger, 'updateCategory', {
				categoryId: s.kopi,
				name: 'Diretas',
				tileKey: 'kopi',
				updatedAt: '1'
			})
		).toMatchObject({ status: 404 });
		expect((await listCategories(db, spaceId)).find((c) => c.id === s.kopi)?.name).toBe('Kopi');
	});

	it('a removed member loses every route and action at once', async () => {
		const { owner, member, spaceId, s, id, updatedAt } = await sharedWithRow();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		// The cookie still names the shared space; it now falls back to the member's personal space.
		expect(await loadEdit(member, id, spaceId)).toMatchObject({ kind: 'error', status: 404 });
		expect(await rowIds(member, spaceId)).toEqual([]);
		expect(await editAction(member, 'delete', id, { updatedAt }, spaceId)).toMatchObject({
			status: 404
		});
		expect(await create(member, expense(s), spaceId)).toMatchObject({
			status: 400,
			data: { errors: { walletId: WALLET_NOT_FOUND } }
		});
		expect(await txCount(spaceId)).toBe(1);
	});
});

describe('/pengaturan/kategori', () => {
	it('lists the 24 presets on first load, adds, renames (stale-guarded), hides and shows', async () => {
		const p = await person();
		const loaded = await run(async () =>
			kategori.load(await ev(p, { url: '/pengaturan/kategori', routeId: R.kategori }))
		);
		const cats = (
			loaded as unknown as { value: { categories: { id: string; updatedAt: number }[] } }
		).value.categories;
		expect(cats).toHaveLength(24);
		expect(
			await categoryAction(p, 'createCategory', {
				name: 'Kucing',
				tileKey: 'hadiah',
				kind: 'expense'
			})
		).toEqual({ kind: 'ok', value: { saved: 'created' } });
		const first = cats[0]!;
		const rename = {
			categoryId: first.id,
			name: 'Ngopi',
			tileKey: 'makan',
			updatedAt: String(first.updatedAt)
		};
		expect(await categoryAction(p, 'updateCategory', rename)).toMatchObject({ kind: 'ok' });
		expect(await categoryAction(p, 'updateCategory', rename)).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: TRANSACTION_CHANGED }
		});
		expect(
			await categoryAction(p, 'createCategory', { name: '​', tileKey: 'kopi', kind: 'expense' })
		).toMatchObject({
			status: 400,
			data: { action: 'create' }
		});
		expect(await categoryAction(p, 'hideCategory', { categoryId: first.id })).toMatchObject({
			kind: 'ok'
		});
		expect(await categoryAction(p, 'showCategory', { categoryId: first.id })).toMatchObject({
			kind: 'ok'
		});
	});
});

describe('/dompet with transactions (the FN-04 seam)', () => {
	it('shows opening balance + the wallet’s transactions, and locks the currency once it has any', async () => {
		const s = await setup();
		await create(s.p, expense(s)); // −25.000 from BCA
		await create(
			s.p,
			expense(s, {
				type: 'transfer',
				transferToWalletId: s.gopay,
				amount: '10.000',
				categoryId: ''
			})
		);
		const r = await run(async () =>
			kekayaan.load(await ev(s.p, { url: '/dompet', routeId: R.kekayaan }))
		);
		const wallets = (
			r as unknown as {
				value: { wallets: { id: string; balanceMinor: number; updatedAt: number }[] };
			}
		).value.wallets;
		const bca = wallets.find((w) => w.id === s.bca)!;
		expect(bca.balanceMinor).toBe(10_000_000 - 2_500_000 - 1_000_000);
		expect(wallets.find((w) => w.id === s.gopay)!.balanceMinor).toBe(10_000_000 + 1_000_000);
		const change = {
			walletId: s.bca,
			updatedAt: String(bca.updatedAt),
			name: 'BCA',
			type: 'bank',
			currency: 'USD',
			openingBalance: '100.000',
			lastFour: ''
		};
		expect(await walletAction(s.p, 'updateWallet', change)).toMatchObject({
			status: 400,
			data: { errors: { currency: CURRENCY_LOCKED } }
		});
		expect(
			await walletAction(s.p, 'updateWallet', { ...change, currency: 'IDR', name: 'BCA Utama' })
		).toMatchObject({
			kind: 'ok'
		});
	});
});

describe('M1 (red team): one member cannot break Riwayat and Kekayaan for the space', () => {
	it('refuses the repro amount (9.999.999.999.999 in a USD wallet) and writes nothing', async () => {
		const s = await setup();
		const r = await create(s.p, expense(s, { walletId: s.wise, amount: '9.999.999.999.999' }));
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { amountMinor: AMOUNT_TOO_LARGE } }
		});
		expect(await txCount(s.space)).toBe(0);
	});

	it('when totals overflow anyway, the list and the wallets still load (totals shown as too large)', async () => {
		const s = await setup();
		await create(s.p, expense(s, { walletId: s.gopay, title: 'Biasa' }));
		await d1
			.prepare(
				`with recursive n(i) as (select 1 union all select i + 1 from n where i < 1000)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					occurred_on, occurred_at, created_at, updated_at, seq)
				select lower(hex(randomblob(16))), ?, 'expense', 10000000000000, 'IDR', ?, ?, ?, 0, 0, 0, 1 from n`
			)
			.bind(s.space, s.kopi, s.bca, wibTodayString())
			.run();
		const list = (await loadList(s.p)) as unknown as {
			value: {
				loadError: string | null;
				totals: { count: number; totals: { outMinor: number | null }[] };
				page: { days: { rows: unknown[] }[] };
			};
		};
		expect(list.value.loadError).toBeNull();
		expect(list.value.totals.count).toBe(1001);
		expect(list.value.totals.totals[0]!.outMinor).toBeNull();
		expect(list.value.page.days.flatMap((d) => d.rows)).toHaveLength(50);
		const wallets = (await run(async () =>
			kekayaan.load(await ev(s.p, { url: '/dompet', routeId: R.kekayaan }))
		)) as unknown as {
			value: { loadError: string | null; wallets: { id: string; balanceMinor: number | null }[] };
		};
		expect(wallets.value.loadError).toBeNull();
		expect(wallets.value.wallets.find((w) => w.id === s.bca)!.balanceMinor).toBeNull();
		expect(wallets.value.wallets.find((w) => w.id === s.gopay)!.balanceMinor).toBe(7_500_000);
	});
});
