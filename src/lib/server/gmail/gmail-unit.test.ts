import { describe, expect, it } from 'vitest';
import { base64urlEncode } from '../../shared/base64url.ts';
import {
	gmailMissing,
	gmailOAuthConfig,
	gmailTesting,
	isGmailConfigured,
	isGmailJobConfigured,
	redirectOrigin
} from './config.ts';
import { openRefreshToken, openVerifier, sealRefreshToken, sealVerifier } from './crypto.ts';
import { GMAIL_SCOPE, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, googleClient } from './google.ts';
import { authorizationUrl, pkceChallenge } from './oauth.ts';

// FN-19 Gmail units: configuration, sealing, the Google client's failure codes and the authorization URL. Google
// is a fake `fetch` here; no test reaches Google.

const KEY_A = base64urlEncode(new Uint8Array(32).fill(7));
const KEY_B = base64urlEncode(new Uint8Array(32).fill(8));
const ENV = {
	GOOGLE_OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com',
	GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-test-secret',
	GOOGLE_OAUTH_REDIRECT_ORIGIN: 'http://localhost:8787',
	CONNECTED_APPS_ENCRYPTION_KEY: KEY_A
};

describe('GOOGLE_OAUTH_REDIRECT_ORIGIN (AC 2)', () => {
	it('accepts exactly one origin', () => {
		expect(redirectOrigin('http://localhost:8787')).toBe('http://localhost:8787');
		expect(redirectOrigin('https://app.example.com')).toBe('https://app.example.com');
		expect(redirectOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
		expect(redirectOrigin(' https://app.example.com ')).toBe('https://app.example.com');
	});

	it('treats a path, trailing slash, http on another host, userinfo, wildcard, query or raw IP as unset', () => {
		for (const bad of [
			undefined,
			'',
			'https://app.example.com/',
			'https://app.example.com/pengaturan',
			'http://app.example.com',
			'https://user:pw@app.example.com',
			'https://*.montra.id',
			'https://app.example.com?x=1',
			'https://app.example.com#x',
			'https://10.0.0.1',
			'https://[::1]',
			'HTTPS://APP.EXAMPLE.COM',
			'javascript:alert(1)',
			'app.example.com'
		])
			expect(redirectOrigin(bad), String(bad)).toBeNull();
	});

	it('names every missing group, and the redirect URI is built from the var only', () => {
		expect(gmailMissing({})).toEqual(['client', 'redirect', 'key']);
		expect(gmailMissing({ ...ENV, CONNECTED_APPS_ENCRYPTION_KEY: 'short' })).toEqual(['key']);
		expect(gmailMissing({ ...ENV, GOOGLE_OAUTH_CLIENT_SECRET: 'has space' })).toEqual(['client']);
		expect(isGmailConfigured(ENV)).toBe(true);
		expect(gmailOAuthConfig(ENV)?.redirectUri).toBe(
			'http://localhost:8787/pengaturan/aplikasi/gmail/callback'
		);
		const { GOOGLE_OAUTH_REDIRECT_ORIGIN: _origin, ...jobEnv } = ENV;
		expect(_origin).toBeDefined();
		expect(isGmailJobConfigured(jobEnv)).toBe(true);
		expect(isGmailJobConfigured({ GOOGLE_OAUTH_CLIENT_ID: 'x' })).toBe(false);
		expect(gmailTesting({})).toBe(true);
		expect(gmailTesting({ GOOGLE_OAUTH_TESTING: '0' })).toBe(false);
	});
});

describe('sealing the refresh token (AC 13)', () => {
	const b = { connectionId: 'c1', userId: 'u1' };

	it('round-trips and fails closed on a wrong key, tampering, another row or user, and no key', async () => {
		const sealed = (await sealRefreshToken(ENV, '1//refresh-token', b))!;
		expect(sealed.ciphertext).not.toContain('refresh');
		expect(await openRefreshToken(ENV, sealed, b)).toBe('1//refresh-token');
		expect(await openRefreshToken({ CONNECTED_APPS_ENCRYPTION_KEY: KEY_B }, sealed, b)).toBeNull();
		const flipped =
			sealed.ciphertext.slice(0, -2) + (sealed.ciphertext.endsWith('A') ? 'BA' : 'AA');
		expect(await openRefreshToken(ENV, { ...sealed, ciphertext: flipped }, b)).toBeNull();
		expect(await openRefreshToken(ENV, sealed, { ...b, connectionId: 'c2' })).toBeNull();
		expect(await openRefreshToken(ENV, sealed, { ...b, userId: 'u2' })).toBeNull();
		expect(await openRefreshToken({}, sealed, b)).toBeNull();
		expect(await openRefreshToken(ENV, { ...sealed, nonce: '!!' }, b)).toBeNull();
		expect(await sealRefreshToken({}, 'x', b)).toBeNull();
	});

	it('rotation: sealed under A opens with A as _PREVIOUS; new seals use B', async () => {
		const underA = (await sealRefreshToken(ENV, 'tok-a', b))!;
		const rotated = {
			CONNECTED_APPS_ENCRYPTION_KEY: KEY_B,
			CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS: KEY_A
		};
		expect(await openRefreshToken(rotated, underA, b)).toBe('tok-a');
		const underB = (await sealRefreshToken(rotated, 'tok-b', b))!;
		expect(underB.keyId).not.toBe(underA.keyId);
		expect(await openRefreshToken({ CONNECTED_APPS_ENCRYPTION_KEY: KEY_B }, underB, b)).toBe(
			'tok-b'
		);
	});

	it('a Gmail ciphertext never opens as a verifier (own labels) and the verifier is bound to its state', async () => {
		const token = (await sealRefreshToken(ENV, 'abc', b))!;
		expect(await openVerifier(ENV, token, 'c1')).toBeNull();
		const v = (await sealVerifier(ENV, 'v'.repeat(64), 'h1'))!;
		expect(await openVerifier(ENV, v, 'h1')).toBe('v'.repeat(64));
		expect(await openVerifier(ENV, v, 'h2')).toBeNull();
	});
});

describe('authorization URL (AC 5)', () => {
	it('has exactly the documented parameters and an S256 challenge of the verifier', async () => {
		const cfg = gmailOAuthConfig(ENV)!;
		const verifier = 'a'.repeat(64);
		const url = new URL(authorizationUrl(cfg, 'S'.repeat(43), await pkceChallenge(verifier)));
		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect([...url.searchParams.keys()].sort()).toEqual(
			[
				'access_type',
				'client_id',
				'code_challenge',
				'code_challenge_method',
				'prompt',
				'redirect_uri',
				'response_type',
				'scope',
				'state'
			].sort()
		);
		expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPE);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
		expect(url.searchParams.get('code_challenge')).toBe(base64urlEncode(digest));
		expect(url.toString()).not.toContain(verifier);
	});
});

