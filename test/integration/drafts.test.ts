import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { batchAssert, isBatchAssertFailure } from '#lib/server/db/assert';
import {
	clearDemoDrafts,
	countPendingDrafts,
	discardDraft,
	getDrafts,
	listPendingDrafts,
	MAX_DRAFTS_PER_SPACE,
	saveDrafts,
	seedDemoDrafts,
	setDraftsCategory,
	setDraftsWallet
} from '#lib/server/drafts/repo';
import type { DraftRef } from '#lib/server/drafts/validation';
import type { SpaceScope } from '#lib/server/spaces/access';
import { periodTotals } from '#lib/server/transactions/aggregate';
import { createTransaction, getTransaction } from '#lib/server/transactions/repo';
import { walletTransactionsSums } from '#lib/server/transactions/wallet-sum';
import { createWallet } from '#lib/server/wallets/repo';
import { wibDateString, wibTodayString } from '#lib/shared/dates';
import { eq, sql } from 'drizzle-orm';
import { wallets } from '#lib/server/db/schema';
import { openLocalD1 } from '../helpers/d1';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

let n = 0;
async function account() {
	const email = `draf${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = await d1
		.prepare('select space_id as id from space_members where user_id = ?')
		.bind(r.userId)
		.first<{ id: string }>();
	const scope: SpaceScope = { spaceId: personal!.id, userId: r.userId };
	return { id: r.userId, email, scope };
}

/** A space with presets, an IDR wallet (BCA), a USD wallet, the Kopi and Gaji categories. */
async function inbox() {
	const who = await account();
	await ensurePresetCategories(db, who.scope.spaceId, NOW);
	const cats = await listCategories(db, who.scope.spaceId);
	const wallet = async (name: string, currency: 'IDR' | 'USD') => {
		const r = await createWallet(
			db,
			who.scope,
			{ name, type: 'bank', currency, openingBalanceMinor: 0, isFavourite: false, lastFour: null },
			NOW
		);
		if (!r.ok) throw new Error('wallet failed');
		return r.id;
	};
	const bca = await wallet('BCA', 'IDR');
	const usd = await wallet('Wise', 'USD');
	return {
		...who,
		bca,
		usd,
		kopi: cats.find((c) => c.tileKey === 'kopi')!.id,
		gaji: cats.find((c) => c.tileKey === 'gaji')!.id
	};
}
type Inbox = Awaited<ReturnType<typeof inbox>>;

let seq = 0;
/** A captured draft written straight into D1, as a capture feature (FN-14 onward) will. */
async function draft(
	l: Inbox,
	over: Partial<{
		type: 'expense' | 'income';
		amountMinor: number;
		currency: string;
		walletId: string | null;
		categoryId: string | null;
		source: string;
		dedupeKey: string | null;
		occurredOn: string;
		occurredAt: number;
		title: string;
	}> = {}
) {
	const id = crypto.randomUUID();
	const d = {
		type: 'expense',
		amountMinor: 2_850_050,
		currency: 'IDR',
		walletId: l.bca,
		categoryId: l.kopi,
		source: 'gmail',
		dedupeKey: `msg-${++seq}`,
		occurredOn: '2026-10-08',
		occurredAt: NOW - 3_600_000,
		title: 'Kedai Kopi',
		...over
	};
	await d1
		.prepare(
			`insert into drafts (id, space_id, type, amount_minor, currency, title, wallet_id, category_id,
				occurred_on, occurred_at, source, dedupe_key, created_at, updated_at, seq)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
		)
		.bind(
			id,
			l.scope.spaceId,
			d.type,
			d.amountMinor,
			d.currency,
			d.title,
			d.walletId,
			d.categoryId,
			d.occurredOn,
			d.occurredAt,
			d.source,
			d.dedupeKey,
			NOW,
			NOW
		)
		.run();
	return { id, updatedAt: NOW } satisfies DraftRef;
}

const count = async (sqlText: string, ...args: unknown[]) =>
	(await d1
		.prepare(sqlText)
		.bind(...args)
		.first<{ n: number }>())!.n;
const txCount = (spaceId: string) =>
	count(
		'select count(*) as n from transactions where space_id = ? and deleted_at is null',
		spaceId
	);
const ref = async (l: Inbox, id: string): Promise<DraftRef> => {
	const [row] = await getDrafts(db, l.scope.spaceId, [id]);
	return { id, updatedAt: row!.updatedAt };
};

