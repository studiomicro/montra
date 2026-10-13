import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import {
	ensurePresetCategories,
	listCategories,
	setCategoryHidden
} from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { countStatements } from '#lib/server/db/statement-count';
import {
	attemptInstances,
	createSeries,
	dueRuns,
	MAX_INSTANCES_PER_RUN,
	getSeries,
	MAX_SERIES_PER_SPACE,
	pauseSeries,
	RECURRING_STATEMENTS_PER_INVOCATION,
	recurringBudget,
	recurringChecker,
	resumeSeries,
	runDueSeries,
	spacesWithDueSeries,
	stopSeries,
	updateSeries
} from '#lib/server/recurring/repo';
import type { RecurringInput } from '#lib/server/recurring/validation';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { listTransactionsForExport, periodTotals } from '#lib/server/transactions/aggregate';
import {
	createTransaction,
	deleteTransaction,
	getTransaction,
	MAX_TRANSACTIONS_PER_SPACE,
	updateTransaction
} from '#lib/server/transactions/repo';
import { importCsv } from '#lib/server/imports/csv-import';
import { archiveWallet, createWallet, getWallet } from '#lib/server/wallets/repo';
import { csvLine, exportCells, TEMPLATE_COLUMNS } from '#lib/shared/csv';
import { wibTodayString } from '#lib/shared/dates';
import type { JobMessage } from '#lib/shared/jobs';
import { recurringDedupeKey } from '#lib/shared/recurring';
import { evaluateBills, evaluateBudget } from '#lib/server/notifications/triggers';
import { handleBatch, type JobDeps, type QueueMessageLike } from '../../workers/jobs/src/queue';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const listPage = await import('../../src/routes/(app)/riwayat/berulang/+page.server');
const newPage = await import('../../src/routes/(app)/riwayat/berulang/baru/+page.server');
const seriesPage = await import('../../src/routes/(app)/riwayat/berulang/[id]/+page.server');
const riwayatPage = await import('../../src/routes/(app)/riwayat/+page.server');
const editPage = await import('../../src/routes/(app)/riwayat/[id]/edit/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = Date.parse('2026-10-08T03:00:00Z');

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function person(name = 'Uji') {
	const email = `berulang${++n}@contoh.id`;
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
const scopeOf = (p: Person, spaceId = p.spaceId) => ({ spaceId, userId: p.user.id });

async function wallet(p: Person, spaceId = p.spaceId) {
	const r = await createWallet(
		db,
		scopeOf(p, spaceId),
		{
			name: 'BCA',
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
async function category(spaceId: string, tileKey = 'tempat-tinggal') {
	await ensurePresetCategories(db, spaceId);
	return (await listCategories(db, spaceId)).find((c) => c.tileKey === tileKey)!.id;
}

/** A person with a wallet and the "Tempat Tinggal" category in `spaceId` (their personal space by default). */
async function setup(p?: Person, spaceId?: string) {
	const who = p ?? (await person());
	const space = spaceId ?? who.spaceId;
	return {
		p: who,
		spaceId: space,
		walletId: await wallet(who, space),
		categoryId: await category(space)
	};
}
type Setup = Awaited<ReturnType<typeof setup>>;

function input(s: Setup, over: Partial<RecurringInput> = {}): RecurringInput {
	return {
		type: 'expense',
		amountMinor: 1_500_000_00,
		currency: 'IDR',
		walletId: s.walletId,
		categoryId: s.categoryId,
		title: 'Sewa kos',
		note: null,
		schedule: { frequency: 'monthly', day: 12 },
		startOn: '2026-10-01',
		endOn: null,
		...over
	};
}
async function series(s: Setup, today: string, over: Partial<RecurringInput> = {}) {
	const r = await createSeries(db, scopeOf(s.p, s.spaceId), input(s, over), today, NOW);
	if (!r.ok) throw new Error(`series failed: ${r.reason}`);
	return r.id;
}
const instances = async (seriesId: string) =>
	(
		await d1
			.prepare(
				`select id, amount_minor, occurred_on, wallet_id, category_id, title, source, dedupe_key,
					deleted_at from transactions where recurring_series_id = ? order by occurred_on, id`
			)
			.bind(seriesId)
			.all<{
				id: string;
				amount_minor: number | null;
				occurred_on: string | null;
				wallet_id: string | null;
				category_id: string | null;
				title: string | null;
				source: string;
				dedupe_key: string;
				deleted_at: number | null;
			}>()
	).results;
const live = async (seriesId: string) =>
	(await instances(seriesId)).filter((r) => r.deleted_at === null);
const row = async (s: Setup, id: string) => (await getSeries(db, s.spaceId, id))!;

/** D1's documented per-invocation query cap on Workers Paid (developers.cloudflare.com/d1/platform/limits/). */
const D1_QUERIES_PER_INVOCATION = 1000;

/**
 * A Drizzle db over `binding` that counts D1 calls (one per query or `batch`) and statements (every statement of
 * a batch counted), and fails like D1 once more than `cap` statements were made (one Worker invocation).
 */
function counting(binding: D1Database, cap = D1_QUERIES_PER_INVOCATION) {
	const stats = { calls: 0, statements: 0 };
	const proxy = new Proxy(binding, {
		get(target, prop) {
			if (prop === 'prepare')
				return (query: string) => {
					if (++stats.statements > cap)
						throw new Error('Too many API requests by single worker invocation');
					stats.calls++;
					return target.prepare(query);
				};
			if (prop === 'batch')
				return (statements: D1PreparedStatement[]) => {
					// Its statements were counted as calls when prepared: one call for the whole batch.
					stats.calls -= statements.length - 1;
					return target.batch(statements);
				};
			const value = Reflect.get(target, prop) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return { db: getDb(proxy), stats };
}

function queueMessage(body: JobMessage) {
	const m: QueueMessageLike & { acked: boolean; retried: boolean } = {
		body,
		attempts: 1,
		acked: false,
		retried: false,
		ack() {
			m.acked = true;
		},
		retry() {
			m.retried = true;
		}
	};
	return m;
}

describe('the cron creates the due instance (AC1)', () => {
	it('day 12: nothing before the 12th; one transaction on the 12th; next run the 12th of next month', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		expect((await row(s, id)).nextRunOn).toBe('2026-10-12');
		expect(await spacesWithDueSeries(db, '2026-10-11', '', 100)).not.toContain(s.spaceId);
		expect((await runDueSeries(db, s.spaceId, '2026-10-11', NOW)).created).toBe(0);
		expect(await spacesWithDueSeries(db, '2026-10-12', '', 100)).toContain(s.spaceId);
		expect((await runDueSeries(db, s.spaceId, '2026-10-12', NOW)).created).toBe(1);
		const rows = await live(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			amount_minor: 1_500_000_00,
			occurred_on: '2026-10-12',
			wallet_id: s.walletId,
			category_id: s.categoryId,
			title: 'Sewa kos',
			source: 'manual',
			dedupe_key: recurringDedupeKey(id, '2026-10-12')
		});
		expect((await row(s, id)).nextRunOn).toBe('2026-11-12');
		// A normal expense row: in the month's totals like a manual one.
		const totals = await periodTotals(db, s.spaceId, {
			from: '2026-10-01',
			to: '2026-10-31',
			type: null,
			categoryId: null,
			walletId: null,
			q: null
		});
		expect(totals).toMatchObject({
			expenseCount: 1,
			totals: [{ currency: 'IDR', outMinor: 1_500_000_00 }]
		});
	});

	it('a series created on its own day is due the same day; a past start is never backfilled', async () => {
		const s = await setup();
		const today = await series(s, '2026-10-12', { startOn: '2026-01-01' });
		expect((await row(s, today)).nextRunOn).toBe('2026-10-12');
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		expect((await live(today)).map((r) => r.occurred_on)).toEqual(['2026-10-12']);
	});
});

describe('idempotency (AC2): redelivery, overlapping ticks, concurrency', () => {
	it('a redelivered message and a second tick create nothing more', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		for (let i = 0; i < 3; i++) await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		expect(await live(id)).toHaveLength(1);
	});

	it('20 concurrent runs of the same space create exactly one instance per date', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08', { schedule: { frequency: 'weekly', day: 1 } });
		// Weekly on Monday: 12, 19 and 26 October are due by the 26th.
		await Promise.all(
			Array.from({ length: 20 }, () => runDueSeries(db, s.spaceId, '2026-10-26', NOW))
		);
		expect((await live(id)).map((r) => r.occurred_on)).toEqual([
			'2026-10-12',
			'2026-10-19',
			'2026-10-26'
		]);
		expect((await row(s, id)).nextRunOn).toBe('2026-11-02');
	});

	it('a stale read (the series already advanced) writes nothing: changed', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		const stale = (await d1
			.prepare(
				`select id, type, amount_minor as amountMinor, currency, wallet_id as walletId,
						category_id as categoryId, title, note, frequency, interval_day as intervalDay,
						end_on as endOn, next_run_on as nextRunOn, attention,
						created_by_user_id as createdByUserId, updated_at as updatedAt
					from recurring_transactions where id = ?`
			)
			.bind(id)
			.first())!;
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		const read = stale as unknown as Parameters<typeof dueRuns>[0];
		expect(
			await attemptInstances(
				db,
				s.spaceId,
				dueRuns(read, '2026-10-12', NOW, 5),
				NOW,
				recurringBudget()
			)
		).toEqual(['changed']);
		expect(await live(id)).toHaveLength(1);
		expect((await row(s, id)).attention).toBeNull();
	});
});

describe('month ends and WIB boundaries (AC3, AC11)', () => {
	it('day 31 clamps to 30 November and 28 February, then back to the 31st', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08', { schedule: { frequency: 'monthly', day: 31 } });
		for (const today of [
			'2026-10-31',
			'2026-11-30',
			'2026-12-31',
			'2027-01-31',
			'2027-02-28',
			'2027-03-31'
		])
			await runDueSeries(db, s.spaceId, today, NOW);
		expect((await live(id)).map((r) => r.occurred_on)).toEqual([
			'2026-10-31',
			'2026-11-30',
			'2026-12-31',
			'2027-01-31',
			'2027-02-28',
			'2027-03-31'
		]);
	});

	it('days 29 and 30 in February of a leap and a common year', async () => {
		const s = await setup();
		const d29 = await series(s, '2028-01-01', {
			startOn: '2028-01-01',
			schedule: { frequency: 'monthly', day: 29 }
		});
		const d30 = await series(s, '2027-01-01', {
			startOn: '2027-01-01',
			schedule: { frequency: 'monthly', day: 30 }
		});
		await runDueSeries(db, s.spaceId, '2027-03-31', NOW);
		expect((await live(d30)).map((r) => r.occurred_on)).toEqual([
			'2027-01-30',
			'2027-02-28',
			'2027-03-30'
		]);
		await runDueSeries(db, s.spaceId, '2028-03-01', NOW);
		expect((await live(d29)).map((r) => r.occurred_on)).toEqual(['2028-01-29', '2028-02-29']);
	});

	it('23:30 WIB on the 31st creates the 31st; 00:30 WIB on the 1st creates the 1st (never the UTC date)', async () => {
		const s = await setup();
		const last = await series(s, '2026-10-30', { schedule: { frequency: 'monthly', day: 31 } });
		const first = await series(s, '2026-10-30', { schedule: { frequency: 'monthly', day: 1 } });
		const evening = Date.parse('2026-10-31T16:30:00Z'); // 23:30 WIB, 31 October
		await runDueSeries(db, s.spaceId, wibTodayString(evening), evening);
		expect((await live(last)).map((r) => r.occurred_on)).toEqual(['2026-10-31']);
		expect(await live(first)).toEqual([]);
		const night = Date.parse('2026-10-31T17:30:00Z'); // 00:30 WIB, 1 November (UTC still 31 October)
		await runDueSeries(db, s.spaceId, wibTodayString(night), night);
		expect((await live(first)).map((r) => r.occurred_on)).toEqual(['2026-11-01']);
		expect(await live(last)).toHaveLength(1);
	});
});

describe('pause, resume, stop (AC4, AC5) and a deleted occurrence', () => {
	it('paused: nothing on the due date; resumed: the next run on or after the resume date, no backfill', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		const scope = scopeOf(s.p);
		expect(await pauseSeries(db, scope, id, (await row(s, id)).updatedAt, NOW)).toBe('ok');
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		await runDueSeries(db, s.spaceId, '2026-11-20', NOW);
		expect(await live(id)).toEqual([]);
		expect(await spacesWithDueSeries(db, '2026-12-31', '', 1000)).not.toContain(s.spaceId);
		const paused = await row(s, id);
		expect(await resumeSeries(db, scope, paused, paused.updatedAt, '2026-11-20', NOW)).toBe('ok');
		expect((await row(s, id)).nextRunOn).toBe('2026-12-12');
		await runDueSeries(db, s.spaceId, '2026-12-12', NOW);
		expect((await live(id)).map((r) => r.occurred_on)).toEqual(['2026-12-12']);
	});

	it('stopped: never visited again, not "aktif berulang", final', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		const scope = scopeOf(s.p);
		expect(await stopSeries(db, scope, id, (await row(s, id)).updatedAt, NOW)).toBe('ok');
		expect(await spacesWithDueSeries(db, '2027-12-31', '', 1000)).not.toContain(s.spaceId);
		await runDueSeries(db, s.spaceId, '2027-12-31', NOW);
		expect(await live(id)).toHaveLength(1);
		const stopped = await row(s, id);
		expect(await resumeSeries(db, scope, stopped, stopped.updatedAt, '2026-11-01', NOW)).toBe(
			'stopped'
		);
		expect(await pauseSeries(db, scope, id, stopped.updatedAt, NOW)).toBe('stopped');
	});

	it('an end date stops the series after its last run', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08', { endOn: '2026-11-30' });
		await runDueSeries(db, s.spaceId, '2027-03-01', NOW);
		expect((await live(id)).map((r) => r.occurred_on)).toEqual(['2026-10-12', '2026-11-12']);
		expect((await row(s, id)).status).toBe('stopped');
	});

	it('a deleted generated transaction is never recreated, even when the series comes back to that date', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		const scope = scopeOf(s.p);
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		const [made] = await live(id);
		const tx = (await getTransaction(db, s.spaceId, made!.id))!;
		expect(await deleteTransaction(db, scope, tx.id, tx.updatedAt, NOW)).toBe('ok');
		// Pause and resume on the same day: the series is due on the 12th again.
		await pauseSeries(db, scope, id, (await row(s, id)).updatedAt, NOW);
		const paused = await row(s, id);
		await resumeSeries(db, scope, paused, paused.updatedAt, '2026-10-12', NOW);
		expect((await row(s, id)).nextRunOn).toBe('2026-10-12');
		const counts = await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		expect(counts).toMatchObject({ created: 0, advanced: 1 });
		expect(await live(id)).toEqual([]);
		expect(await instances(id)).toHaveLength(1);
		expect((await row(s, id)).nextRunOn).toBe('2026-11-12');
	});
});

