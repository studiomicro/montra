import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { qrMatrix, qrPath, QR_MAX_BYTES } from './qr';

/**
 * Matrices from Project Nayuki's Python reference encoder (qrcodegen 1.8.0, byte segment, level M,
 * no ECC boost, with and without a forced mask), generated once and stored. Versions 2, 8 (version
 * information blocks) and 10 (16-bit length field, two block sizes) are covered.
 */
const REFERENCE = JSON.parse(readFileSync('test/fixtures/qr-reference.json', 'utf8')) as {
	text: string;
	version: number;
	mask: number;
	forced?: boolean;
	rows: string[];
}[];

const rows = (m: boolean[][]) => m.map((r) => r.map((d) => (d ? '1' : '0')).join(''));

describe('qrMatrix', () => {
	it('has reference cases for versions 2, 8 and 10', () =>
		expect(new Set(REFERENCE.map((r) => r.version))).toEqual(new Set([2, 8, 10])));

	for (const ref of REFERENCE.filter((r) => r.forced))
		it(`matches the reference module for module: v${ref.version} mask ${ref.mask} "${ref.text.slice(0, 30)}"`, () => {
			expect(rows(qrMatrix(ref.text, ref.mask))).toEqual(ref.rows);
		});

	for (const ref of REFERENCE.filter((r) => !r.forced))
		it(`picks the same mask as the reference (lowest penalty): "${ref.text.slice(0, 30)}"`, () => {
			expect(rows(qrMatrix(ref.text))).toEqual(ref.rows);
		});

	it('refuses text over the version 10 capacity', () => {
		expect(() => qrMatrix('x'.repeat(QR_MAX_BYTES))).not.toThrow();
		expect(() => qrMatrix('x'.repeat(QR_MAX_BYTES + 1))).toThrow(/too long/);
	});
});

describe('qrPath', () => {
	it('draws one unit square per dark module, shifted by the quiet zone', () => {
		expect(
			qrPath(
				[
					[true, false],
					[false, true]
				],
				4
			)
		).toBe('M4 4h1v1h-1zM5 5h1v1h-1z');
	});
});