describe('batchAssert (all-or-nothing batches)', () => {
	it('rolls the whole batch back when the condition fails, and keeps it when it holds', async () => {
		const l = await inbox();
		const before = await count(
			'select count(*) as n from wallets where space_id = ?',
			l.scope.spaceId
		);
		const rename = db.update(wallets).set({ name: 'X' }).where(eq(wallets.id, l.bca));
		await expect(db.batch([rename, batchAssert(db, sql`1 = 0`)])).rejects.toSatisfy(
			isBatchAssertFailure
		);
		expect(
			await count(`select count(*) as n from wallets where name = 'X' and id = ?`, l.bca)
		).toBe(0);
		await db.batch([rename, batchAssert(db, sql`1 = 1`)]);
		expect(
			await count(`select count(*) as n from wallets where name = 'X' and id = ?`, l.bca)
		).toBe(1);
		expect(before).toBe(2);
	});
});

describe('the drafts table', () => {
	it('criterion 17: a discarded draft’s dedupe key still blocks a re-capture from the same source', async () => {
		const l = await inbox();
		const d = await draft(l, { dedupeKey: 'msg-buang', source: 'gmail' });
		expect(await discardDraft(db, l.scope, d, NOW + 1)).toBe('ok');
		await expect(draft(l, { dedupeKey: 'msg-buang', source: 'gmail' })).rejects.toThrow(/UNIQUE/);
		// Another source, or another space, may use the same key.
		await draft(l, { dedupeKey: 'msg-buang', source: 'statement' });
		await draft(await inbox(), { dedupeKey: 'msg-buang', source: 'gmail' });
	});

	it('a discard leaves a content-free tombstone that cannot regain content', async () => {
		const l = await inbox();
		const d = await draft(l, { title: 'Rahasia' });
		await discardDraft(db, l.scope, d, NOW + 1);
		const row = await d1
			.prepare(
				`select amount_minor, currency, title, note, wallet_id, category_id, occurred_on, occurred_at,
					flag, source, dedupe_key, deleted_at from drafts where id = ?`
			)
			.bind(d.id)
			.first();
		expect(row).toEqual({
			amount_minor: null,
			currency: null,
			title: null,
			note: null,
			wallet_id: null,
			category_id: null,
			occurred_on: null,
			occurred_at: null,
			flag: null,
			source: 'gmail',
			dedupe_key: expect.any(String),
			deleted_at: NOW + 1
		});
		await expect(
			d1.prepare('update drafts set amount_minor = 5 where id = ?').bind(d.id).run()
		).rejects.toThrow(/CHECK/);
	});

	it('caps one amount at 10^13 minor units and refuses a transfer or manual draft (schema)', async () => {
		const l = await inbox();
		await draft(l, { amountMinor: 10_000_000_000_000 });
		await expect(draft(l, { amountMinor: 10_000_000_000_001 })).rejects.toThrow(/CHECK/);
		await expect(draft(l, { amountMinor: 0 })).rejects.toThrow(/CHECK/);
		await expect(draft(l, { source: 'manual' })).rejects.toThrow(/CHECK/);
		await expect(draft(l, { type: 'transfer' as unknown as 'expense' })).rejects.toThrow(/CHECK/);
	});
});

describe('discardDraft', () => {
	it('is stale-guarded and answers missing for another space’s draft', async () => {
		const l = await inbox();
		const other = await inbox();
		const d = await draft(l);
		expect(await discardDraft(db, l.scope, { ...d, updatedAt: NOW - 1 }, NOW + 1)).toBe('stale');
		expect(await discardDraft(db, other.scope, d, NOW + 1)).toBe('missing');
		expect(await discardDraft(db, l.scope, d, NOW + 1)).toBe('ok');
		expect(await discardDraft(db, l.scope, d, NOW + 2)).toBe('missing');
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(0);
	});
});

describe('listing', () => {
	it('lists only the space’s pending drafts, newest day first, without dedupe keys', async () => {
		const l = await inbox();
		const other = await inbox();
		const a = await draft(l, { occurredOn: '2026-10-07', occurredAt: NOW - DAY });
		const b = await draft(l, { occurredOn: '2026-10-08' });
		const gone = await draft(l);
		await draft(other);
		await discardDraft(db, l.scope, gone, NOW + 1);
		const rows = await listPendingDrafts(db, l.scope.spaceId);
		expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
		expect(rows[0]).not.toHaveProperty('dedupeKey');
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(2);
		expect(await getDrafts(db, other.scope.spaceId, [a.id, b.id])).toEqual([]);
	});

	it('looks up 120 ids in one statement (no 100-parameter limit)', async () => {
		const l = await inbox();
		const d = await draft(l);
		const ids = [...Array.from({ length: 119 }, () => crypto.randomUUID()), d.id];
		expect((await getDrafts(db, l.scope.spaceId, ids)).map((r) => r.id)).toEqual([d.id]);
	});
});

