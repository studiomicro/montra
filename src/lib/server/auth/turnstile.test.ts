import { describe, expect, it, vi } from 'vitest';
import {
	isTurnstileConfigured,
	SITEVERIFY_URL,
	TURNSTILE_TOKEN_MAX_LENGTH,
	turnstileSiteKey,
	turnstileState,
	verifyTurnstile,
	withTurnstileCsp
} from './turnstile';

const ENV = {
	TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
	TURNSTILE_SECRET_KEY: 'secret-not-real'
};
const EXPECTED = { action: 'sign-in' as const, hostname: 'app.example.com' };

const answering = (body: unknown, status = 200) =>
	vi.fn(
		async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
	);

describe('turnstile configuration', () => {
	it('is on only with both values; one value is partial; blanks count as unset', () => {
		expect(isTurnstileConfigured(ENV)).toBe(true);
		expect(isTurnstileConfigured({ TURNSTILE_SITE_KEY: 'x' })).toBe(false);
		expect(isTurnstileConfigured({ TURNSTILE_SECRET_KEY: 'x' })).toBe(false);
		expect(isTurnstileConfigured({ TURNSTILE_SITE_KEY: ' ', TURNSTILE_SECRET_KEY: 'x' })).toBe(
			false
		);
		expect(isTurnstileConfigured(undefined)).toBe(false);
		expect(turnstileState(ENV)).toBe('ok');
		expect(turnstileState({ TURNSTILE_SECRET_KEY: 'x' })).toBe('partial');
		expect(turnstileState({})).toBe('missing');
	});

	it('hands the page the site key only, never the secret', () => {
		expect(turnstileSiteKey(ENV)).toEqual({ siteKey: ENV.TURNSTILE_SITE_KEY });
		expect(JSON.stringify(turnstileSiteKey(ENV))).not.toContain('secret');
		expect(turnstileSiteKey({ TURNSTILE_SECRET_KEY: 'x' })).toBeNull();
	});
});

describe('verifyTurnstile', () => {
	it('accepts success with the expected action and hostname, posting secret, response, remoteip and an idempotency key', async () => {
		const fetchFn = answering({ success: true, action: 'sign-in', hostname: 'app.example.com' });
		const result = await verifyTurnstile(ENV, 'tok-1', EXPECTED, '203.0.113.9', fetchFn);
		expect(result).toEqual({ ok: true });
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(SITEVERIFY_URL);
		const body = new URLSearchParams(init.body as string);
		expect(body.get('secret')).toBe('secret-not-real');
		expect(body.get('response')).toBe('tok-1');
		expect(body.get('remoteip')).toBe('203.0.113.9');
		expect(body.get('idempotency_key')).toMatch(/^[0-9a-f-]{36}$/);
		expect([...body.keys()].sort()).toEqual(['idempotency_key', 'remoteip', 'response', 'secret']);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('refuses a missing or over-length token before any call', async () => {
		const fetchFn = answering({ success: true });
		expect(await verifyTurnstile(ENV, '', EXPECTED, null, fetchFn)).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(
			await verifyTurnstile(
				ENV,
				'a'.repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1),
				EXPECTED,
				null,
				fetchFn
			)
		).toEqual({ ok: false, reason: 'too_long' });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('refuses a wrong action, a wrong hostname, a duplicate and a plain failure', async () => {
		const run = (body: unknown) => verifyTurnstile(ENV, 'tok', EXPECTED, null, answering(body));
		expect(await run({ success: true, action: 'sign-up', hostname: 'app.example.com' })).toEqual({
			ok: false,
			reason: 'action'
		});
		expect(await run({ success: true, action: 'sign-in', hostname: 'evil.example' })).toEqual({
			ok: false,
			reason: 'hostname'
		});
		expect(await run({ success: false, 'error-codes': ['timeout-or-duplicate'] })).toEqual({
			ok: false,
			reason: 'failed'
		});
		expect(await run({ success: 'true' })).toEqual({ ok: false, reason: 'failed' });
		expect(await run(null)).toEqual({ ok: false, reason: 'failed' });
	});

	it('refuses a non-2xx status, non-JSON, a network error and a timeout', async () => {
		expect(
			await verifyTurnstile(ENV, 'tok', EXPECTED, null, answering({ success: true }, 502))
		).toEqual({
			ok: false,
			reason: 'status'
		});
		expect(await verifyTurnstile(ENV, 'tok', EXPECTED, null, answering('<html>'))).toEqual({
			ok: false,
			reason: 'non_json'
		});
		const failing = vi.fn(async () => {
			throw new TypeError('fetch failed');
		});
		expect(await verifyTurnstile(ENV, 'tok', EXPECTED, null, failing)).toEqual({
			ok: false,
			reason: 'network'
		});
		const timingOut = vi.fn(async () => {
			throw new DOMException('aborted', 'TimeoutError');
		});
		expect(await verifyTurnstile(ENV, 'tok', EXPECTED, null, timingOut)).toEqual({
			ok: false,
			reason: 'timeout'
		});
	});
});

describe('withTurnstileCsp', () => {
	it('appends the Turnstile origin to script-src and frame-src and leaves everything else as it was', () => {
		const header =
			"default-src 'self'; script-src 'self' 'nonce-abc'; style-src 'self'; img-src 'self' data:; object-src 'none'";
		expect(withTurnstileCsp(header)).toBe(
			"default-src 'self'; script-src 'self' 'nonce-abc' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'self' https://challenges.cloudflare.com"
		);
	});

	it('is idempotent and extends an existing frame-src', () => {
		const once = withTurnstileCsp("script-src 'self'; frame-src 'none'");
		expect(once).toBe(
			"script-src 'self' https://challenges.cloudflare.com; frame-src 'none' https://challenges.cloudflare.com"
		);
		expect(withTurnstileCsp(once)).toBe(once);
	});
});