describe('edit one instance vs edit the series (AC7, AC8)', () => {
	it('"Ubah transaksi ini" changes that row only; "Ubah seri" changes only later instances', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08', { schedule: { frequency: 'weekly', day: 1 } });
		const scope = scopeOf(s.p);
		await runDueSeries(db, s.spaceId, '2026-10-19', NOW);
		const [a, b] = await live(id);
		const before = await row(s, id);
		const tx = (await getTransaction(db, s.spaceId, a!.id))!;
		expect(
			await updateTransaction(
				db,
				scope,
				tx.id,
				{ ...tx, amountMinor: 999_00, transferToWalletId: null, occurredTime: null },
				tx.updatedAt,
				NOW
			)
		).toBe('ok');
		const after = await row(s, id);
		expect(after).toEqual(before);
		expect((await live(id)).map((r) => r.amount_minor)).toEqual([999_00, 1_500_000_00]);
		expect(b!.amount_minor).toBe(1_500_000_00);

		expect(
			await updateSeries(
				db,
				scope,
				after,
				input(s, { amountMinor: 1_750_000_00, schedule: { frequency: 'weekly', day: 1 } }),
				after.updatedAt,
				'2026-10-20',
				NOW
			)
		).toBe('ok');
		// Unchanged schedule: the next run is kept.
		expect((await row(s, id)).nextRunOn).toBe('2026-10-26');
		await runDueSeries(db, s.spaceId, '2026-10-26', NOW);
		expect((await live(id)).map((r) => r.amount_minor)).toEqual([
			999_00, 1_500_000_00, 1_750_000_00
		]);
	});

	it('a stale "Ubah seri" form is refused: changed meanwhile', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		const current = await row(s, id);
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		expect(
			await updateSeries(db, scopeOf(s.p), current, input(s), current.updatedAt, '2026-10-12', NOW)
		).toBe('stale');
	});
});

