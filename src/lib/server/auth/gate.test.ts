import { describe, expect, it } from 'vitest';
import { isAppRoute, isProtectedRoute, signInLocation } from './gate';
import { secureDeployment, sessionCookieName } from './session';

describe('isProtectedRoute', () => {
	it.each(['/(app)', '/(app)/riwayat', '/(app)/pengaturan/akun', '/(app)/tanya'])(
		'%s needs a session',
		(id) => expect(isProtectedRoute(id)).toBe(true)
	);
	it.each([
		null,
		'/(auth)/masuk',
		'/(auth)/daftar',
		'/(auth)/akun-dihapus',
		'/(site)/site',
		'/(site)/site/hapus-akun',
		'/api/v1/health',
		'/(application)/x',
		'/(app)/pengaturan/instal'
	])('%s is public', (id) => expect(isProtectedRoute(id)).toBe(false));
	it.each(['/(app)/pengaturan/instal/x', '/(app)/pengaturan/notifikasi', '/(app)/pengaturan'])(
		'%s still needs a session (the install guide exemption is exact)',
		(id) => expect(isProtectedRoute(id)).toBe(true)
	);
});

describe('signInLocation', () => {
	it('carries the original path and query in next', () => {
		expect(signInLocation(new URL('http://localhost/riwayat?bulan=2026-10'))).toBe(
			'/masuk?next=%2Friwayat%3Fbulan%3D2026-10'
		);
	});
	it('drops SvelteKit data-request params and omits next for /', () => {
		expect(
			signInLocation(new URL('http://localhost/laporan?x-sveltekit-invalidated=01&tahun=2026'))
		).toBe('/masuk?next=%2Flaporan%3Ftahun%3D2026');
		expect(signInLocation(new URL('http://localhost/'))).toBe('/masuk');
	});
});

describe('secure deployment and cookie name', () => {
	it.each(['localhost', 'site.localhost', '127.0.0.1', '[::1]', 'LOCALHOST.'])(
		'%s is local dev',
		(h) => expect(secureDeployment(h)).toBe(false)
	);
	it.each(['montra.app', 'montra-app.example.workers.dev', 'localhost.evil.test'])(
		'%s is a secure deployment',
		(h) => expect(secureDeployment(h)).toBe(true)
	);
	it('prefixes __Host- only when secure', () => {
		expect(sessionCookieName(true)).toBe('__Host-financer_session');
		expect(sessionCookieName(false)).toBe('financer_session');
	});
});

describe('isAppRoute', () => {
	it('is every (app) page, the public install guide included, and nothing else', () => {
		expect(isAppRoute('/(app)')).toBe(true);
		expect(isAppRoute('/(app)/riwayat')).toBe(true);
		expect(isAppRoute('/(app)/pengaturan/instal')).toBe(true);
		expect(isProtectedRoute('/(app)/pengaturan/instal')).toBe(false);
		for (const id of [null, '/(auth)/masuk', '/(site)/site', '/api/v1/health'])
			expect(isAppRoute(id)).toBe(false);
	});
});
