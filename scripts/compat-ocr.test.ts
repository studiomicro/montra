import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { png } from '../test/helpers/images';
import { ocrDoc } from '../test/helpers/ocr';
import { readOcrDocument } from '../src/lib/shared/ocr/read';
import { allowedSamplesDir, compatOcrReport, formatOcrTable, sampleLine } from './compat-ocr';

const made: string[] = [];
afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('compat:ocr (criterion 43)', () => {
	it('prints "tidak ada sampel" for a missing or empty folder', async () => {
		expect(await compatOcrReport('.superpowers/ref/samples/ocr-tidak-ada')).toContain(
			'tidak ada sampel'
		);
	});

	it('refuses a folder outside .superpowers/ref/samples/', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'compat-ocr-'));
		made.push(outside);
		expect(allowedSamplesDir(outside)).toBe(false);
		expect(allowedSamplesDir('.superpowers/ref/samples/../../src')).toBe(false);
		expect(allowedSamplesDir('.superpowers/ref/samples/ocr')).toBe(true);
		expect(await compatOcrReport(outside)).toMatch(/refuses a folder outside/);
	});

	it('reports counts and shapes only, never a file name, title or amount', async () => {
		const dir = '.superpowers/ref/samples/ocr-test-fiktif';
		mkdirSync(join(dir, 'gopay'), { recursive: true });
		made.push(dir);
		writeFileSync(
			join(dir, 'gopay', 'rahasia 1234567890123.png'),
			png({ width: 1080, height: 2400 })
		);
		const doc = ocrDoc([
			[
				'09:41',
				'GoPay',
				'Riwayat',
				'08 Okt 2026',
				'Kopi Senja Fiktif   -Rp25.000',
				'Top Up   Rp100.000'
			]
		]);
		const report = await compatOcrReport(dir, async () => ({
			recognise: async () => [],
			terminate: async () => {}
		}));
		expect(report).toContain('OCR samples (1 files');
		expect(report).not.toMatch(/rahasia|1234567890123|gopay/);
		const line = sampleLine(
			doc,
			readOcrDocument({ doc, institution: null, section: null, todayWib: '2026-10-10' }),
			1234.4
		);
		const table = formatOcrTable([line]);
		expect(table).toMatch(/^#\s+pixels\s+mean conf\s+words/);
		expect(table).toMatch(
			/1\s+1080x2400\s+96\s+13\s+gopay\s+2\s+direction_unknown: 1\s+0\s+not printed\s+1234/
		);
		expect(table).not.toMatch(/Kopi|Senja|25\.000|100\.000/);
	});
});