describe('refused instances are flagged, never lost silently (AC9, AC14)', () => {
	it('an archived wallet: refused like a form, flagged "refs", skipped until the series is edited', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		const scope = scopeOf(s.p);
		const w = (await getWallet(db, s.spaceId, s.walletId))!;
		expect(await archiveWallet(db, scope, w.id, w.updatedAt, NOW)).toBe('ok');
		expect(await runDueSeries(db, s.spaceId, '2026-10-12', NOW)).toMatchObject({
			refs: 1,
			created: 0
		});
		const flagged = await row(s, id);
		expect(flagged).toMatchObject({ attention: 'refs', nextRunOn: '2026-10-12', status: 'active' });
		expect(await live(id)).toEqual([]);
		// Not retried every tick (no hourly churn); the list shows "Perlu perhatian".
		expect(await spacesWithDueSeries(db, '2026-10-12', '', 1000)).not.toContain(s.spaceId);
		const newWallet = await wallet(s.p);
		expect(
			await updateSeries(
				db,
				scope,
				flagged,
				input(s, { walletId: newWallet }),
				flagged.updatedAt,
				'2026-10-20',
				NOW
			)
		).toBe('ok');
		// Fixed: restarts from today, never backfills the 12th.
		expect(await row(s, id)).toMatchObject({ attention: null, nextRunOn: '2026-11-12' });
	});

	it('a hidden category is refused and flagged the same way', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		await setCategoryHidden(db, scopeOf(s.p), s.categoryId, true, NOW);
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		expect(await row(s, id)).toMatchObject({ attention: 'refs' });
		expect(await live(id)).toEqual([]);
	});

	it('at MAX_TRANSACTIONS_PER_SPACE: refused with "limit", left due and retried, created once room is made; O(1) D1 cost', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		// 29 more due series, ids after `id` (attempted after it).
		await d1
			.prepare(
				`with recursive k(i) as (select 1 union all select i + 1 from k where i < 29)
				insert into recurring_transactions (id, space_id, type, amount_minor, currency, category_id,
					wallet_id, title, note, frequency, interval_day, start_on, end_on, next_run_on, status,
					attention, created_by_user_id, created_at, updated_at, deleted_at, seq)
				select 'zz-' || printf('%02d', i), space_id, type, amount_minor, currency, category_id, wallet_id,
					title, note, frequency, interval_day, start_on, end_on, next_run_on, status, attention,
					created_by_user_id, created_at, updated_at, deleted_at, seq
				from recurring_transactions, k where id = ?`
			)
			.bind(id)
			.run();
		await d1
			.prepare(
				`with recursive k(i) as (select 1 union all select i + 1 from k where i < ?)
				insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
					occurred_on, occurred_at, source, is_demo, created_at, updated_at, seq)
				select 'fill-' || i, ?, 'expense', 100, 'IDR', ?, ?, '2026-09-01', 0, 'manual', 0, 0, 0, 1 from k`
			)
			.bind(MAX_TRANSACTIONS_PER_SPACE, s.spaceId, s.categoryId, s.walletId)
			.run();
		// At the cap: one select, then one batch flagging all 30 (never one query per series).
		const first = counting(d1);
		expect(await runDueSeries(first.db, s.spaceId, '2026-10-12', NOW)).toMatchObject({
			limit: 30,
			created: 0
		});
		expect(first.stats).toEqual({ calls: 2, statements: 3 });
		expect(await row(s, id)).toMatchObject({ attention: 'limit', nextRunOn: '2026-10-12' });
		expect((await row(s, id)).attention).toBe('limit');
		expect(
			await d1
				.prepare(
					`select count(*) as n from recurring_transactions where space_id = ? and attention = 'limit'`
				)
				.bind(s.spaceId)
				.first()
		).toEqual({ n: 30 });
		// Every later tick while still at the cap: one select, nothing written.
		const again = counting(d1);
		expect(await runDueSeries(again.db, s.spaceId, '2026-10-12', NOW)).toMatchObject({ limit: 30 });
		expect(again.stats).toEqual({ calls: 1, statements: 1 });
		// Still due: the next tick tries again.
		expect(await spacesWithDueSeries(db, '2026-10-12', '', 1000)).toContain(s.spaceId);
		await d1.prepare(`delete from transactions where id = 'fill-1'`).run();
		expect(await runDueSeries(db, s.spaceId, '2026-10-13', NOW)).toMatchObject({ created: 1 });
		expect(await row(s, id)).toMatchObject({ attention: null, nextRunOn: '2026-11-12' });
		// The others stay flagged "limit" and due, without one write each.
		expect(
			await d1
				.prepare(
					`select count(*) as n from recurring_transactions where space_id = ? and attention = 'limit'`
				)
				.bind(s.spaceId)
				.first()
		).toEqual({ n: 29 });
		await d1
			.prepare(`delete from transactions where space_id = ? and id like 'fill-%'`)
			.bind(s.spaceId)
			.run();
	});

	it(`a space holds at most ${MAX_SERIES_PER_SPACE} live series`, async () => {
		const s = await setup();
		const made = await Promise.all(
			Array.from({ length: MAX_SERIES_PER_SPACE + 5 }, () =>
				createSeries(db, scopeOf(s.p), input(s), '2026-10-08', NOW)
			)
		);
		expect(made.filter((r) => r.ok)).toHaveLength(MAX_SERIES_PER_SPACE);
		expect(made.filter((r) => !r.ok && r.reason === 'limit')).toHaveLength(5);
	});
});

