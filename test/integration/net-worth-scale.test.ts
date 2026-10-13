import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '#lib/server/db';
import { countStatements, D1_STATEMENTS_PER_INVOCATION } from '#lib/server/db/statement-count';
import { emptyPriceBook } from '#lib/server/net-worth/prices';
import {
	netWorthSummary,
	SNAPSHOT_SPACE_STATEMENTS,
	upsertSnapshot,
	writeSnapshots
} from '#lib/server/net-worth/summary';
import { openLocalD1 } from '../helpers/d1';

let d1: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
});
afterAll(() => dispose());

/** More spaces than the old fixed 100 per tick × 18 ticks (1,800) could reach in one WIB day. */
const SPACES = 2_000;
/** D1 statements the rest of a scheduled invocation is assumed to use before the snapshots run. */
const OTHER_WORK = 100;

async function seedSpaces(count: number): Promise<string[]> {
	const ids = Array.from({ length: count }, () => crypto.randomUUID());
	// Two statements (ids bound once as JSON): a 4,000-statement batch is too large for the local proxy.
	await d1.batch([
		d1
			.prepare(
				`insert into spaces (id, kind, name, created_at, updated_at)
				select value, 'personal', 'P', 1, 1 from json_each(?)`
			)
			.bind(JSON.stringify(ids)),
		d1
			.prepare(
				`insert into wallets (id, space_id, name, type, currency, opening_balance_minor, created_at, updated_at, seq)
				select lower(hex(randomblob(16))), value, 'Tunai', 'tunai', 'IDR', 1000 + key, 1, 1, 1 from json_each(?)`
			)
			.bind(JSON.stringify(ids))
	]);
	return ids;
}

/** One scheduled invocation's snapshots: OTHER_WORK already spent, every statement counted. */
async function tick(now: number) {
	const counted = countStatements(d1);
	const result = await writeSnapshots(
		getDb(counted.d1),
		emptyPriceBook(),
		now,
		() => D1_STATEMENTS_PER_INVOCATION - OTHER_WORK - counted.statements()
	);
	return { ...result, statements: counted.statements() };
}

describe('net-worth snapshots at scale (FN-25 red team L4)', () => {
	it('one space costs at most SNAPSHOT_SPACE_STATEMENTS statements', async () => {
		const [id] = await seedSpaces(1);
		await d1.batch([
			d1
				.prepare(
					`insert into wallets (id, space_id, name, type, currency, opening_balance_minor, created_at, updated_at, seq)
					values (?, ?, 'USD', 'bank', 'USD', 500, 1, 1, 1)`
				)
				.bind(crypto.randomUUID(), id),
			d1
				.prepare(
					`insert into net_worth_items (id, space_id, kind, name, currency, price_source, manual_value_minor, created_at, updated_at, seq)
					values (?, ?, 'cash', 'K', 'IDR', 'manual', 700, 1, 1, 1)`
				)
				.bind(crypto.randomUUID(), id)
		]);
		const counted = countStatements(d1);
		const db = getDb(counted.d1);
		const now = Date.UTC(2026, 9, 9, 2, 0);
		const summary = await netWorthSummary(db, id!, emptyPriceBook(), now);
		await upsertSnapshot(db, id!, '2026-10-09', summary.totalMinor ?? 0, now, true);
		expect(counted.statements()).toBeLessThanOrEqual(SNAPSHOT_SPACE_STATEMENTS);
	});

	it(`reaches all of ${SPACES} spaces within one WIB day, every tick within the D1 per-invocation cap`, async () => {
		const ids = await seedSpaces(SPACES);
		// The hourly ticks of 9 Oct 2026, 06:00–23:00 WIB (23:00 UTC the day before … 16:00 UTC).
		const ticks = Array.from({ length: 18 }, (_, h) => Date.UTC(2026, 9, 8, 23 + h, 0));
		let used = 0;
		for (const at of ticks) {
			const r = await tick(at);
			expect(r.statements).toBeLessThanOrEqual(D1_STATEMENTS_PER_INVOCATION - OTHER_WORK);
			expect(r.failed).toBe(0);
			used++;
			const done = await d1
				.prepare(
					`select count(*) as n from net_worth_snapshots where date = '2026-10-09'
					and space_id in (select value from json_each(?))`
				)
				.bind(JSON.stringify(ids))
				.first<{ n: number }>();
			if (done?.n === SPACES) break;
		}
		const done = await d1
			.prepare(
				`select count(*) as n from net_worth_snapshots where date = '2026-10-09'
				and space_id in (select value from json_each(?))`
			)
			.bind(JSON.stringify(ids))
			.first<{ n: number }>();
		expect(done?.n).toBe(SPACES);
		expect(used).toBeLessThan(ticks.length);
	}, 300_000);

	it('touches nothing when the invocation has no room left', async () => {
		const counted = countStatements(d1);
		const r = await writeSnapshots(getDb(counted.d1), emptyPriceBook(), Date.now(), () => 3);
		expect(r).toMatchObject({ written: 0, more: true });
		expect(counted.statements()).toBe(0);
	});
});
