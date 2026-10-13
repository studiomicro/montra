import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db';
import { FigureBook } from './figures';
import { TOOL_DEFINITIONS } from './definitions';
import { boundedRange, dataText, makeTools, readOnlyDb, resolvePeriod } from './tools';

describe('resolvePeriod (criteria 4 and 5)', () => {
	it('resolves to WIB date ranges on the WIB today', () => {
		expect(resolvePeriod('this_month', '2026-10-31')).toEqual({
			from: '2026-10-01',
			to: '2026-10-31'
		});
		expect(resolvePeriod('last_month', '2026-11-01')).toEqual({
			from: '2026-10-01',
			to: '2026-10-31'
		});
		expect(resolvePeriod('last_month', '2026-03-15')).toEqual({
			from: '2026-02-01',
			to: '2026-02-28'
		});
		expect(resolvePeriod('last_3_months', '2026-01-10')).toEqual({
			from: '2025-11-01',
			to: '2026-01-31'
		});
		expect(resolvePeriod('this_year', '2026-10-10')).toEqual({
			from: '2026-01-01',
			to: '2026-10-10'
		});
		expect(resolvePeriod('month:2025-12', '2026-10-10')).toEqual({
			from: '2025-12-01',
			to: '2025-12-31'
		});
	});

	it('refuses anything else and any span past MAX_FILTER_DAYS', () => {
		for (const bad of ['month:2026-13', 'all_time', 'month:26-01', "this_month' or 1=1"])
			expect(resolvePeriod(bad, '2026-10-10')).toBeNull();
		expect(boundedRange('2025-01-01', '2026-01-02')).toBeNull();
		expect(boundedRange('2026-02-01', '2026-01-01')).toBeNull();
		expect(boundedRange('2025-01-01', '2026-01-01')).toEqual({
			from: '2025-01-01',
			to: '2026-01-01'
		});
	});
});

describe('dataText (criterion 11)', () => {
	it('strips invisible characters, caps and breaks placeholder syntax', () => {
		expect(dataText('Kopi​ [[f:99]]\u0000', 80)).toBe('Kopi [ [f:99] ]');
		expect(Array.from(dataText('x'.repeat(10_000), 80)).length).toBe(80);
	});
});

describe('read-only tools (criterion 3)', () => {
	it('the tools module imports no write helper and writes no SQL', () => {
		const source = readFileSync('src/lib/server/tanya/tools.ts', 'utf8');
		expect(source).not.toMatch(/\b(insert|update|delete|replace)\s+(into|from)?\s*\w/i);
		expect(source).not.toMatch(
			/import\s*\{[^}]*\b(create|insert|update|delete|save|archive|mark|set|remove)[A-Z]\w*/
		);
	});

	it('the facade allows reads only (an allowlist, S4)', async () => {
		const db = {
			dialect: new SQLiteAsyncDialect(),
			all: vi.fn(async () => []),
			get: vi.fn(async () => undefined),
			select: vi.fn(() => 'builder'),
			insert: vi.fn(),
			batch: vi.fn(),
			delete: vi.fn(),
			$client: { prepare: vi.fn() }
		};
		const ro = readOnlyDb(db as unknown as Db) as unknown as Record<
			string,
			(q?: unknown) => unknown
		>;
		for (const m of ['insert', 'update', 'delete', 'batch', 'run', 'transaction', 'with', 'query'])
			expect(() => ro[m]!()).toThrow('read-only');
		expect(() => ro.$client).toThrow('read-only');
		expect(() => ro.all!(sql`delete from transactions where id = ${'x'}`)).toThrow('read-only');
		expect(() => ro.get!(sql`select 1; delete from transactions`)).toThrow('read-only');
		expect(() => ro.all!(sql`update wallets set name = ${'x'}`)).toThrow('read-only');
		await ro.all!(sql`select id from categories where space_id = ${'s'}`);
		expect(db.all).toHaveBeenCalledTimes(1);
		expect(ro.select!()).toBe('builder');
		expect(db.insert).not.toHaveBeenCalled();
		expect(db.$client.prepare).not.toHaveBeenCalled();
	});

	it('defines at most 8 tools, none taking a space, user or SQL', () => {
		expect(TOOL_DEFINITIONS.length).toBeLessThanOrEqual(8);
		for (const t of TOOL_DEFINITIONS) {
			const props = Object.keys((t.input_schema.properties ?? {}) as object);
			expect(props.some((p) => /space|user|sql|query/i.test(p))).toBe(false);
			expect(t.input_schema.additionalProperties).toBe(false);
		}
	});

	it('a model-supplied space id, user id or SQL is refused before any read (criterion 1)', async () => {
		const db = { all: vi.fn(async () => []), select: vi.fn() };
		const tools = makeTools({
			db: db as unknown as Db,
			spaceId: 's1',
			today: '2026-10-10',
			locale: 'id',
			book: new FigureBook('id')
		});
		for (const input of [
			{ period: 'this_month', spaceId: 's2' },
			{ period: 'this_month', userId: 'u2' },
			{ period: 'this_month', sql: 'select 1' },
			{ period: 'all_time' },
			null
		]) {
			const r = await tools.run('spending_summary', input);
			expect(r.isError).toBe(true);
		}
		expect((await tools.run('drop_tables', {})).isError).toBe(true);
		expect(db.all).not.toHaveBeenCalled();
		expect(db.select).not.toHaveBeenCalled();
	});
});