// ---- Routes: one access rule (AC10), the Riwayat chip (AC6) ----

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
async function ev(
	who: Person,
	opts: {
		path: string;
		routeId: string;
		form?: Record<string, string>;
		space?: string;
		params?: Record<string, string>;
		cookies?: Record<string, string>;
	}
) {
	let space = await resolveCurrentSpace(db, who.user.id, opts.space);
	if (opts.space && space?.id !== opts.space)
		space = { id: opts.space, kind: 'shared', name: 'x', role: 'member' };
	const made = fakeEvent({
		url: `http://localhost${opts.path}`,
		routeId: opts.routeId,
		db,
		user: who.user,
		space,
		form: opts.form,
		params: opts.params,
		cookies: opts.cookies
	});
	lastJar = made.jar;
	return made.event as never;
}
/** The cookie jar of the last event built: what a handler left for the next request (one browser). */
let lastJar = new Map<string, string>();
const seriesEv = (who: Person, id: string, form?: Record<string, string>, space?: string) =>
	ev(who, {
		path: `/riwayat/berulang/${id}`,
		routeId: '/(app)/riwayat/berulang/[id]',
		params: { id },
		form,
		space
	});
const seriesAct = (
	who: Person,
	name: string,
	id: string,
	form: Record<string, string>,
	space?: string
) =>
	run(async () =>
		(seriesPage.actions as Record<string, Action>)[name]!(await seriesEv(who, id, form, space))
	);

const today = () => wibTodayString();
const formFor = (s: Setup, over: Record<string, string> = {}) => ({
	type: 'expense',
	amount: '1.500.000',
	walletId: s.walletId,
	categoryId: s.categoryId,
	title: 'Sewa kos',
	note: '',
	frequency: 'monthly',
	day: '12',
	weekday: '1',
	startOn: today(),
	endOn: '',
	...over
});

