import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { listTransactionsByDay, periodTotals } from '#lib/server/transactions/aggregate';
import { walletTransactionsSums } from '#lib/server/transactions/wallet-sum';
import { createWallet } from '#lib/server/wallets/repo';
import { monthRange } from '#lib/shared/dates';
import { openLocalD1 } from '../test/helpers/d1';
import { dueBillReminders } from '#lib/server/subscriptions/reminders';
import { listSubscriptions } from '#lib/server/subscriptions/repo';
import { collectiblesTotal, listCollectibles } from '#lib/server/collectibles/repo';
import { listSplits, owedToViewer } from '#lib/server/patungan/repo';
import { demoSeedStatements } from './demo-seed';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const TODAY = '2026-10-20';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

async function space(withWallet: boolean): Promise<string> {
	return (await member(withWallet)).spaceId;
}

async function member(withWallet: boolean) {
	const r = await signUp(
		db,
		{
			name: 'Demo',
			email: `demo${Math.random()}@contoh.id`,
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		0
	);
	if (!r.ok) throw new Error('setup failed');
	const s = await d1
		.prepare('select space_id as id from space_members where user_id = ?')
		.bind(r.userId)
		.first<{ id: string }>();
	const scope = { spaceId: s!.id, userId: r.userId };
	await ensurePresetCategories(db, scope.spaceId, 0);
	if (withWallet)
		await createWallet(
			db,
			scope,
			{
				name: 'BCA',
				type: 'bank',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: false,
				lastFour: null
			},
			0
		);
	return scope;
}

const seed = async () => {
	for (const statement of demoSeedStatements(TODAY)) await d1.prepare(statement).run();
};
const october = { ...monthRange('2026-10'), type: null, categoryId: null, walletId: null, q: null };

describe('Data demo seed', () => {
	it('adds badged demo rows that never count in a total, idempotently', async () => {
		const spaceId = await space(true);
		const empty = await space(false);
		await seed();
		await seed();
		const rows = await d1
			.prepare('select count(*) as n, sum(is_demo) as demo from transactions where space_id = ?')
			.bind(spaceId)
			.first<{ n: number; demo: number }>();
		expect(rows).toEqual({ n: 6, demo: 6 });
		const page = await listTransactionsByDay(db, spaceId, october);
		const listed = page.days.flatMap((d) => d.rows);
		expect(listed).toHaveLength(6);
		expect(listed.every((r) => r.isDemo)).toBe(true);
		expect(page.days.every((d) => d.totals.length === 0)).toBe(true);
		expect(await periodTotals(db, spaceId, october)).toMatchObject({ count: 0, totals: [] });
		expect((await walletTransactionsSums(db, spaceId)).size).toBe(0);
		// A space without an IDR wallet gets nothing.
		const none = await d1
			.prepare('select count(*) as n from transactions where space_id = ?')
			.bind(empty)
			.first<{ n: number }>();
		expect(none!.n).toBe(0);
	});

	it('adds badged Data demo subscriptions, idempotently, never due for a reminder (FN-26)', async () => {
		const spaceId = await space(true);
		await seed();
		await seed();
		const subs = await listSubscriptions(db, spaceId, TODAY);
		expect(subs).toHaveLength(3);
		expect(subs.every((s) => s.isDemo && s.nextChargeOn >= TODAY)).toBe(true);
		// 2026-10-20 + 2 days' reminder would include day 21/22 bills; none is ever reminded (demo).
		for (const day of ['2026-10-26', '2026-11-03', '2027-02-12'])
			expect(await dueBillReminders(db, spaceId, day)).toEqual([]);
	});

	it('adds badged Data demo collectibles, idempotently, left out of the total (FN-28)', async () => {
		const spaceId = await space(true);
		await seed();
		await seed();
		const items = await listCollectibles(db, spaceId);
		expect(items).toHaveLength(2);
		expect(items.every((c) => c.isDemo && !c.hasPhoto)).toBe(true);
		expect(await collectiblesTotal(db, spaceId)).toEqual([]);
	});

	it('adds one badged Data demo split, linked to a demo row, out of every total (FN-49)', async () => {
		const scope = await member(true);
		await seed();
		await seed();
		const splits = await listSplits(db, scope);
		expect(splits).toHaveLength(1);
		expect(splits[0]).toMatchObject({
			isDemo: true,
			viewerIsPayer: true,
			linked: true,
			settled: false
		});
		// Two guests owe the payer Rp 15.000 each, but a demo split never counts in "Belum dilunasi".
		expect(await owedToViewer(db, scope)).toEqual([]);
		expect(await periodTotals(db, scope.spaceId, october)).toMatchObject({ count: 0, totals: [] });
		const shares = await d1
			.prepare(
				'select sum(share_amount_minor) as total, count(*) as n from patungan_participants where space_id = ?'
			)
			.bind(scope.spaceId)
			.first<{ total: number; n: number }>();
		expect(shares).toEqual({ total: 4_500_000, n: 3 });
	});
});
