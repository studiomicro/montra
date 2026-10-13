import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { SPACE_SCOPED_TABLES } from '../spaces/spaces';
import {
	ACCOUNT_JSON_TABLES,
	ACCOUNT_TABLE_DECISIONS,
	exportRow,
	SPACE_JSON_TABLES,
	SPACE_TABLE_DECISIONS,
	SYSTEM_TABLES
} from './tables';

const tables = (Object.values(schema) as unknown[])
	.filter((v): v is SQLiteTable => is(v, SQLiteTable))
	.map((t) => getTableConfig(t));
const names = (list: readonly SQLiteTable[]) => list.map((t) => getTableConfig(t).name);
const columnsOf = (name: string) => tables.find((t) => t.name === name)!.columns.map((c) => c.name);

describe('export decisions (FN-31, ruling R21): no table without one', () => {
	it('every space-scoped table has exactly one decision', () => {
		expect(Object.keys(SPACE_TABLE_DECISIONS).sort()).toEqual(names(SPACE_SCOPED_TABLES).sort());
	});

	it('every table with a space_id column is space-scoped (so it needs a decision above)', () => {
		const withSpace = tables.filter((t) => t.columns.some((c) => c.name === 'space_id'));
		for (const t of withSpace)
			expect(
				t.name in SPACE_TABLE_DECISIONS || t.name in SYSTEM_TABLES,
				`${t.name}: add it to SPACE_SCOPED_TABLES and decide its export in export/tables.ts`
			).toBe(true);
	});

	it('every other table is an account table with a decision or a named system table', () => {
		for (const t of tables)
			expect(
				t.name in SPACE_TABLE_DECISIONS ||
					t.name in ACCOUNT_TABLE_DECISIONS ||
					t.name in SYSTEM_TABLES,
				`${t.name}: decide its export in export/tables.ts`
			).toBe(true);
		for (const name of Object.keys(ACCOUNT_TABLE_DECISIONS))
			expect(
				name === 'users' || columnsOf(name).includes('user_id'),
				`${name} is per account`
			).toBe(true);
	});

	it('no exported column can carry secret material', () => {
		for (const p of [...SPACE_JSON_TABLES, ...ACCOUNT_JSON_TABLES])
			for (const c of p.columns)
				expect(c.name, `${p.table}.${c.name}`).not.toMatch(
					/hash|salt|token|nonce|wrapped|kdf|endpoint|p256dh|^auth$|key_id|secret|password|dedupe|data_key|photo_key/
				);
	});

	it('another member’s user id is never written', () => {
		for (const p of [...SPACE_JSON_TABLES, ...ACCOUNT_JSON_TABLES])
			for (const c of p.columns)
				expect(c.name, `${p.table}.${c.name}`).not.toMatch(/(^|_)user_id$/);
	});
});

describe('exportRow', () => {
	const wallets = SPACE_JSON_TABLES.find((p) => p.table === 'wallets')!;

	it('camelCases keys, writes booleans, WIB instants, and masks account numbers in free text', () => {
		const row = exportRow(wallets, {
			id: 'w1',
			space_id: 's1',
			name: 'BCA 1234567890',
			type: 'bank',
			currency: 'IDR',
			opening_balance_minor: 1_250_000,
			is_favourite: 1,
			last_four: '7890',
			created_at: Date.UTC(2026, 9, 31, 17, 30),
			updated_at: Date.UTC(2026, 9, 31, 17, 30),
			deleted_at: null,
			seq: 4
		});
		expect(row).toEqual({
			id: 'w1',
			name: 'BCA ••••7890',
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 1_250_000,
			isFavourite: true,
			lastFour: '7890',
			createdAt: '2026-11-01T00:30:00+07:00',
			updatedAt: '2026-11-01T00:30:00+07:00'
		});
	});
});