describe('bounded D1 work per jobs invocation (red team M1, L1)', () => {
	/** `count` people, each with `perSpace` series due on the 12th in their personal space. */
	async function heavySpaces(count: number, perSpace: number) {
		const spaces: { s: Setup; first: string }[] = [];
		for (let i = 0; i < count; i++) {
			const s = await setup();
			const first = await series(s, '2026-10-08');
			await d1
				.prepare(
					`with recursive k(i) as (select 1 union all select i + 1 from k where i < ?)
					insert into recurring_transactions (id, space_id, type, amount_minor, currency, category_id,
						wallet_id, title, note, frequency, interval_day, start_on, end_on, next_run_on, status,
						attention, created_by_user_id, created_at, updated_at, deleted_at, seq)
					select ? || '-' || printf('%03d', i), space_id, type, amount_minor, currency, category_id,
						wallet_id, title, note, frequency, interval_day, start_on, end_on, next_run_on, status,
						attention, created_by_user_id, created_at, updated_at, deleted_at, seq
					from recurring_transactions, k where id = ?`
				)
				.bind(perSpace - 1, first, first)
				.run();
			spaces.push({ s, first });
		}
		return spaces;
	}
	const generated = async (spaceId: string) =>
		(await d1
			.prepare(
				`select count(*) as n, count(distinct dedupe_key) as k from transactions
					where space_id = ? and recurring_series_id is not null and occurred_on = '2026-10-12'`
			)
			.bind(spaceId)
			.first<{ n: number; k: number }>())!;

	it('10 heavy recurring_check messages and other jobs in one batch: the other jobs succeed, D1 stays under the cap, the rest continues', async () => {
		const heavy = await heavySpaces(10, MAX_SERIES_PER_SPACE);
		const other = await setup();
		const invocation = (messages: JobMessage[]) => {
			const c = counting(d1);
			const budget = recurringBudget();
			const enqueued: JobMessage[] = [];
			const used = { recurring: 0 };
			const deps: JobDeps = {
				recordPing: async () => {},
				gmailCheck: async () => {},
				gmailRead: async () => {},
				agentRun: async () => {},
				budgetCheck: (spaceId) => evaluateBudget(c.db, spaceId, NOW),
				billCheck: (spaceId) => evaluateBills(c.db, spaceId, NOW),
				dailyNudge: async () => [],
				closeReminder: async () => [],
				budgetStreakSnapshot: async () => {},
				weeklySummary: async () => [],
				sendPush: async () => {
					await c.db.all(sql`select 1`);
				},
				recurringCheck: async (spaceId, date) => {
					const before = c.stats.statements;
					const run = await runDueSeries(c.db, spaceId, date, NOW, budget);
					used.recurring += c.stats.statements - before;
					return run.more;
				},
				fileSweep: async () => false,
				inboundRead: async () => {},
				enqueue: async (m) => {
					enqueued.push(...m);
				},
				today: () => '2026-10-12'
			};
			const ms = messages.map(queueMessage);
			return { c, used, enqueued, ms, run: () => handleBatch({ messages: ms }, deps) };
		};
		const recurring = heavy.map(({ s }): JobMessage => ({
			type: 'recurring_check',
			spaceId: s.spaceId,
			date: '2026-10-12'
		}));
		const others: JobMessage[] = [
			{ type: 'budget_check', spaceId: other.spaceId },
			{ type: 'bill_check', spaceId: other.spaceId },
			{ type: 'send_push', notificationId: 'n-1' }
		];
		// Recurring messages first in the batch: the worst order for the others.
		const one = invocation([...recurring, ...others]);
		await one.run();
		expect(one.ms.every((m) => m.acked && !m.retried)).toBe(true);
		expect(one.c.stats.statements).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
		expect(one.used.recurring).toBeLessThanOrEqual(RECURRING_STATEMENTS_PER_INVOCATION);
		// One message's worth of instances in a handful of calls (it was ~200 D1 calls per message).
		expect(one.c.stats.calls).toBeLessThan(30);
		expect((await generated(heavy[0]!.s.spaceId)).n).toBe(MAX_SERIES_PER_SPACE);
		// What did not fit continues in fresh messages (same date), acked here, never toward the DLQ.
		expect(one.enqueued.length).toBeGreaterThan(0);
		expect(one.enqueued.every((m) => m.type === 'recurring_check' && m.date === '2026-10-12')).toBe(
			true
		);
		// Later invocations work the rest off, each under the budget; every instance exactly once.
		let queue = one.enqueued;
		let rounds = 0;
		while (queue.length > 0) {
			expect(++rounds).toBeLessThan(20);
			const next = invocation(queue.slice(0, 10));
			await next.run();
			expect(next.ms.every((m) => m.acked && !m.retried)).toBe(true);
			expect(next.used.recurring).toBeLessThanOrEqual(RECURRING_STATEMENTS_PER_INVOCATION);
			queue = [...queue.slice(10), ...next.enqueued];
		}
		for (const { s } of heavy)
			expect(await generated(s.spaceId)).toEqual({
				n: MAX_SERIES_PER_SPACE,
				k: MAX_SERIES_PER_SPACE
			});
	});

	it('FN-36 L3: other jobs used 750 statements; the recurring budget takes the rest, the invocation stays ≤ 1,000', async () => {
		const heavy = await heavySpaces(10, MAX_SERIES_PER_SPACE);
		const counted = countStatements(d1);
		const cdb = getDb(counted.d1);
		const check = recurringChecker(cdb, counted.statements);
		const deps: JobDeps = {
			recordPing: async () => {},
			gmailCheck: async () => {},
			gmailRead: async () => {},
			agentRun: async () => {},
			budgetCheck: async () => {
				// The batch's other jobs: 750 statements before any recurring check runs.
				for (let i = 0; i < 750; i++) await cdb.all(sql`select 1`);
				return [];
			},
			billCheck: async () => [],
			dailyNudge: async () => [],
			closeReminder: async () => [],
			budgetStreakSnapshot: async () => {},
			weeklySummary: async () => [],
			sendPush: async () => {},
			recurringCheck: async (spaceId, date) => (await check(spaceId, date, NOW)).more,
			fileSweep: async () => false,
			inboundRead: async () => {},
			enqueue: async () => {},
			today: () => '2026-10-12'
		};
		const ms = [
			...heavy.map(({ s }) =>
				queueMessage({ type: 'recurring_check', spaceId: s.spaceId, date: '2026-10-12' })
			),
			queueMessage({ type: 'budget_check', spaceId: heavy[0]!.s.spaceId })
		];
		await handleBatch({ messages: ms }, deps);
		expect(ms.every((m) => m.acked && !m.retried)).toBe(true);
		expect(counted.statements()).toBeGreaterThan(750);
		expect(counted.statements()).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
	});

	it('one space with a long backlog: MAX_INSTANCES_PER_RUN per message in a few batches, then continued', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08', { schedule: { frequency: 'weekly', day: 1 } });
		const c = counting(d1);
		// Weekly since 12 October 2026: more than 100 Mondays are due by 2029.
		const run = await runDueSeries(c.db, s.spaceId, '2029-01-01', NOW, recurringBudget());
		expect(run).toMatchObject({ created: MAX_INSTANCES_PER_RUN, more: true });
		expect(c.stats.calls).toBeLessThanOrEqual(1 + Math.ceil(MAX_INSTANCES_PER_RUN / 20));
		expect(c.stats.statements).toBeLessThanOrEqual(RECURRING_STATEMENTS_PER_INVOCATION);
		const rest = await runDueSeries(db, s.spaceId, '2029-01-01', NOW);
		expect(rest.more).toBe(false);
		const dates = (await live(id)).map((r) => r.occurred_on);
		expect(dates).toHaveLength(MAX_INSTANCES_PER_RUN + rest.created);
		expect(new Set(dates).size).toBe(dates.length);
		expect(dates.at(-1)! <= '2029-01-01').toBe(true);
		expect((await row(s, id)).nextRunOn > '2029-01-01').toBe(true);
	});

	it('a spent budget makes no D1 call and leaves the work for a fresh message', async () => {
		const s = await setup();
		await series(s, '2026-10-08');
		const c = counting(d1);
		expect(await runDueSeries(c.db, s.spaceId, '2026-10-12', NOW, { left: 5 })).toMatchObject({
			created: 0,
			more: true
		});
		expect(c.stats).toEqual({ calls: 0, statements: 0 });
	});

	it('series flagged "refs" or "member" cost one select for the whole space, however many', async () => {
		const { s } = (await heavySpaces(1, MAX_SERIES_PER_SPACE))[0]!;
		await d1
			.prepare(`update recurring_transactions set attention = 'refs' where space_id = ?`)
			.bind(s.spaceId)
			.run();
		const c = counting(d1);
		expect(await runDueSeries(c.db, s.spaceId, '2026-10-12', NOW)).toMatchObject({
			created: 0,
			refs: 0,
			more: false
		});
		expect(c.stats).toEqual({ calls: 1, statements: 1 });
	});

	it('refused attempts are explained and flagged in two calls per batch, not two per series', async () => {
		const { s } = (await heavySpaces(1, 20))[0]!;
		const w = (await getWallet(db, s.spaceId, s.walletId))!;
		expect(await archiveWallet(db, scopeOf(s.p), w.id, w.updatedAt, NOW)).toBe('ok');
		const c = counting(d1);
		expect(await runDueSeries(c.db, s.spaceId, '2026-10-12', NOW)).toMatchObject({ refs: 20 });
		// The page read, the attempt batch, the explaining select and the flag batch.
		expect(c.stats.calls).toBe(4);
	});

	it('L1: a run for an earlier date never creates a later date’s instance', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08', { schedule: { frequency: 'monthly', day: 13 } });
		// The 23:00 WIB tick of the 12th, processed after midnight: still the 12th.
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		expect(await live(id)).toEqual([]);
		await runDueSeries(db, s.spaceId, '2026-10-13', NOW);
		expect((await live(id)).map((r) => r.occurred_on)).toEqual(['2026-10-13']);
	});
});

