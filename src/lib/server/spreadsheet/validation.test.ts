import { describe, expect, it } from 'vitest';
import {
	parseMappingFields,
	parseSheetFields,
	reserveSheetRead,
	SHEET_READ_LANE_MAX
} from './validation';

const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.append(k, v);
	return f;
};

describe('parseMappingFields', () => {
	it('reads tabs, roles, kind, month and fill-down; a missing column reads as Abaikan', () => {
		expect(
			parseMappingFields(
				form({
					fillDown: 'on',
					'tab.2.use': 'on',
					'tab.2.header': '3',
					'tab.2.kind': 'expense',
					'tab.2.month': '2026-10',
					'tab.2.col.0': 'date',
					'tab.2.col.2': 'amount',
					'tab.0.header': '0',
					'tab.0.kind': 'auto',
					'tab.0.month': ''
				})
			)
		).toEqual({
			fillDown: true,
			tabs: [
				{ tab: 0, use: false, headerRow: 0, columns: [], kind: 'auto', month: null },
				{
					tab: 2,
					use: true,
					headerRow: 3,
					columns: ['date', 'ignore', 'amount'],
					kind: 'expense',
					month: '2026-10'
				}
			]
		});
		expect(parseMappingFields(form({ walletId: 'x' }))).toBeNull();
	});

	it.each([
		['unknown role', { 'tab.0.col.0': 'formula' }],
		['unknown kind', { 'tab.0.kind': 'transfer' }],
		['bad month', { 'tab.0.month': '2026-13' }],
		['bad header', { 'tab.0.header': '-1' }],
		['column past the cap', { 'tab.0.col.50': 'date' }],
		['prototype key', { 'tab.0.col.0': '__proto__' }]
	])('%s → invalid', (_, fields) => expect(parseMappingFields(form(fields))).toBe('invalid'));

	it('more than 40 tabs → invalid', () => {
		const fields: Record<string, string> = {};
		for (let i = 0; i < 41; i++) fields[`tab.${i}.kind`] = 'auto';
		expect(parseMappingFields(form(fields))).toBe('invalid');
	});
});

describe('parseSheetFields', () => {
	it('"Baca berkas" ignores a posted mapping; a wallet is required to import', () => {
		const f = form({
			step: 'read',
			'tab.0.col.0': 'date',
			walletId: 'w1',
			skipPossibleDuplicates: 'on'
		});
		expect(parseSheetFields(f, { requireWallet: false })).toEqual({
			ok: true,
			value: { walletId: 'w1', skipPossibleDuplicates: true, mapping: null, aiTab: null }
		});
		expect(parseSheetFields(form({}), { requireWallet: true })).toEqual({
			ok: false,
			error: 'Pilih dompet untuk impor ini.'
		});
		expect(parseSheetFields(form({ aiTab: 'x' }), { requireWallet: false })).toMatchObject({
			ok: false
		});
	});
});

describe('reserveSheetRead', () => {
	it('one read per user, at most SHEET_READ_LANE_MAX per isolate, released once', () => {
		const a = reserveSheetRead('a')!;
		expect(reserveSheetRead('a')).toBeNull();
		const held = Array.from({ length: SHEET_READ_LANE_MAX - 1 }, (_, i) =>
			reserveSheetRead(`u${i}`)!
		);
		expect(reserveSheetRead('z')).toBeNull();
		a();
		a();
		const z = reserveSheetRead('z')!;
		expect(z).not.toBeNull();
		z();
		held.forEach((r) => r());
	});
});
