import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '#lib/server/db/schema';
import { PAID_PLANS } from '#lib/shared/billing/plans';
import { enumMentions, type EnumMention } from '../helpers/check-enums';
import { openLocalD1 } from '../helpers/d1';

/**
 * Every value a D1 CHECK constraint compares an enum column with (`col in (...)`, `col = '…'`) must match that
 * column's TS enum: the `enum:` array in schema.ts, which is the shared source array (TRANSACTION_SOURCES,
 * MODULES, PLANS, …). Read from `sqlite_master` of a local D1 with every migration applied, so this is the SQL
 * D1 enforces, not what schema.ts claims. A TS value added without a migration (or a migration value TS does
 * not know) fails here instead of as a CHECK failure on the first real insert (db-normalize F1).
 */

/** Columns whose CHECK deliberately allows only part of their enum: the TS array that names that part. */
const NARROWED: Readonly<Record<string, readonly string[]>> = {
	// A plan change, a paid checkout and a plan voucher always land on a paid plan.
	'plan_changes.to_plan': PAID_PLANS,
	'billing_events.plan': PAID_PLANS,
	'vouchers.plan': PAID_PLANS
};

const tables: SQLiteTable[] = Object.values(schema as Record<string, unknown>).flatMap((v) =>
	is(v, SQLiteTable) ? [v] : []
);

/** `table.column` → the TS enum values of every text column declared with `enum:`. */
function tsEnums(): Map<string, readonly string[]> {
	const out = new Map<string, readonly string[]>();
	for (const t of tables) {
		const config = getTableConfig(t);
		for (const c of config.columns) {
			const values = (c as { enumValues?: readonly string[] }).enumValues;
			if (values && values.length > 0) out.set(`${config.name}.${c.name}`, values);
		}
	}
	return out;
}

let d1: D1Database;
let dispose: () => Promise<void>;
/** `table.column` → every value list or compared literal the migrated database's CHECKs hold for it. */
let mentions: Map<string, EnumMention[]>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	const { results } = await d1
		.prepare(
			`select name, sql from sqlite_master where type = 'table' and sql is not null
			and name not like 'sqlite_%' and name not like '_cf_%' and name <> 'd1_migrations'`
		)
		.all<{ name: string; sql: string }>();
	mentions = new Map();
	for (const { name, sql } of results)
		for (const m of enumMentions(sql)) {
			const key = `${name}.${m.column}`;
			mentions.set(key, [...(mentions.get(key) ?? []), m]);
		}
});
afterAll(() => dispose());

/** What is wrong between the migrated CHECKs and the TS enums ([] when in sync). */
function enumDrift(
	enums: ReadonlyMap<string, readonly string[]>,
	found: ReadonlyMap<string, readonly EnumMention[]>
): string[] {
	const drift: string[] = [];
	for (const [key, values] of enums) {
		const expected = NARROWED[key] ?? values;
		const lists = found.get(key);
		if (!lists) {
			drift.push(`${key}: no CHECK names its values`);
			continue;
		}
		for (const { values: list } of lists) {
			const extra = list.filter((v) => !expected.includes(v));
			if (extra.length) drift.push(`${key}: the CHECK allows ${extra.join(', ')}, TS does not`);
		}
		const missing = expected.filter((v) => !lists.some((l) => l.values.includes(v)));
		if (missing.length) drift.push(`${key}: TS has ${missing.join(', ')}, the CHECK does not`);
	}
	// A value list on a column TS does not type as an enum (a single `= ''` / `= 'IDR'` is not a list).
	for (const [key, lists] of found)
		if (!enums.has(key) && lists.some((l) => l.op === 'in'))
			drift.push(`${key}: the CHECK holds a value list, TS has no enum for it`);
	return drift;
}

describe('D1 CHECK enum lists match their TS source arrays', () => {
	it('every enum column of the migrated database matches its TS enum, and every value list has one', () => {
		expect(enumDrift(tsEnums(), mentions)).toEqual([]);
	});

	it('names a TS value without a migration, a migration value without TS, and an untyped list', () => {
		const enums = new Map(tsEnums());
		enums.set('feature_flags.module', [...(enums.get('feature_flags.module') ?? []), 'baru']);
		enums.delete('drafts.flag');
		const found = new Map(mentions);
		found.set('wallets.type', [
			...(found.get('wallets.type') ?? []),
			{ column: 'type', values: ['dompet_kripto'], op: 'in' }
		]);
		expect(enumDrift(enums, found).sort()).toEqual([
			'drafts.flag: the CHECK holds a value list, TS has no enum for it',
			'feature_flags.module: TS has baru, the CHECK does not',
			'wallets.type: the CHECK allows dompet_kripto, TS does not'
		]);
	});

	it('every NARROWED column is a real enum column', () => {
		const enums = tsEnums();
		for (const key of Object.keys(NARROWED)) expect(enums.has(key), key).toBe(true);
	});

	it('the parsed SQL is the enforced constraint: D1 refuses a value outside the parsed list', async () => {
		expect(mentions.get('feature_flags.module')?.length).toBeGreaterThan(0);
		await expect(
			d1
				.prepare(
					`insert into feature_flags (id, user_id, module, enabled, created_at, updated_at)
					values ('x', 'nobody', 'bukan_modul', 1, 0, 0)`
				)
				.run()
		).rejects.toThrow(/CHECK constraint failed/);
	});
});