describe('L2: a hard-deleted series leaves its transactions as plain rows (ON DELETE SET NULL)', () => {
	it('deleting the series row clears the link, keeps the transaction', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		const [made] = await live(id);
		await d1.prepare('delete from recurring_transactions where id = ?').bind(id).run();
		expect(
			await d1
				.prepare(
					'select recurring_series_id as seriesId, deleted_at as deletedAt from transactions where id = ?'
				)
				.bind(made!.id)
				.first()
		).toEqual({ seriesId: null, deletedAt: null });
	});
});

describe('the series pages', () => {
	it('creates through the form, lists it and validates the schedule', async () => {
		const s = await setup();
		const create = (form: Record<string, string>) =>
			run(async () =>
				(newPage.actions as Record<string, Action>).create!(
					await ev(s.p, {
						path: '/riwayat/berulang/baru',
						routeId: '/(app)/riwayat/berulang/baru',
						form
					})
				)
			);
		expect(await create(formFor(s))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/riwayat/berulang?saved=created'
		});
		const bad = await create(formFor(s, { day: '32', amount: '1,5' }));
		expect(bad).toMatchObject({ kind: 'fail', status: 400 });
		const weekdayBad = await create(formFor(s, { frequency: 'weekly', weekday: '8' }));
		expect(weekdayBad).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { day: 'Pilih hari dalam seminggu.' } }
		});
		const transfer = await create(formFor(s, { type: 'transfer' }));
		expect(transfer).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { type: 'Pilih pengeluaran atau pemasukan.' } }
		});
		const listed = await run(async () =>
			listPage.load(
				await ev(s.p, { path: '/riwayat/berulang', routeId: '/(app)/riwayat/berulang' })
			)
		);
		expect(listed).toMatchObject({ kind: 'ok' });
		const list = (
			listed as unknown as { value: { series: { amountMinor: number; schedule: unknown }[] } }
		).value.series;
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			amountMinor: 1_500_000_00,
			schedule: { frequency: 'monthly', day: 12 }
		});
	});

	it('another space’s wallet in the form reads as not found', async () => {
		const s = await setup();
		const other = await setup();
		const r = await run(async () =>
			(newPage.actions as Record<string, Action>).create!(
				await ev(s.p, {
					path: '/riwayat/berulang/baru',
					routeId: '/(app)/riwayat/berulang/baru',
					form: formFor(s, { walletId: other.walletId })
				})
			)
		);
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { walletId: 'Dompet tidak ditemukan.' } }
		});
	});

	it('a non-member and a removed member get 404 on the series page and every action; nothing changes; the cron then flags "member"', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const stranger = await person('Orang lain');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const s = await setup(member, spaceId);
		const id = await series(s, '2026-10-08');
		// The member sees and edits it in the shared space.
		expect(
			await run(async () => seriesPage.load(await seriesEv(member, id, undefined, spaceId)))
		).toMatchObject({
			kind: 'ok'
		});
		const rowMember = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(
			db,
			{ spaceId, actorUserId: owner.user.id, memberId: rowMember.id },
			Date.now()
		);
		const snapshot = async () =>
			JSON.stringify(
				(await d1.prepare('select * from recurring_transactions where id = ?').bind(id).all())
					.results
			);
		const before = await snapshot();
		const updatedAt = String((await row(s, id)).updatedAt);
		for (const who of [stranger, member]) {
			expect(
				await run(async () => seriesPage.load(await seriesEv(who, id, undefined, spaceId)))
			).toMatchObject({
				kind: 'error',
				status: 404,
				body: { message: 'Not found' }
			});
			// Their own space, the other space's series id: the same 404 answer.
			expect(await run(async () => seriesPage.load(await seriesEv(who, id)))).toMatchObject({
				kind: 'error',
				status: 404,
				body: { message: 'Not found' }
			});
			for (const action of ['update', 'pause', 'resume', 'stop', 'delete']) {
				const forged = await seriesAct(who, action, id, { ...formFor(s), updatedAt }, spaceId);
				expect(forged, `${action} forged`).toMatchObject({
					kind: 'error',
					status: 404,
					body: { message: 'Not found' }
				});
				const own = await seriesAct(who, action, id, { ...formFor(s), updatedAt });
				expect(own.kind, `${action} own`).toBe('fail');
				// Looked up inside their own space only: the one "not found" answer, no oracle.
				expect(own, `${action} own`).toMatchObject({
					status: 404,
					data: { error: 'Transaksi berulang tidak ditemukan.' }
				});
			}
		}
		expect(await snapshot()).toBe(before);
		// The cron writes for the member who set it up: removed, so refused and flagged; the owner takes it over.
		await runDueSeries(db, spaceId, '2026-10-12', NOW);
		expect(await live(id)).toEqual([]);
		const flagged = await row(s, id);
		expect(flagged.attention).toBe('member');
		expect(
			await updateSeries(
				db,
				scopeOf(owner, spaceId),
				flagged,
				input(s),
				flagged.updatedAt,
				'2026-10-12',
				NOW
			)
		).toBe('ok');
		await runDueSeries(db, spaceId, '2026-10-12', NOW);
		expect((await live(id)).map((r) => r.occurred_on)).toEqual(['2026-10-12']);
	});

	it('the list shows its success text only with the one-shot notice the write set (FN-44 L1 class)', async () => {
		const s = await setup();
		const list = async (query: string, cookies?: Record<string, string>) =>
			(await run(async () =>
				listPage.load(
					await ev(s.p, {
						path: `/riwayat/berulang${query}`,
						routeId: '/(app)/riwayat/berulang',
						cookies
					})
				)
			)) as unknown as { value: { saved: string | null } };
		// A crafted URL alone shows nothing, for every kind.
		for (const kind of ['created', 'updated', 'paused', 'resumed', 'stopped', 'deleted'])
			expect((await list(`?saved=${kind}`)).value.saved).toBeNull();
		// A confirmed write leaves the notice; the next load shows it once, a reload shows nothing.
		await run(async () =>
			(newPage.actions as Record<string, Action>).create!(
				await ev(s.p, {
					path: '/riwayat/berulang/baru',
					routeId: '/(app)/riwayat/berulang/baru',
					form: formFor(s)
				})
			)
		);
		const carried = Object.fromEntries(lastJar);
		expect(carried).toEqual({ series_saved: 'created' });
		expect((await list('?saved=created', carried)).value.saved).toBe('created');
		expect((await list('?saved=created', Object.fromEntries(lastJar))).value.saved).toBeNull();
		// A notice for another kind than the URL names shows nothing and is spent.
		expect((await list('?saved=deleted', carried)).value.saved).toBeNull();
		expect(lastJar.has('series_saved')).toBe(false);
	});

	it('every series action sets its notice with the redirect', async () => {
		const s = await setup();
		const id = await series(s, today());
		const at = async () => String((await row(s, id)).updatedAt);
		expect(
			await seriesAct(s.p, 'update', id, { ...formFor(s), updatedAt: await at() })
		).toMatchObject({ kind: 'redirect', location: '/riwayat/berulang?saved=updated' });
		expect(Object.fromEntries(lastJar)).toEqual({ series_saved: 'updated' });
		for (const [action, kind] of [
			['pause', 'paused'],
			['resume', 'resumed'],
			['stop', 'stopped'],
			['delete', 'deleted']
		] as const) {
			expect(await seriesAct(s.p, action, id, { updatedAt: await at() })).toMatchObject({
				kind: 'redirect',
				location: `/riwayat/berulang?saved=${kind}`
			});
			expect(Object.fromEntries(lastJar)).toEqual({ series_saved: kind });
		}
	});

	it('pause, resume, stop and delete through the page; a stale form is "changed meanwhile"', async () => {
		const s = await setup();
		const id = await series(s, today());
		const at = async () => String((await row(s, id)).updatedAt);
		expect(await seriesAct(s.p, 'pause', id, { updatedAt: await at() })).toMatchObject({
			kind: 'redirect',
			location: '/riwayat/berulang?saved=paused'
		});
		expect(await seriesAct(s.p, 'pause', id, { updatedAt: '1' })).toMatchObject({
			kind: 'fail',
			status: 409
		});
		// A refused write leaves no notice behind.
		expect(Object.fromEntries(lastJar)).toEqual({});
		expect(await seriesAct(s.p, 'resume', id, { updatedAt: await at() })).toMatchObject({
			location: '/riwayat/berulang?saved=resumed'
		});
		expect(await seriesAct(s.p, 'stop', id, { updatedAt: await at() })).toMatchObject({
			location: '/riwayat/berulang?saved=stopped'
		});
		expect(
			await seriesAct(s.p, 'update', id, { ...formFor(s), updatedAt: await at() })
		).toMatchObject({
			kind: 'fail',
			status: 409,
			data: { error: 'Seri ini sudah dihentikan.' }
		});
		expect(await seriesAct(s.p, 'delete', id, { updatedAt: await at() })).toMatchObject({
			location: '/riwayat/berulang?saved=deleted'
		});
		expect(await getSeries(db, s.spaceId, id)).toBeNull();
		const tomb = await d1
			.prepare('select * from recurring_transactions where id = ?')
			.bind(id)
			.first<Record<string, unknown>>();
		expect(tomb).toMatchObject({
			amount_minor: null,
			title: null,
			next_run_on: null,
			wallet_id: null
		});
		expect(tomb!.deleted_at).not.toBeNull();
	});
});

