import { describe, expect, it } from 'vitest';
import { GMAIL_QUERY_MAX, GMAIL_SENDER_TERMS, gmailQuery } from '../gmail/query.ts';
import { FIXTURE_SENDER_DOMAINS, MAIL_PARSERS, parsePaymentMail, parserFor } from './parsers.ts';
import {
	confirmedSender,
	isRegistrableHost,
	SENDER_DOMAIN_MAX_LENGTH,
	SENDER_DOMAINS,
	SENDER_DOMAINS_MAX,
	type SenderDomain
} from './sender-domains.ts';

// FN-19b § D: the confirmed real sender-domain registry. Test entries below use reserved `.example` names on
// purpose: they are never in the shipped list (whose rules the first test enforces), only passed as an argument.

const entry = (domain: string, parserId: SenderDomain['parserId'] = 'bank-qris'): SenderDomain => ({
	domain,
	institution: 'Bank Uji',
	parserId,
	confirmedBy: 'owner-sample',
	confirmedOn: '2026-10-28'
});

describe('the shipped registry (AC 22)', () => {
	it('ships empty until the owner confirms a domain; every entry would be a confirmed, real, lower-case host', () => {
		// Owner answers 2026-10-28: samples pending, so no domain is shipped.
		expect(SENDER_DOMAINS).toEqual([]);
		expect(SENDER_DOMAINS.length).toBeLessThanOrEqual(SENDER_DOMAINS_MAX);
		for (const e of SENDER_DOMAINS) {
			expect(['owner-sample', 'owner-statement']).toContain(e.confirmedBy);
			expect(e.confirmedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(isRegistrableHost(e.domain)).toBe(true);
			expect(MAIL_PARSERS.some((p) => p.id === e.parserId)).toBe(true);
		}
		expect(new Set(SENDER_DOMAINS.map((e) => e.domain)).size).toBe(SENDER_DOMAINS.length);
	});

	it('the host rule refuses reserved, upper-case, single-label, too long and malformed names', () => {
		expect(isRegistrableHost('bank-uji.co.id')).toBe(true);
		for (const bad of [
			'notifikasi.bank-qris.example',
			'bank.test',
			'bank.invalid',
			'mail.localhost',
			'Bank.co.id',
			'bank',
			'-bank.co.id',
			'bank..co.id',
			'bank.co.id.',
			`${'a'.repeat(SENDER_DOMAIN_MAX_LENGTH)}.co.id`,
			'bank co.id',
			'@bank.co.id'
		])
			expect(isRegistrableHost(bad)).toBe(false);
	});

	it('a fixture domain is never a confirmed sender (auto-save never trusts one, in any build)', () => {
		expect(FIXTURE_SENDER_DOMAINS.length).toBeGreaterThan(0);
		for (const f of FIXTURE_SENDER_DOMAINS) {
			expect(f.fixture).toBe(true);
			expect(f.domain).toMatch(/\.example$/);
			expect(confirmedSender(f.domain)).toBeNull();
		}
	});
});

describe('parserFor with the registry (AC 23)', () => {
	const registry = [entry('mail.bank-uji.example', 'bank-qris')];

	it('resolves a registry domain to its parser and a fixture domain to its own; unknown goes to the AI path', () => {
		expect(parserFor('mail.bank-uji.example', registry)?.id).toBe('bank-qris');
		expect(parserFor('MAIL.Bank-Uji.example', registry)?.id).toBe('bank-qris');
		expect(parserFor('struk.dompet-digital.example', registry)?.id).toBe('ewallet-payment');
		expect(parserFor('mail.bank-uji.example')).toBeNull();
		expect(parserFor('unknown.co.id', registry)).toBeNull();
		expect(parserFor(null, registry)).toBeNull();
	});

	it('look-alikes match nothing (exact match only)', () => {
		for (const d of [
			'evil-mail.bank-uji.example',
			'mail.bank-uji.example.evil.tld',
			'xmail.bank-uji.example',
			'bank-uji.example',
			'evil-notifikasi.bank-qris.example',
			'notifikasi.bank-qris.example.evil.tld'
		]) {
			expect(parserFor(d, registry)).toBeNull();
			expect(confirmedSender(d, registry)).toBeNull();
		}
	});

	it('a registry domain whose mail does not fit its parser shape reads nothing (no guessed amount)', () => {
		const parser = parserFor('mail.bank-uji.example', registry)!;
		expect(parsePaymentMail(parser, 'Bukti pembayaran', 'Total bayar Rp 28.000')).toBeNull();
		expect(
			parsePaymentMail(parser, 'Transaksi QRIS Berhasil', 'Nominal : Rp 28.000\nMerchant : X')
		).toBeNull();
	});
});

describe('gmailQuery with a full registry (AC 24)', () => {
	const full = Array.from({ length: SENDER_DOMAINS_MAX }, (_, i) =>
		entry(`${String(i).padStart(2, '0')}${'n'.repeat(SENDER_DOMAIN_MAX_LENGTH - 13)}.bank.co.id`)
	);

	it('30 domains of the longest allowed length stay under GMAIL_QUERY_MAX, as from: terms beside the name words', () => {
		for (const e of full) expect(e.domain.length).toBe(SENDER_DOMAIN_MAX_LENGTH);
		const q = gmailQuery(1791480725, full);
		expect(q.length).toBeLessThanOrEqual(GMAIL_QUERY_MAX);
		for (const e of full) expect(q).toContain(`@${e.domain}`);
		for (const term of GMAIL_SENDER_TERMS) expect(q).toContain(term);
		// Constants only: the query is the same for every user and every call with the same instant.
		expect(gmailQuery(1791480725, full)).toBe(q);
	});

	it('the shipped (empty) registry adds no domain term', () => {
		expect(gmailQuery(1)).not.toContain('@');
	});
});
