import { afterEach, describe, expect, it, vi } from 'vitest';

// Criterion 22 / Owner decision B: the public /hapus-akun load reads SUPPORT_EMAIL through getEnv()
// (Kit 3 has no event.platform) and must fall back cleanly when it is unset or not a plausible address.
const env: { SUPPORT_EMAIL?: string } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => env }));

const route = await import('../../src/routes/(site)/site/hapus-akun/+page.server');
const { load } = route;
const event = { url: new URL('http://site.localhost:8787/hapus-akun') } as never;
const APP = 'http://localhost:8787';

describe('/hapus-akun load (public, no session)', () => {
	afterEach(() => {
		delete env.SUPPORT_EMAIL;
	});

	it('returns null when SUPPORT_EMAIL is unset (shows "Belum dikonfigurasi")', async () => {
		const result = await load(event);
		expect(result).toEqual({ supportEmail: null, appOrigin: APP });
	});

	it('returns null when SUPPORT_EMAIL is not a plausible address', async () => {
		env.SUPPORT_EMAIL = 'not-an-address';
		const result = await load(event);
		expect(result).toEqual({ supportEmail: null, appOrigin: APP });
	});

	it('returns the trimmed address when SUPPORT_EMAIL is a plausible address', async () => {
		env.SUPPORT_EMAIL = '  hapus@montra.test  ';
		const result = await load(event);
		expect(result).toEqual({ supportEmail: 'hapus@montra.test', appOrigin: APP });
	});

	it('is rendered per request, never prerendered (FN-32: it reads the environment)', () => {
		expect(route.prerender).toBe(false);
	});
});
