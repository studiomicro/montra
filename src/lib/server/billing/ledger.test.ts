import { describe, expect, it } from 'vitest';
import { parseLedgerCursor } from './ledger';

describe('parseLedgerCursor', () => {
	it('reads `<createdAt>_<id>`', () => {
		expect(parseLedgerCursor('1791419629051_0b6c3a1e-1111-4222-8333-444455556666')).toEqual({
			createdAt: 1791419629051,
			id: '0b6c3a1e-1111-4222-8333-444455556666'
		});
	});
	it('ignores anything else (page 1)', () => {
		for (const bad of [
			null,
			'',
			'abc',
			'12_',
			'_ab',
			'1e3_ab',
			'1_AB',
			'1_ab cd',
			`1_${'a'.repeat(65)}`
		])
			expect(parseLedgerCursor(bad)).toBeNull();
	});
});