describe('setDraftsCategory (Atur kategori)', () => {
	it('owner decision A: a mixed expense/income selection is refused whole', async () => {
		const l = await inbox();
		const e = await draft(l, { categoryId: null });
		const i = await draft(l, { type: 'income', categoryId: null });
		expect(await setDraftsCategory(db, l.scope, [e, i], l.kopi, NOW + 1)).toEqual({
			ok: false,
			reason: 'mixed'
		});
		const rows = await getDrafts(db, l.scope.spaceId, [e.id, i.id]);
		expect(rows.every((r) => r.categoryId === null)).toBe(true);
	});

	it('sets one category of the selection’s kind on every draft, in one batch', async () => {
		const l = await inbox();
		const a = await draft(l, { categoryId: null });
		const b = await draft(l, { categoryId: null });
		expect(await setDraftsCategory(db, l.scope, [a, b], l.gaji, NOW + 1)).toEqual({
			ok: false,
			reason: 'kind'
		});
		expect(await setDraftsCategory(db, l.scope, [a, b], l.kopi, NOW + 1)).toEqual({
			ok: true,
			updated: 2
		});
		const rows = await getDrafts(db, l.scope.spaceId, [a.id, b.id]);
		expect(rows.map((r) => r.categoryId)).toEqual([l.kopi, l.kopi]);
		expect(rows.every((r) => r.updatedAt > NOW)).toBe(true);
	});

	it('criterion 11: another space’s category reads as not found; foreign drafts are left out', async () => {
		const l = await inbox();
		const other = await inbox();
		const a = await draft(l, { categoryId: null });
		const foreign = await draft(other, { categoryId: null });
		expect(await setDraftsCategory(db, l.scope, [a], other.kopi, NOW + 1)).toEqual({
			ok: false,
			reason: 'category'
		});
		expect(await setDraftsCategory(db, l.scope, [a, foreign], l.kopi, NOW + 1)).toEqual({
			ok: true,
			updated: 1
		});
		expect((await getDrafts(db, other.scope.spaceId, [foreign.id]))[0]!.categoryId).toBeNull();
		expect(await setDraftsCategory(db, l.scope, [foreign], l.kopi, NOW + 1)).toEqual({
			ok: false,
			reason: 'none'
		});
	});

	it('a stale selection writes nothing at all', async () => {
		const l = await inbox();
		const a = await draft(l, { categoryId: null });
		const b = await draft(l, { categoryId: null });
		expect(
			await setDraftsCategory(db, l.scope, [a, { ...b, updatedAt: NOW - 5 }], l.kopi, NOW + 1)
		).toEqual({ ok: false, reason: 'stale' });
		const rows = await getDrafts(db, l.scope.spaceId, [a.id, b.id]);
		expect(rows.every((r) => r.categoryId === null)).toBe(true);
	});
});

describe('setDraftsWallet (Atur dompet)', () => {
	it('sets the wallet on expense and income alike; other currencies are skipped, never converted', async () => {
		const l = await inbox();
		const e = await draft(l, { walletId: null });
		const i = await draft(l, { type: 'income', walletId: null, categoryId: l.gaji });
		const usd = await draft(l, { walletId: null, currency: 'USD' });
		expect(await setDraftsWallet(db, l.scope, [e, i, usd], l.bca, NOW + 1)).toEqual({
			ok: true,
			updated: 2,
			skipped: 1
		});
		const rows = await getDrafts(db, l.scope.spaceId, [e.id, i.id, usd.id]);
		expect(Object.fromEntries(rows.map((r) => [r.id, r.walletId]))).toEqual({
			[e.id]: l.bca,
			[i.id]: l.bca,
			[usd.id]: null
		});
	});

	it('another space’s or an archived wallet reads as not found', async () => {
		const l = await inbox();
		const other = await inbox();
		const e = await draft(l, { walletId: null });
		expect(await setDraftsWallet(db, l.scope, [e], other.bca, NOW + 1)).toEqual({
			ok: false,
			reason: 'wallet'
		});
		await d1.prepare('update wallets set deleted_at = 1 where id = ?').bind(l.bca).run();
		expect(await setDraftsWallet(db, l.scope, [e], l.bca, NOW + 1)).toEqual({
			ok: false,
			reason: 'wallet'
		});
	});
});

