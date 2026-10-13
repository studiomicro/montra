import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	fictionalStatementCsv,
	fictionalStatementPdf
} from '../test/fixtures/statements/fictional-bank';
import { MANDIRI_AUGUST, mandiriPdf } from '../test/fixtures/statements/mandiri';
import { buildPdf } from '../test/helpers/pdf';
import { compatReport, formatMatrix, samplePassword } from './compat-statements';

// Synthetic, fictional files in a throw-away folder; the owner's real samples are never read by tests.
const dirs: string[] = [];
function samples(files: Record<string, Uint8Array | string>): string {
	const root = mkdtempSync(join(tmpdir(), 'fin-compat-'));
	dirs.push(root);
	mkdirSync(join(root, 'statements'), { recursive: true });
	for (const [path, data] of Object.entries(files)) {
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), data);
	}
	return root;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('compat:statements', () => {
	it('an empty or missing samples folder prints a notice', async () => {
		const out = await compatReport(join(tmpdir(), 'fin-compat-does-not-exist'), null);
		expect(out).toContain('No statement samples');
		expect(out).toContain('No receipt samples');
		expect(await compatReport(samples({}), null)).toContain('tidak ada sampel');
	});

	it('prints counts and typed outcomes only — no file name, account number or row text', async () => {
		const root = samples({
			'statements/bankfiktif/rekening 1234567890123 desember.pdf': fictionalStatementPdf(),
			'statements/bankfiktif/ekspor-rahasia.csv': fictionalStatementCsv(),
			'statements/scan/hasil-pindai.pdf': buildPdf([{ content: '', image: true }]),
			'statements/terkunci/sandi.pdf': fictionalStatementPdf({ password: 'sandi-fiktif' }),
			'statements/lain/tabel.xlsx': new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]),
			'receipts/toko/struk-kopi.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
		});
		const out = await compatReport(root, null);
		expect(out).toContain('Statements (5 files):');
		expect(out).toMatch(/bankfiktif\s+pdf_text\s+unknown\s+3\s+—\s+— \(institution not detected\)/);
		expect(out).toMatch(/bankfiktif\s+csv\s+unknown/);
		expect(out).toMatch(/scan\s+pdf_scanned .*perlu dibaca AI/);
		expect(out).toMatch(/terkunci .*password-protected/);
		expect(out).toMatch(/lain .*XLS\/XLSX not supported/);
		expect(out).toMatch(/^1 {2}toko {2}read with npm run compat:receipts$/m);
		for (const secret of [
			'1234567890123',
			'desember',
			'rahasia',
			'pindai',
			'struk-kopi',
			'KOPI',
			'GAJI',
			'9876543210987',
			'NAMA PEMILIK'
		])
			expect(out).not.toContain(secret);
	});

	it('opens a protected sample with the .pdf-password next to it and never prints the password', async () => {
		const root = samples({
			'statements/terbuka/sandi.pdf': fictionalStatementPdf({ password: 'sandi-fiktif' }),
			'statements/terbuka/.pdf-password': 'sandi-fiktif\n',
			'statements/salah/sandi.pdf': fictionalStatementPdf({ password: 'sandi-fiktif' }),
			'statements/salah/.pdf-password': 'bukan-sandinya',
			'statements/tanpa/sandi.pdf': fictionalStatementPdf({ password: 'sandi-fiktif' })
		});
		const out = await compatReport(root, null);
		expect(out).toContain('Statements (3 files):');
		expect(out).toMatch(/terbuka\s+pdf_text\s+unknown\s+3/);
		expect(out).toMatch(/salah .*wrong password/);
		expect(out).toMatch(/tanpa .*password-protected/);
		expect(out).not.toContain('sandi-fiktif');
		expect(out).not.toContain('bukan-sandinya');
		// The folder's file beats the environment fallback; without one the fallback is used.
		const fallback = await compatReport(root, 'sandi-fiktif');
		expect(fallback).toMatch(/tanpa\s+pdf_text\s+unknown\s+3/);
		expect(fallback).toMatch(/salah .*wrong password/);
	});

	it('red team L1: a .pdf-password that is a symlink is never followed, inside or outside the folder', async () => {
		const root = samples({
			'statements/luar/sandi.pdf': fictionalStatementPdf({ password: 'sandi-fiktif' }),
			'statements/dalam/sandi.pdf': fictionalStatementPdf({ password: 'sandi-fiktif' }),
			'statements/dalam/sandi-asli.txt': 'sandi-fiktif'
		});
		const outside = mkdtempSync(join(tmpdir(), 'fin-compat-outside-'));
		dirs.push(outside);
		writeFileSync(join(outside, 'rahasia'), 'sandi-fiktif');
		symlinkSync(join(outside, 'rahasia'), join(root, 'statements/luar/.pdf-password'));
		symlinkSync(
			join(root, 'statements/dalam/sandi-asli.txt'),
			join(root, 'statements/dalam/.pdf-password')
		);
		for (const folder of ['luar', 'dalam'])
			expect(samplePassword(join(root, 'statements', folder, 'sandi.pdf'), null)).toBeNull();
		expect(samplePassword(join(root, 'statements/luar/sandi.pdf'), 'cadangan')).toBe('cadangan');
		const out = await compatReport(root, null);
		expect(out).toMatch(/luar .*password-protected/);
		expect(out).not.toContain('sandi-fiktif');
		// A folder's .pdf-password that is a directory is ignored too.
		mkdirSync(join(root, 'statements/map/.pdf-password'), { recursive: true });
		expect(samplePassword(join(root, 'statements/map/x.pdf'), null)).toBeNull();
	});

	it('a multi-account statement gets one line per account, counts only', async () => {
		const out = await compatReport(
			samples({ 'statements/mandiri/2026-08.pdf': mandiriPdf(MANDIRI_AUGUST) }),
			null
		);
		expect(out).toMatch(/mandiri#1\s+pdf_text\s+mandiri\s+4\s+4\s+0\s+pass \(Rp0 gap\)/);
		expect(out).toMatch(/mandiri#2\s+pdf_text\s+mandiri\s+4\s+2\s+0\s+pass \(Rp0 gap\)/);
		for (const secret of ['1230009876543', '6543', 'Tabungan', 'FIKTIF', '2026-08'])
			expect(out).not.toContain(secret);
	});

	it('a folder name holding an account number is masked', async () => {
		const out = await compatReport(
			samples({ 'statements/9988776655443/a.pdf': fictionalStatementPdf() }),
			null
		);
		expect(out).not.toContain('9988776655443');
		expect(out).toContain('••••5443');
	});

	it('aligns the matrix columns', () => {
		const text = formatMatrix([
			{
				folder: 'a',
				format: 'csv',
				institution: 'x',
				pages: '—',
				parsed: '1',
				rejected: '0',
				balance: '—'
			}
		]);
		expect(text.split('\n')).toHaveLength(2);
		expect(text.split('\n')[0]).toMatch(/^# {2}folder {2}format/);
	});

	it('runs under plain Node and exits 0 on an empty folder', () => {
		const r = spawnSync(
			process.execPath,
			['scripts/compat-statements.ts', `--samples=${join(tmpdir(), 'fin-compat-none')}`],
			{ cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' }
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('No statement samples');
	});
});
