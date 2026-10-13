import { describe, expect, it } from 'vitest';
import { mailTrust, parseAuthResults, trustedAuthResults, type MailHeader } from './auth-results';

const ID = 'mx.inbound.example';
const BANK = 'notifikasi.bank-qris.example';
const allowlisted = (d: string) => d === BANK;
const good = `${ID}; spf=pass smtp.mailfrom=${BANK}; dkim=pass (2048-bit key) header.d=${BANK} header.s=s1; dmarc=pass (p=REJECT sp=REJECT) header.from=${BANK}`;
const h = (...values: string[]): MailHeader[] =>
	values.map((value) => ({ key: 'authentication-results', value }));
const trust = (headers: MailHeader[], from = `noreply@${BANK}`, id: string | null = ID) =>
	mailTrust({
		auth: trustedAuthResults(headers, id),
		fromAddress: from,
		ownerEmail: 'budi@mail.example',
		allowlisted
	});

describe('Authentication-Results (RFC 8601), fail closed', () => {
	it('parses authserv-id, DMARC and passing DKIM domains, ignoring comments', () => {
		expect(parseAuthResults(good)).toEqual({
			authservId: ID,
			dmarc: 'pass',
			dmarcFrom: BANK,
			dkimPass: [BANK]
		});
		expect(parseAuthResults(`${ID} 1; dkim=pass header.i=@${BANK}`)?.dkimPass).toEqual([BANK]);
		expect(parseAuthResults(`${ID}; dkim=fail header.d=${BANK}`)?.dkimPass).toEqual([]);
		expect(parseAuthResults('')).toBeNull();
		expect(parseAuthResults('x'.repeat(5000))).toBeNull();
	});

	it('verified: our authserv-id, DMARC pass, aligned DKIM pass, allowlisted sender', () => {
		expect(trust(h(good))).toBe('verified');
		// A subdomain of the signing domain is aligned (relaxed).
		expect(trust(h(good.replace(`header.d=${BANK}`, 'header.d=bank-qris.example')))).toBe(
			'verified'
		);
	});

	it('unverified when INBOUND_AUTHSERV_ID is unset, or the topmost header is another server’s', () => {
		expect(trust(h(good), undefined, null)).toBe('unverified');
		expect(trust(h(good), undefined, '')).toBe('unverified');
		expect(trust(h(good.replace(ID, 'mx.attacker.example')))).toBe('unverified');
	});

	it('only the topmost header counts: a sender-injected copy below is ignored', () => {
		const failing = `${ID}; dkim=fail header.d=${BANK}; dmarc=fail header.from=${BANK}`;
		expect(trust(h(failing, good))).toBe('unverified');
		expect(trustedAuthResults([{ key: 'subject', value: 'x' }, ...h(good)], ID)).not.toBeNull();
		expect(trust([])).toBe('unverified');
	});

	it('unverified on DMARC fail, DKIM fail, unaligned DKIM, a different From, or an unlisted sender', () => {
		expect(trust(h(good.replace('dmarc=pass', 'dmarc=fail')))).toBe('unverified');
		expect(trust(h(good.replace('dkim=pass', 'dkim=fail')))).toBe('unverified');
		expect(trust(h(good.replace(`header.d=${BANK}`, 'header.d=other.example')))).toBe('unverified');
		expect(trust(h(good), 'noreply@other.example')).toBe('unverified');
		const other = good.replaceAll(BANK, 'toko.example');
		expect(trust(h(other), 'noreply@toko.example')).toBe('unverified');
	});

	it('forwarded: the owner’s own mailbox with DMARC pass; never verified', () => {
		const own = `${ID}; dkim=pass header.d=mail.example; dmarc=pass header.from=mail.example`;
		expect(trust(h(own), 'Budi@Mail.Example')).toBe('forwarded');
		expect(trust(h(own.replace('dmarc=pass', 'dmarc=fail')), 'budi@mail.example')).toBe(
			'unverified'
		);
	});
});
