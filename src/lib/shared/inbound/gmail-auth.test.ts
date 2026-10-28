import { describe, expect, it } from 'vitest';
import { gmailSenderAuthenticated, type MailHeader } from './auth-results';

// FN-19b red team M2: Gmail writes the envelope sender (`smtp.mailfrom`) into its own topmost
// Authentication-Results, before its `dmarc=` result. A quoted local part may carry `;`, `=` and `,`, so a sender
// can try to plant `dmarc=pass` / `dkim=pass` inside Gmail's header. The check must fail closed.

const D = 'bank-contoh.co.id';
const FROM = `noreply@${D}`;
const h = (value: string): MailHeader[] => [{ key: 'authentication-results', value }];
const ok = (value: string) => gmailSenderAuthenticated(h(value), FROM, D);
const PASS = `mx.google.com; dkim=pass header.i=@${D} header.s=sel1 header.b=AbC; spf=pass (google.com: domain of ${FROM} designates 203.0.113.9 as permitted sender) smtp.mailfrom=${FROM}; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${D}`;
/** Gmail's real verdict for a forged From: DMARC fails, whatever the envelope sender says. */
const failingWith = (mailfrom: string) =>
	`mx.google.com; spf=pass (google.com: domain of ${mailfrom} designates 203.0.113.9 as permitted sender) smtp.mailfrom=${mailfrom}; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=${D}`;

describe('gmailSenderAuthenticated fails closed on injected results (red team M2)', () => {
	it('baseline: a real pass is authenticated; a real fail is not', () => {
		expect(ok(PASS)).toBe(true);
		expect(ok(failingWith('bounce@evil.test'))).toBe(false);
	});

	const vectors: [string, string][] = [
		[
			'red-team payload: ; inside a quoted local part',
			failingWith(`"x;dmarc=pass,header.from=${D};dkim=pass,header.d=${D};y"@evil.test`)
		],
		[
			'commas only',
			failingWith(`"x,dmarc=pass,header.from=${D},dkim=pass,header.d=${D}"@evil.test`)
		],
		[
			'dkim pass injected through header.s',
			`mx.google.com; dkim=fail header.d=evil.test header.s="s;dkim=pass header.d=${D}"; dmarc=pass header.from=${D}`
		],
		[
			'dkim pass injected through header.i',
			`mx.google.com; dkim=neutral header.i="@x;dkim=pass header.i=@${D}"; dmarc=pass header.from=${D}`
		],
		[
			'escaped quote inside the local part',
			failingWith(`"x\\";dmarc=pass header.from=${D};dkim=pass header.d=${D};\\""@evil.test`)
		],
		[
			'result syntax hidden in a comment',
			`mx.google.com; spf=pass (dmarc=pass header.from=${D}; dkim=pass header.d=${D}) smtp.mailfrom=a@evil.test; dmarc=fail header.from=${D}`
		],
		[
			'a quoted ) closing a comment early',
			`mx.google.com; spf=pass (google.com: domain of ")"; dkim=pass header.d=${D}; dmarc=pass header.from=${D}; x=") smtp.mailfrom=a@evil.test; dmarc=fail header.from=${D}`
		],
		[
			'duplicate dmarc: pass then fail',
			`mx.google.com; dkim=pass header.i=@${D}; dmarc=pass header.from=${D}; dmarc=fail header.from=${D}`
		],
		[
			'duplicate dmarc: two passes',
			`mx.google.com; dkim=pass header.i=@${D}; dmarc=pass header.from=${D}; dmarc=pass header.from=${D}`
		],
		[
			'dmarc after a mailfrom with injected text (unquoted)',
			`mx.google.com; spf=pass smtp.mailfrom=x dmarc=pass header.from=${D} dkim=pass header.d=${D}; dmarc=fail header.from=${D}`
		],
		[
			'unbalanced quote',
			`mx.google.com; spf=pass smtp.mailfrom="x@evil.test; dmarc=pass header.from=${D}`
		],
		[
			'unbalanced comment',
			`mx.google.com; dkim=pass header.i=@${D} (oops; dmarc=pass header.from=${D}`
		],
		[
			'authserv-id not exactly mx.google.com (case)',
			PASS.replace('mx.google.com', 'MX.Google.com')
		],
		['authserv-id of another server', PASS.replace('mx.google.com', 'mx.google.com.evil.test')],
		[
			'a property given twice',
			PASS.replace(`header.from=${D}`, `header.from=evil.test header.from=${D}`)
		],
		['a stray word', PASS.replace('dmarc=pass', 'dmarc=pass extra')]
	];
	for (const [name, value] of vectors)
		it(`${name}: not authenticated`, () => {
			expect(ok(value)).toBe(false);
		});

	it('dkim must come from its own resinfo and align with header.from', () => {
		expect(ok(PASS.replace(`dkim=pass header.i=@${D}`, 'dkim=pass header.i=@evil.test'))).toBe(
			false
		);
		// A sibling domain's signature does not align; the domain matches case-insensitively.
		expect(ok(PASS.replace(`header.i=@${D}`, 'header.d=other-contoh.co.id'))).toBe(false);
		expect(ok(PASS.replace(`header.i=@${D}`, `header.d=${D.toUpperCase()}`))).toBe(true);
	});

	it('fuzz: no random quoted smtp.mailfrom flips a real dmarc=fail header to authenticated', () => {
		// Deterministic PRNG (mulberry32), so a failure reproduces.
		let seed = 0x5eed1234;
		const rand = () => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const pieces = [
			';',
			',',
			' ',
			'=',
			'(',
			')',
			'\\"',
			'\\\\',
			'dmarc=pass',
			'dkim=pass',
			`header.from=${D}`,
			`header.d=${D}`,
			`header.i=@${D}`,
			'mx.google.com',
			'spf=pass',
			'x'
		];
		for (let n = 0; n < 2000; n++) {
			let local = '';
			const len = 1 + Math.floor(rand() * 12);
			for (let i = 0; i < len; i++) local += pieces[Math.floor(rand() * pieces.length)];
			expect(ok(failingWith(`"${local}"@evil.test`)), local).toBe(false);
		}
	});
});