describe('Transaksi "Aktif berulang" (AC6) and the edit page', () => {
	it('lists only rows of active series; the header total equals the sum of exactly those rows', async () => {
		const s = await setup();
		const month = today().slice(0, 7);
		const active = await series(s, `${month}-01`, {
			startOn: `${month}-01`,
			schedule: { frequency: 'monthly', day: 1 },
			amountMinor: 100_000_00
		});
		const stopped = await series(s, `${month}-01`, {
			startOn: `${month}-01`,
			schedule: { frequency: 'monthly', day: 1 },
			amountMinor: 7_000_00
		});
		await runDueSeries(db, s.spaceId, `${month}-01`, NOW);
		const st = await row(s, stopped);
		await stopSeries(db, scopeOf(s.p), stopped, st.updatedAt, NOW);
		// A manual row of the same day and category: not recurring.
		const manual = await createTransaction(
			db,
			scopeOf(s.p),
			{
				type: 'expense',
				amountMinor: 25_000_00,
				currency: 'IDR',
				walletId: s.walletId,
				transferToWalletId: null,
				categoryId: s.categoryId,
				title: 'Kopi',
				note: null,
				occurredOn: `${month}-01`,
				occurredTime: null
			},
			NOW
		);
		expect(manual.ok).toBe(true);
		const load = async (query: string) =>
			(await run(async () =>
				riwayatPage.load(await ev(s.p, { path: `/riwayat?${query}`, routeId: '/(app)/riwayat' }))
			)) as unknown as {
				value: {
					totals: { count: number; totals: { outMinor: number }[] };
					page: { days: { rows: { id: string; recurringSeriesId: string | null }[] }[] };
				};
			};
		const all = (await load(`month=${month}`)).value;
		expect(all.totals.count).toBe(3);
		const chip = (await load(`month=${month}&berulang=1`)).value;
		const rows = chip.page.days.flatMap((d) => d.rows);
		expect(rows.map((r) => r.recurringSeriesId)).toEqual([active]);
		expect(chip.totals.count).toBe(1);
		expect(chip.totals.totals[0]!.outMinor).toBe(100_000_00);
		// The badge field is set on every generated row in the plain list too.
		const plain = all.page.days.flatMap((d) => d.rows);
		expect(plain.filter((r) => r.recurringSeriesId).length).toBe(2);
		// The edit page of a generated row links its live series ("Ubah seri").
		const [gen] = await live(active);
		const edit = (await run(async () =>
			editPage.load(
				await ev(s.p, {
					path: `/riwayat/${gen!.id}/edit`,
					routeId: '/(app)/riwayat/[id]/edit',
					params: { id: gen!.id }
				})
			)
		)) as unknown as { value: { seriesId: string | null } };
		expect(edit.value.seriesId).toBe(active);
	});
});

