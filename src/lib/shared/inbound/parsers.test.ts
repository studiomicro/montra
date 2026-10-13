import { describe, expect, it } from 'vitest';
import { parseMail } from '../../../../workers/inbound/src/mime';
import { bytes, fixtureText } from '../../../../test/helpers/mail';
import { MAIL_PARSERS, parsePaymentMail, parserFor, parseWibDateTime } from './parsers';

async function read(name: string) {
	const mail = await parseMail(bytes(fixtureText(name)));
	if (!mail) throw new Error(`fixture ${name} did not parse`);
	const parser = parserFor(mail.fromAddress.split('@')[1] ?? null);
	return {
		mail,
		parser,
		payment: parser ? parsePaymentMail(parser, mail.subject, mail.text) : null
	};
}

const at = (iso: string) => Date.parse(iso);

describe('deterministic payment parsers (fictional fixtures)', () => {
	it('bank-qris: expense Rp 28.000 → 2.800.000 minor, WIB date, reference and account masked', async () => {
		const { parser, payment } = await read('bank-qris/payment');
		expect(parser?.id).toBe('bank-qris');
		expect(payment).toEqual({
			direction: 'expense',
			amountMinor: 2_800_000,
			merchant: 'KEDAI KOPI SENJA',
			occurredOn: '2026-10-08',
			occurredAt: at('2026-10-08T14:32:05+07:00'),
			reference: '••••3456',
			// The full reference only feeds the dedupe hash (red team M1); it is never stored.
			referenceKey: '20261008143205123456',
			last4: '7890'
		});
	});

	it('ewallet-payment (multipart): expense from the text part', async () => {
		const { payment } = await read('ewallet-payment/payment');
		expect(payment).toMatchObject({
			direction: 'expense',
			amountMinor: 2_800_000,
			merchant: 'Kedai Kopi Senja',
			occurredOn: '2026-10-08',
			occurredAt: at('2026-10-08T14:32:00+07:00'),
			reference: 'GP-ABC123'
		});
	});

	it('bank-transfer-in: income, the merchant is the sender', async () => {
		const { payment } = await read('bank-transfer-in/transfer');
		expect(payment).toMatchObject({
			direction: 'income',
			amountMinor: 150_000_000,
			merchant: 'Budi Santoso',
			occurredOn: '2026-10-08',
			occurredAt: at('2026-10-08T09:10:00+07:00'),
			// 8 digits: masked like an account number (maskAccountNumbers).
			reference: '\u2022\u2022\u2022\u20221234'
		});
	});

	it('bank-transfer-out: IDR 250,000.00 with a day-first numeric date', async () => {
		const { payment } = await read('bank-transfer-out/transfer');
		expect(payment).toMatchObject({
			direction: 'expense',
			amountMinor: 25_000_000,
			merchant: 'Siti Aminah',
			occurredOn: '2026-10-08',
			occurredAt: at('2026-10-08T18:05:00+07:00'),
			reference: '••••6655'
		});
	});

	it('a wrong shape is never guessed: two amounts, CR on an expense, DB on income, no amount, no date', async () => {
		for (const name of [
			'bank-qris/wrong-two-amounts',
			'bank-qris/wrong-credit',
			'bank-transfer-in/wrong-debit',
			'ewallet-payment/wrong-missing-amount',
			'bank-transfer-out/wrong-missing-date'
		]) {
			const { parser, payment } = await read(name);
			expect(parser, name).not.toBeNull();
			expect(payment, name).toBeNull();
		}
	});

	it('WIB month boundaries: 23:30 on the last day stays in that month, 00:30 on the first is the next', async () => {
		const end = (await read('bank-qris/month-end')).payment!;
		expect(end.occurredOn).toBe('2026-10-31');
		expect(end.occurredAt).toBe(at('2026-10-31T16:30:00Z'));
		const start = (await read('bank-qris/month-start')).payment!;
		expect(start.occurredOn).toBe('2026-11-01');
		expect(start.occurredAt).toBe(at('2026-10-31T17:30:00Z'));
	});

	it('only reads its own subject and its own (fictional) sender domains', async () => {
		const { mail, parser } = await read('bank-qris/payment');
		expect(parsePaymentMail(parser!, 'Halo', mail.text)).toBeNull();
		expect(parserFor('bca.co.id')).toBeNull();
		expect(parserFor(null)).toBeNull();
		for (const p of MAIL_PARSERS) for (const d of p.domains) expect(d).toMatch(/\.example$/);
	});

	it('reads the printed date shapes and refuses impossible ones', () => {
		expect(parseWibDateTime('08 Okt 2026 14:32:05 WIB')?.occurredOn).toBe('2026-10-08');
		expect(parseWibDateTime('8 Oktober 2026, 14:32')?.occurredOn).toBe('2026-10-08');
		expect(parseWibDateTime('1 Agt 2026 00:00')?.occurredOn).toBe('2026-08-01');
		expect(parseWibDateTime('08/10/2026 18:05')?.occurredOn).toBe('2026-10-08');
		for (const bad of [
			'31/02/2026 10:00',
			'08 Foo 2026 10:00',
			'08/10/2026 24:00',
			'2026-10-08',
			''
		])
			expect(parseWibDateTime(bad), bad).toBeNull();
	});
});
