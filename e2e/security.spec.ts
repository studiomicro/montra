import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { APP_ORIGIN } from './helpers';

// The Worker reports the APP_VERSION var, which the release step keeps equal to package.json's version.
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

test('security headers and CSP on an app page', async ({ request }) => {
	const res = await request.get('/');
	const h = res.headers();
	expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(h['content-security-policy']).toContain("object-src 'none'");
	expect(h['content-security-policy']).not.toContain('unsafe-inline');
	expect(h['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
	expect(h['x-content-type-options']).toBe('nosniff');
	expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
	expect(h['cross-origin-opener-policy']).toBe('same-origin');
	expect(h['permissions-policy']).toContain('geolocation=()');
});

test('health reports the database and leaks nothing', async ({ request }) => {
	const res = await request.get('/api/v1/health');
	expect(res.status()).toBe(200);
	expect(await res.json()).toEqual({ ok: true, db: true, version });
});

test('queue ping round trip through the jobs Worker', async ({ request }) => {
	const sent = await request.post('/api/v1/dev/ping', {
		headers: { origin: APP_ORIGIN }
	});
	expect(sent.status()).toBe(200);
	const { id } = (await sent.json()) as { id: string };
	await expect
		.poll(
			async () =>
				((await (await request.get(`/api/v1/dev/ping?id=${id}`)).json()) as { received: boolean })
					.received,
			{
				timeout: 15_000
			}
		)
		.toBe(true);
});