describe('saveDrafts (Simpan N transaksi)', () => {
	it('criterion 12: each complete draft becomes a transaction with its source, dedupe key and instant', async () => {
		const l = await inbox();
		const d = await draft(l, {
			source: 'receipt',
			dedupeKey: 'struk-1',
			occurredOn: '2026-10-07',
			occurredAt: NOW - DAY + 123
		});
		expect(await saveDrafts(db, l.scope, [d], NOW + 1)).toEqual({
			ok: true,
			saved: 1,
			incomplete: 0
		});
		const tomb = await d1
			.prepare(
				'select saved_transaction_id as tx, deleted_at, amount_minor from drafts where id = ?'
			)
			.bind(d.id)
			.first<{ tx: string; deleted_at: number; amount_minor: null }>();
		expect(tomb).toMatchObject({ deleted_at: NOW + 1, amount_minor: null });
		const tx = await d1
			.prepare(
				`select type, amount_minor, currency, wallet_id, category_id, title, occurred_on, occurred_at,
					source, dedupe_key, is_demo from transactions where id = ?`
			)
			.bind(tomb!.tx)
			.first();
		expect(tx).toEqual({
			type: 'expense',
			amount_minor: 2_850_050,
			currency: 'IDR',
			wallet_id: l.bca,
			category_id: l.kopi,
			title: 'Kedai Kopi',
			occurred_on: '2026-10-07',
			occurred_at: NOW - DAY + 123,
			source: 'receipt',
			dedupe_key: 'struk-1',
			is_demo: 0
		});
		expect(await getTransaction(db, l.scope.spaceId, tomb!.tx)).toMatchObject({
			source: 'receipt'
		});
	});

	it('criterion 13 (owner decision B): incomplete drafts stay untouched, the rest save', async () => {
		const l = await inbox();
		const ready = await draft(l);
		const noWallet = await draft(l, { walletId: null });
		const noCategory = await draft(l, { categoryId: null });
		expect(await saveDrafts(db, l.scope, [ready, noWallet, noCategory], NOW + 1)).toEqual({
			ok: true,
			saved: 1,
			incomplete: 2
		});
		expect((await listPendingDrafts(db, l.scope.spaceId)).map((r) => r.id).sort()).toEqual(
			[noWallet.id, noCategory.id].sort()
		);
		expect(await txCount(l.scope.spaceId)).toBe(1);
	});

	it('criterion 16: a saved draft replayed is not found; no second transaction', async () => {
		const l = await inbox();
		const d = await draft(l);
		await saveDrafts(db, l.scope, [d], NOW + 1);
		expect(await saveDrafts(db, l.scope, [d], NOW + 2)).toEqual({ ok: false, reason: 'none' });
		expect(await discardDraft(db, l.scope, d, NOW + 2)).toBe('missing');
		expect(await setDraftsWallet(db, l.scope, [d], l.bca, NOW + 2)).toEqual({
			ok: false,
			reason: 'none'
		});
		expect(await txCount(l.scope.spaceId)).toBe(1);
	});

	it('a stale draft in the selection: 409-class refusal and nothing saved', async () => {
		const l = await inbox();
		const a = await draft(l);
		const b = await draft(l);
		expect(await saveDrafts(db, l.scope, [a, { ...b, updatedAt: NOW - 1 }], NOW + 1)).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(await txCount(l.scope.spaceId)).toBe(0);
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(2);
	});

	it('atomic: one draft whose capture is already recorded fails the batch, nothing is saved', async () => {
		const l = await inbox();
		const a = await draft(l, { dedupeKey: 'msg-a' });
		const b = await draft(l, { dedupeKey: 'msg-dup' });
		const c = await draft(l, { dedupeKey: 'msg-c' });
		const tx = await createTransaction(
			db,
			l.scope,
			{
				type: 'expense',
				amountMinor: 100,
				currency: 'IDR',
				walletId: l.bca,
				transferToWalletId: null,
				categoryId: l.kopi,
				title: null,
				note: null,
				occurredOn: '2026-10-08',
				occurredTime: null
			},
			NOW,
			{ source: 'gmail', dedupeKey: 'msg-dup' }
		);
		expect(tx.ok).toBe(true);
		expect(await saveDrafts(db, l.scope, [a, b, c], NOW + 1)).toEqual({
			ok: false,
			reason: 'duplicate'
		});
		expect(await txCount(l.scope.spaceId)).toBe(1);
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(3);
	});

	it('atomic: one wallet archived between the check and the write fails the whole batch', async () => {
		const l = await inbox();
		const gopay = await createWallet(
			db,
			l.scope,
			{
				name: 'GoPay',
				type: 'e_wallet',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: false,
				lastFour: null
			},
			NOW
		);
		if (!gopay.ok) throw new Error('wallet failed');
		const a = await draft(l);
		const b = await draft(l, { walletId: gopay.id });
		const c = await draft(l);
		// The archive lands after saveDrafts checked the drafts, right before its batch runs.
		const racing = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop !== 'batch') return Reflect.get(target, prop, receiver);
				return async (items: Parameters<Db['batch']>[0]) => {
					await d1.prepare('update wallets set deleted_at = 1 where id = ?').bind(gopay.id).run();
					return target.batch(items);
				};
			}
		});
		expect(await saveDrafts(racing, l.scope, [a, b, c], NOW + 1)).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(await txCount(l.scope.spaceId)).toBe(0);
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(3);
	});

	it('atomic: a removed member saves nothing (the membership is repeated in the write)', async () => {
		const l = await inbox();
		const stranger = await account();
		const a = await draft(l);
		expect(
			await saveDrafts(db, { spaceId: l.scope.spaceId, userId: stranger.id }, [a], NOW + 1)
		).toEqual({ ok: false, reason: 'stale' });
		expect(await txCount(l.scope.spaceId)).toBe(0);
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(1);
	});

	it('a draft whose wallet was archived or category hidden counts as incomplete', async () => {
		const l = await inbox();
		const a = await draft(l);
		await d1.prepare('update categories set is_hidden = 1 where id = ?').bind(l.kopi).run();
		expect(await saveDrafts(db, l.scope, [a], NOW + 1)).toEqual({
			ok: true,
			saved: 0,
			incomplete: 1
		});
		expect(await txCount(l.scope.spaceId)).toBe(0);
	});

	it('criterion 22: 20 concurrent saves over overlapping selections save each draft exactly once', async () => {
		const l = await inbox();
		const refs = await Promise.all(Array.from({ length: 6 }, () => draft(l)));
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				saveDrafts(db, l.scope, [refs[i % 6]!, refs[(i + 1) % 6]!, refs[(i + 2) % 6]!], NOW + 1)
			)
		);
		for (const r of results) expect(r.ok ? 'ok' : r.reason).toMatch(/^(ok|stale|none)$/);
		expect(await txCount(l.scope.spaceId)).toBe(6);
		expect(
			await count(
				`select count(distinct saved_transaction_id) as n from drafts where space_id = ?`,
				l.scope.spaceId
			)
		).toBe(6);
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(0);
	});
});

