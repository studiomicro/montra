import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0031 (FN-30 hardening, criterion 7): applied to a local D1 migrated up to 0030 that already holds a
 * `paid_not_applied` billing event (and an applied one), the event gets exactly one `unknown`/`pending` refund
 * obligation; running the migration's own backfill statement again adds nothing.
 */

const MIGRATION = '0031_billing_hardening.sql';

let d1: D1Database;
let dispose: () => Promise<void>;

const run = (sql: string, ...params: unknown[]) =>
	d1
		.prepare(sql)
		.bind(...params)
		.run();
const rows = async <R>(sql: string, ...params: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...params)
			.all<R>()
	).results;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1({ before: MIGRATION }));
});
afterAll(() => dispose());

describe('migration 0031 backfill', () => {
	it('gives a pre-existing paid_not_applied event one unknown/pending refund, once', async () => {
		const userId = crypto.randomUUID();
		await run(
			`insert into users (id, email, name, status, adult_confirmed_at, created_at) values (?, ?, 'Lama', 'active', 1, 1)`,
			userId,
			`lama-${userId}@contoh.id`
		);
		const event = (id: string, kind: string, ref: string, at: number) =>
			run(
				`insert into billing_events (id, user_id, provider, provider_event_id, kind, reference, plan, amount_minor,
					currency, signature_valid, created_at) values (?, ?, 'mock', ?, ?, ?, 'pro', 4900000, 'IDR', 1, ?)`,
				id,
				userId,
				`pe-${id}`,
				kind,
				ref,
				at
			);
		await event('ev-unapplied', 'paid_not_applied', 'ref-a', 1_790_000_000_000);
		await event('ev-applied', 'payment_succeeded', 'ref-b', 1_790_000_000_500);

		await applyMigration(d1, MIGRATION);

		const refunds = await rows<Record<string, unknown>>(
			`select billing_event_id, user_id, provider, reference, amount_minor, currency, reason, status,
				provider_refund_id, created_at, resolved_at from billing_refunds`
		);
		expect(refunds).toEqual([
			{
				billing_event_id: 'ev-unapplied',
				user_id: userId,
				provider: 'mock',
				reference: 'ref-a',
				amount_minor: 4_900_000,
				currency: 'IDR',
				reason: 'unknown',
				status: 'pending',
				provider_refund_id: null,
				created_at: 1_790_000_000_000,
				resolved_at: null
			}
		]);

		const backfill = readFileSync(`migrations/${MIGRATION}`, 'utf8')
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter((s) => s.includes('INSERT INTO `billing_refunds`'));
		expect(backfill).toHaveLength(1);
		await run(backfill[0]!);
		expect(await rows(`select id from billing_refunds`)).toHaveLength(1);
		// The new tables exist with their triggers and indexes.
		const names = (
			await rows<{ name: string }>(`select name from sqlite_master order by name`)
		).map((r) => r.name);
		for (const name of [
			'billing_refunds_no_update',
			'billing_refunds_no_delete',
			'billing_refunds_status_idx',
			'billing_refunds_user_idx',
			'claim_markers',
			'claim_markers_uq'
		])
			expect(names).toContain(name);
	});
});
