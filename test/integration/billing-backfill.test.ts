import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb, type Db } from '#lib/server/db';
import { openLocalD1 } from '../helpers/d1';

/**
 * QA (fn-30-billing): proves the migration's own backfill statements (`migrations/0018_billing.sql`), not a
 * re-implementation of them, give a pre-FN-30 user exactly one Gratis plan row and one 300-credit starter grant,
 * and that re-running them (as the migration file itself can be re-applied) grants nothing a second time.
 */
describe('migration backfill: existing users get Gratis + 300 credits exactly once', () => {
	let d1: D1Database;
	let db: Db;
	let dispose: () => Promise<void>;
	let backfillStatements: string[];

	beforeAll(async () => {
		({ db: d1, dispose } = await openLocalD1());
		db = getDb(d1);
		const { readFileSync } = await import('node:fs');
		const sql = readFileSync('migrations/0018_billing.sql', 'utf8');
		backfillStatements = sql
			.split('\n')
			.map((s) =>
				s
					.trim()
					.replace(/--> statement-breakpoint\s*$/, '')
					.trim()
			)
			.filter(
				(s) =>
					s.startsWith('INSERT INTO `user_plan_state`') ||
					s.startsWith('INSERT INTO `credit_ledger`')
			);
		expect(backfillStatements).toHaveLength(2);
	});
	afterAll(() => dispose());

	it('a legacy user (inserted directly, as if from before FN-30) gets backfilled once, and a second run changes nothing', async () => {
		const userId = crypto.randomUUID();
		await d1
			.prepare(
				`insert into users (id, email, name, status, adult_confirmed_at, created_at) values (?, ?, ?, 'active', ?, ?)`
			)
			.bind(userId, `legacy-${userId}@contoh.id`, 'Legacy', 1, 1)
			.run();

		// Before backfill: no plan state, no ledger row (a genuinely pre-FN-30 account).
		const before = await db.all<{ n: number }>(
			sql`select count(*) as n from user_plan_state where user_id = ${userId}`
		);
		expect(before[0]?.n).toBe(0);

		for (const statement of backfillStatements) await d1.prepare(statement).run();

		const plan = await db.all<{ plan: string; user_id: string }>(
			sql`select plan, user_id from user_plan_state where user_id = ${userId}`
		);
		expect(plan).toEqual([{ plan: 'gratis', user_id: userId }]);
		const ledger = await db.all<{ delta: number; reason: string }>(
			sql`select delta, reason from credit_ledger where user_id = ${userId}`
		);
		expect(ledger).toEqual([{ delta: 300, reason: 'starter_grant' }]);

		// Re-running the same backfill (e.g. the migration file applied again) grants nothing a second time.
		for (const statement of backfillStatements) await d1.prepare(statement).run();
		const planAfter = await db.all<{ n: number }>(
			sql`select count(*) as n from user_plan_state where user_id = ${userId}`
		);
		expect(planAfter[0]?.n).toBe(1);
		const ledgerAfter = await db.all<{ n: number }>(
			sql`select count(*) as n from credit_ledger where user_id = ${userId}`
		);
		expect(ledgerAfter[0]?.n).toBe(1);
	});
});