describe('dev seed (seedDemoDrafts / clearDemoDrafts)', () => {
	it('criterion 5: four demo drafts, both types, ready / needs setup / duplicate, WIB dates', async () => {
		const l = await inbox();
		expect(await seedDemoDrafts(db, l.scope, NOW)).toBe(4);
		const rows = await listPendingDrafts(db, l.scope.spaceId);
		expect(rows).toHaveLength(4);
		expect(rows.every((r) => r.isDemo)).toBe(true);
		expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['expense', 'income']));
		expect(rows.some((r) => r.walletId && r.categoryId)).toBe(true);
		expect(rows.some((r) => !r.walletId && !r.categoryId)).toBe(true);
		expect(rows.some((r) => r.flag === 'duplicate')).toBe(true);
		expect(new Set(rows.map((r) => r.occurredOn))).toEqual(
			new Set([wibTodayString(NOW), wibDateString(NOW - DAY)])
		);
		// Additive, then cleared for a clean re-test.
		expect(await seedDemoDrafts(db, l.scope, NOW)).toBe(4);
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(8);
		await draft(l);
		expect(await clearDemoDrafts(db, l.scope, NOW + 1)).toBe(8);
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(1);
	});

	it('L1: a saved demo draft stays demo data (is_demo = 1), out of every total and balance', async () => {
		const l = await inbox();
		await seedDemoDrafts(db, l.scope, NOW);
		const rows = await listPendingDrafts(db, l.scope.spaceId);
		const r = await saveDrafts(
			db,
			l.scope,
			rows.map((d) => ({ id: d.id, updatedAt: d.updatedAt })),
			NOW + 1
		);
		expect(r).toEqual({ ok: true, saved: 1, incomplete: 3 });
		const tx = await d1
			.prepare('select is_demo, source from transactions where space_id = ? and deleted_at is null')
			.bind(l.scope.spaceId)
			.all<{ is_demo: number; source: string }>();
		expect(tx.results).toEqual([{ is_demo: 1, source: 'gmail' }]);
		const day = wibTodayString(NOW);
		const totals = await periodTotals(db, l.scope.spaceId, {
			from: day,
			to: day,
			type: null,
			categoryId: null,
			walletId: null,
			q: null
		});
		expect(totals.count).toBe(0);
		expect((await walletTransactionsSums(db, l.scope.spaceId)).get(l.bca)).toBeUndefined();
		// A real (non-demo) draft still saves as a real transaction.
		const real = await draft(l);
		await saveDrafts(db, l.scope, [real], NOW + 2);
		expect(
			await count(
				'select count(*) as n from transactions where space_id = ? and is_demo = 0',
				l.scope.spaceId
			)
		).toBe(1);
	});

	it('clearDemoDrafts only tombstones pending demo drafts; saved demo transactions stay (badged, uncounted)', async () => {
		const l = await inbox();
		await seedDemoDrafts(db, l.scope, NOW);
		const rows = await listPendingDrafts(db, l.scope.spaceId);
		await saveDrafts(
			db,
			l.scope,
			rows.map((d) => ({ id: d.id, updatedAt: d.updatedAt })),
			NOW + 1
		);
		expect(await clearDemoDrafts(db, l.scope, NOW + 2)).toBe(3);
		expect(
			await count(
				'select count(*) as n from transactions where space_id = ? and is_demo = 1 and deleted_at is null',
				l.scope.spaceId
			)
		).toBe(1);
	});

	it('L2: at most MAX_DRAFTS_PER_SPACE pending drafts; the seed is refused whole at the cap', async () => {
		const l = await inbox();
		await d1
			.prepare(
				`insert into drafts (id, space_id, type, amount_minor, currency, occurred_on, occurred_at, source,
					created_at, updated_at, seq)
				select lower(hex(randomblob(16))), ?, 'expense', 100, 'IDR', '2026-10-08', 0, 'csv', 0, 0, 1
				from json_each(?)`
			)
			.bind(
				l.scope.spaceId,
				JSON.stringify(Array.from({ length: MAX_DRAFTS_PER_SPACE - 4 }, () => 0))
			)
			.run();
		expect(await seedDemoDrafts(db, l.scope, NOW)).toBe(4);
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(MAX_DRAFTS_PER_SPACE);
		expect(await seedDemoDrafts(db, l.scope, NOW)).toBe(0);
		expect(await countPendingDrafts(db, l.scope.spaceId)).toBe(MAX_DRAFTS_PER_SPACE);
		// Tombstones do not count: after a discard there is room again (for a whole seed only when 4 fit).
		const [one] = await listPendingDrafts(db, l.scope.spaceId);
		await discardDraft(db, l.scope, { id: one!.id, updatedAt: one!.updatedAt }, NOW + 1);
		expect(await seedDemoDrafts(db, l.scope, NOW)).toBe(0);
		expect(MAX_DRAFTS_PER_SPACE).toBe(1000);
	});

	it('a non-member seeds nothing', async () => {
		const l = await inbox();
		const stranger = await account();
		expect(await seedDemoDrafts(db, { spaceId: l.scope.spaceId, userId: stranger.id }, NOW)).toBe(
			0
		);
	});
});

describe('space deletion', () => {
	it('deleting the account removes its drafts, saved ones (pointing at transactions) included', async () => {
		const l = await inbox();
		const a = await draft(l);
		await draft(l, { walletId: null });
		await saveDrafts(db, l.scope, [await ref(l, a.id)], NOW + 1);
		const proof = await signInWithPassword(db, l.email, PASSWORD, NOW + 2);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, l.id, proof.hash, NOW + 2)).toBe(true);
		expect(
			await count('select count(*) as n from drafts where space_id = ?', l.scope.spaceId)
		).toBe(0);
		expect(await txCount(l.scope.spaceId)).toBe(0);
	});
});
