import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureText } from '../test/helpers/mail.ts';
import { compatSendersReport, senderLine } from './compat-senders.ts';

// FN-19b `compat:senders`: here only with the fictional fixtures (the owner's real samples are never in the repo).

const dir = mkdtempSync(join(tmpdir(), 'compat-senders-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('compat:senders', () => {
	it('says so when there are no samples', async () => {
		expect(await compatSendersReport(join(dir, 'none'))).toMatch(/^tidak ada sampel e-mail/);
	});

	it('per sample: masked folder, From and DMARC domains, parser, whether it reads, registry; never content', async () => {
		mkdirSync(join(dir, 'Bank 1234567890'), { recursive: true });
		writeFileSync(
			join(dir, 'Bank 1234567890', 'rahasia-nama-file.eml'),
			fixtureText('bank-qris/payment', 'pemilik@gmail.example')
		);
		writeFileSync(join(dir, 'lain.eml.txt'), fixtureText('other/promo', 'pemilik@gmail.example'));
		const report = await compatSendersReport(dir);
		const lines = report.split('\n');
		expect(lines[0]).toBe('folder  domain  dmarc-from  parser  reads  registry');
		expect(lines).toContain(
			'Bank ••••7890  notifikasi.bank-qris.example  notifikasi.bank-qris.example  bank-qris  yes  no'
		);
		expect(report).not.toMatch(/rahasia|KEDAI|28\.000|pemilik|1234567890|Transaksi QRIS/);
	});

	it('an unreadable sample is one line', async () => {
		const line = await senderLine('(root)', new Uint8Array([0xff, 0x00]));
		expect(line).toMatchObject({ parser: '-', reads: '-', registry: 'no' });
	});
});
