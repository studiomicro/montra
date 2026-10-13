import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode } from '#lib/shared/base64url';
import { challengeOf, passkeyOrigin, passkeyRpId, userHandle } from './passkey-flow';

describe('passkeyRpId (Owner decision 7)', () => {
	it('is the request host on a deployment or localhost', () => {
		expect(passkeyRpId(new URL('https://app.example.com/masuk'))).toBe('app.example.com');
		expect(passkeyRpId(new URL('https://APP.example.com./masuk'))).toBe('app.example.com');
		expect(passkeyRpId(new URL('http://localhost:5173/masuk'))).toBe('localhost');
	});

	it('refuses IP literals, workers.dev previews and other loopback names', () => {
		for (const url of [
			'http://127.0.0.1:8787/masuk',
			'https://192.0.2.10/masuk',
			'http://[::1]:8787/masuk',
			'https://[2001:db8::1]/masuk',
			'https://montra.example.workers.dev/masuk',
			'https://abc123-montra.montra.workers.dev/masuk',
			'http://app.localhost/masuk',
			'https://intranet/masuk'
		])
			expect(passkeyRpId(new URL(url)), url).toBeNull();
	});

	it('expects the request origin exactly', () => {
		expect(passkeyOrigin(new URL('https://app.example.com/masuk?x=1'))).toBe(
			'https://app.example.com'
		);
		expect(passkeyOrigin(new URL('http://localhost:5173/masuk'))).toBe('http://localhost:5173');
	});
});

describe('challengeOf', () => {
	const encode = (value: unknown) =>
		base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));

	it('reads the challenge (padding dropped) and refuses anything unreadable', () => {
		expect(challengeOf(encode({ challenge: 'abc==' }))).toBe('abc');
		expect(challengeOf(encode({ challenge: 5 }))).toBeNull();
		expect(challengeOf(encode(null))).toBeNull();
		expect(challengeOf('%%%')).toBeNull();
		expect(challengeOf('')).toBeNull();
		expect(challengeOf('A'.repeat(7000))).toBeNull();
	});
});

describe('userHandle', () => {
	it('is 32 opaque bytes, stable per account and different between accounts', async () => {
		const a = await userHandle('01JUSERA');
		expect(base64urlDecode(a)).toHaveLength(32);
		expect(await userHandle('01JUSERA')).toBe(a);
		expect(await userHandle('01JUSERB')).not.toBe(a);
		expect(a).not.toContain('01JUSERA');
	});
});
