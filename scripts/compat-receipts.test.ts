import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { readReceiptImage } from '../src/lib/server/receipts/anthropic';
import { jpeg } from '../test/helpers/images';
import { compatReceiptsReport, credentialsFrom, parseDevVars } from './compat-receipts';

// Synthetic, fictional photos in a throw-away folder; the owner's real samples are never read by tests, and the
// provider is a double: no test reaches the gateway or Anthropic.
const dirs: string[] = [];
function samples(files: Record<string, Uint8Array | string>): string {
	const root = mkdtempSync(join(tmpdir(), 'fin-receipts-'));
	dirs.push(root);
	for (const [path, data] of Object.entries(files)) {
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), data);
	}
	return root;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CREDENTIALS = {
	apiKey: 'sk-ant-api03-synthetic-0001-AbCdEfGh',
	env: { AI_GATEWAY_ACCOUNT_ID: 'acct', AI_GATEWAY_ID: 'gw' }
};
const reading = {
	shop: 'Warung Rahasia Fiktif',
	occurredOn: '2026-10-08',
	items: [
		{ name: 'Nasi rahasia', amountMinor: 2_500_000 },
		{ name: 'Teh rahasia', amountMinor: 800_000 }
	],
	taxMinor: null,
	serviceMinor: null,
	discountMinor: null,
	totalMinor: 3_300_000,
	currency: 'IDR',
	paymentMethod: 'QRIS'
};

describe('compat:receipts', () => {
	it('an empty or missing folder prints a notice and calls nothing', async () => {
		const read = vi.fn();
		expect(
			await compatReceiptsReport(join(tmpdir(), 'fin-receipts-none'), CREDENTIALS, read)
		).toMatch(/^Tidak ada sampel struk/);
		expect(read).not.toHaveBeenCalled();
	});

	it('without a local key it only counts samples', async () => {
		const root = samples({
			'toko/struk-satu.jpg': jpeg(),
			'toko/struk-satu.expected.json': '{"totalRupiah": 33000}',
			'toko/struk-dua.png': jpeg()
		});
		const read = vi.fn();
		const out = await compatReceiptsReport(root, null, read);
		expect(out).toContain('Receipts: 2 photos, 1 with an .expected.json.');
		expect(out).toContain('tidak ada kunci Anthropic lokal — hanya menghitung sampel');
		expect(read).not.toHaveBeenCalled();
	});

	it('prints match/miss per field and counts only — never a file name, merchant, item or amount', async () => {
		const root = samples({
			'rahasia/struk-warung.jpg': jpeg(),
			'rahasia/struk-warung.expected.json': JSON.stringify({
				shop: 'warung rahasia fiktif',
				totalRupiah: 33_000,
				date: '2026-10-09',
				itemCount: 2
			}),
			'rahasia/bukan.jpg': jpeg({ width: 20 }),
			'rahasia/bukan.expected.json': '{"itemCount": 1}'
		});
		// Files are read in sorted order: bukan.jpg first, then struk-warung.jpg.
		let calls = 0;
		const read = vi.fn<typeof readReceiptImage>(async () =>
			++calls === 1 ? { kind: 'not_a_receipt' } : { kind: 'ok', reading }
		);
		const out = await compatReceiptsReport(root, CREDENTIALS, read);
		expect(out.split('\n')).toEqual([
			'Receipts: 2 photos, 2 with an .expected.json.',
			'1  not_a_receipt',
			'2  ok  shop:match  total:match  date:miss  items:match',
			'Fields matched: 3/4.'
		]);
		for (const secret of ['rahasia', 'warung', 'bukan', 'Nasi', '33', '25.000', 'sk-ant'])
			expect(out).not.toContain(secret);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('reads the key and gateway from .dev.vars text only when all three are there', () => {
		const vars = parseDevVars(
			'# comment\nAI_GATEWAY_ACCOUNT_ID=acct\nAI_GATEWAY_ID="gw"\nCOMPAT_RECEIPTS_ANTHROPIC_KEY=sk-ant-x\n'
		);
		expect(credentialsFrom(vars)).toEqual({
			apiKey: 'sk-ant-x',
			env: { AI_GATEWAY_ACCOUNT_ID: 'acct', AI_GATEWAY_ID: 'gw' }
		});
		expect(credentialsFrom({ ...vars, COMPAT_RECEIPTS_ANTHROPIC_KEY: 'not-a-key' })).toBeNull();
		expect(credentialsFrom({ AI_GATEWAY_ID: 'gw' })).toBeNull();
	});
});