describe('googleClient failure codes', () => {
	const respond =
		(status: number, body: unknown, seen?: RequestInit[]) =>
		async (_url: RequestInfo | URL, init?: RequestInit) => {
			seen?.push(init ?? {});
			return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
		};

	it('maps Gmail API answers: 401 auth, 429 and 403 rate reasons rate, other 403 forbidden, 404 gone, 5xx server', async () => {
		const cases: [number, unknown, string][] = [
			[401, {}, 'auth'],
			[429, {}, 'rate'],
			[403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 'rate'],
			[403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 'rate'],
			[403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }, 'forbidden'],
			[404, {}, 'gone'],
			[503, {}, 'server'],
			[302, '', 'forbidden']
		];
		for (const [status, body, error] of cases) {
			const r = await googleClient(respond(status, body)).get('token', 'm1');
			expect(r, `${status}`).toEqual({ ok: false, error });
		}
		const network = googleClient(async () => {
			throw new TypeError('network');
		});
		expect(await network.get('t', 'm1')).toEqual({ ok: false, error: 'server' });
	});

	it('never follows a redirect, caps the body and refuses a malformed id without calling', async () => {
		const seen: RequestInit[] = [];
		await googleClient(respond(200, {}, seen)).get('t', 'm1');
		expect(seen[0]?.redirect).toBe('manual');
		const huge = googleClient(async () => new Response('x'.repeat(2 * 1024 * 1024 + 10)));
		expect(await huge.get('t', 'm1')).toEqual({ ok: false, error: 'too_large' });
		let called = false;
		const r = await googleClient(async () => {
			called = true;
			return new Response('{}');
		}).get('t', '../users');
		expect(r).toEqual({ ok: false, error: 'malformed' });
		expect(called).toBe(false);
	});

	it('token endpoint: invalid_grant is its own code; the secret and verifier travel in the body only', async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const client = googleClient(async (url, init) => {
			seen.push({ url: String(url), init: init ?? {} });
			return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
		});
		expect(
			await client.refresh({ clientId: 'id', clientSecret: 'sec', refreshToken: 'rt' })
		).toEqual({ ok: false, error: 'invalid_grant' });
		await client.exchangeCode({
			clientId: 'id',
			clientSecret: 'sec',
			code: 'c',
			verifier: 'v',
			redirectUri: 'http://localhost:8787/pengaturan/aplikasi/gmail/callback'
		});
		for (const s of seen) {
			expect(s.url).toBe(GOOGLE_TOKEN_URL);
			expect(s.url).not.toContain('sec');
		}
		const body = new URLSearchParams(String(seen[1]?.init.body));
		expect(body.get('code_verifier')).toBe('v');
		expect(body.get('client_secret')).toBe('sec');
		expect(body.get('grant_type')).toBe('authorization_code');
	});

	it('revoke: 200 and 400 invalid_token count as revoked; 5xx or network do not', async () => {
		const urls: string[] = [];
		const ok = googleClient(async (url) => {
			urls.push(String(url));
			return new Response('{}', { status: 200 });
		});
		expect(await ok.revoke('rt')).toBe(true);
		expect(urls).toEqual([GOOGLE_REVOKE_URL]);
		expect(await googleClient(respond(400, { error: 'invalid_token' })).revoke('rt')).toBe(true);
		expect(await googleClient(respond(400, { error: 'other' })).revoke('rt')).toBe(false);
		expect(await googleClient(respond(503, {})).revoke('rt')).toBe(false);
	});
});
