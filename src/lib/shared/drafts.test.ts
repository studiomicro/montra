import { describe, expect, it } from 'vitest';
import {
	DRAFT_SOURCE_LABELS,
	DRAFT_SOURCES,
	draftToken,
	groupByDay,
	selectionKind
} from './drafts';
import { TRANSACTION_SOURCES } from './transactions';

describe('selectionKind (owner decision A: one category only for one kind)', () => {
	it('is null for an empty selection', () => {
		expect(selectionKind([])).toBeNull();
	});
	it('names the one kind every draft shares', () => {
		expect(selectionKind(['expense', 'expense'])).toBe('expense');
		expect(selectionKind(['income'])).toBe('income');
	});
	it('is mixed as soon as expense and income are both selected', () => {
		expect(selectionKind(['expense', 'income'])).toBe('mixed');
		expect(selectionKind(['income', 'expense', 'expense'])).toBe('mixed');
	});
});

describe('groupByDay', () => {
	it('groups consecutive rows of one WIB date, keeping their order', () => {
		const rows = [
			{ id: 'a', occurredOn: '2026-10-08' },
			{ id: 'b', occurredOn: '2026-10-08' },
			{ id: 'c', occurredOn: '2026-10-07' }
		];
		expect(groupByDay(rows)).toEqual([
			{ date: '2026-10-08', rows: [rows[0], rows[1]] },
			{ date: '2026-10-07', rows: [rows[2]] }
		]);
	});
	it('is empty for no rows', () => {
		expect(groupByDay([])).toEqual([]);
	});
});

describe('draft sources and tokens', () => {
	it('every capture source except manual is a draft source, each with a label', () => {
		expect([...DRAFT_SOURCES].sort()).toEqual(
			TRANSACTION_SOURCES.filter((s) => s !== 'manual').sort()
		);
		expect(Object.keys(DRAFT_SOURCE_LABELS).sort()).toEqual([...DRAFT_SOURCES].sort());
	});
	it('a token carries the id and the loaded updated_at', () => {
		expect(draftToken({ id: 'abc-1', updatedAt: 1_800_000_000_000 })).toBe('abc-1:1800000000000');
	});
});
