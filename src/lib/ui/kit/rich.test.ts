import { describe, expect, it } from 'vitest';
import { richParts } from './rich';

describe('richParts', () => {
	it('bolds each substituted value and keeps the text around it', () => {
		expect(richParts('rata-rata {jumlah}/hari', { jumlah: 'Rp359 rb' })).toEqual([
			{ text: 'rata-rata ', strong: false },
			{ text: 'Rp359 rb', strong: true },
			{ text: '/hari', strong: false }
		]);
	});
	it('handles leading, adjacent and numeric values', () => {
		expect(richParts('{a}{b} hari', { a: 'x', b: 2 })).toEqual([
			{ text: 'x', strong: true },
			{ text: '2', strong: true },
			{ text: ' hari', strong: false }
		]);
	});
	it('leaves unknown placeholders and prototype keys as written', () => {
		expect(richParts('{toString} {n}', { n: 1 })).toEqual([
			{ text: '{toString} ', strong: false },
			{ text: '1', strong: true }
		]);
	});
});