describe('CSV round trip, export and deletion', () => {
	it('a generated row exports as a plain row and re-imports without a series link or a recurrence value', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		const filter = {
			from: '2026-10-01',
			to: '2026-10-31',
			type: null,
			categoryId: null,
			walletId: null,
			q: null
		};
		const { rows } = await listTransactionsForExport(db, scopeOf(s.p), filter, null);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.recurrence).toBeNull();
		const csv = csvLine([...TEMPLATE_COLUMNS]) + rows.map((r) => csvLine(exportCells(r))).join('');
		const other = await setup();
		const imported = await importCsv(
			db,
			scopeOf(other.p),
			{
				fileText: csv,
				filename: 'ekspor.csv',
				format: 'template',
				defaultWalletId: other.walletId,
				skipPossibleDuplicates: false
			},
			NOW
		);
		expect(imported).toMatchObject({ ok: true });
		const back = await d1
			.prepare(
				`select amount_minor, occurred_on, recurrence, recurring_series_id, source from transactions
				where space_id = ? and deleted_at is null`
			)
			.bind(other.spaceId)
			.all();
		expect(back.results).toEqual([
			{
				amount_minor: 1_500_000_00,
				occurred_on: '2026-10-12',
				recurrence: null,
				recurring_series_id: null,
				source: 'csv'
			}
		]);
		expect(await live(id)).toHaveLength(1);
	});

	it('deleting the account removes its series and their transactions (foreign keys hold)', async () => {
		const s = await setup();
		const id = await series(s, '2026-10-08');
		await runDueSeries(db, s.spaceId, '2026-10-12', NOW);
		const proof = await signInWithPassword(db, s.p.user.email, PASSWORD, 1);
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, s.p.user.id, proof.hash)).toBe(true);
		expect(
			await d1
				.prepare('select count(*) as n from recurring_transactions where id = ?')
				.bind(id)
				.first()
		).toEqual({ n: 0 });
		expect(
			await d1
				.prepare('select count(*) as n from transactions where recurring_series_id = ?')
				.bind(id)
				.first()
		).toEqual({ n: 0 });
	});
});
