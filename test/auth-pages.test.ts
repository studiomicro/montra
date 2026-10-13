import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Component } from 'svelte';

/**
 * FN-50 server render of /masuk and /daftar (AC 1, 3, 13, 35): the Turnstile script, container and <noscript>
 * line appear only while the page has a site key; nothing passkey-related is in the server HTML (the button
 * is drawn only once JavaScript runs and finds `PublicKeyCredential`).
 */

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/masuk') } }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }), deserialize: JSON.parse }));
vi.mock('$app/navigation', () => ({ goto: async () => {}, invalidateAll: async () => {} }));

const Harness = (await import('./helpers/I18nHarness.svelte')).default;
const Masuk = (await import('../src/routes/(auth)/masuk/+page.svelte'))
	.default as unknown as Component<Record<string, unknown>>;
const Daftar = (await import('../src/routes/(auth)/daftar/+page.svelte'))
	.default as unknown as Component<Record<string, unknown>>;

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const page = (
	component: Component<Record<string, unknown>>,
	data: Record<string, unknown>,
	locale: 'id' | 'en' = 'id'
) => {
	const out = render(Harness, { props: { component, locale, props: { data, form: null } } });
	return { head: out.head, body: out.body.replace(/\s+/g, ' ') };
};

describe('/masuk and /daftar server HTML', () => {
	it('has no widget, script or <noscript> line while Turnstile is off', () => {
		for (const [component, data] of [
			[Masuk, { turnstile: null, passkeyHost: true }],
			[Daftar, { turnstile: null, siteOrigin: 'http://localhost' }]
		] as const) {
			const { head, body } = page(component, data);
			expect(head).not.toContain('challenges.cloudflare.com');
			expect(body).not.toContain('data-testid="turnstile"');
			expect(body).not.toContain('<noscript');
		}
	});

	it('renders the widget container, its action, the script and the <noscript> line while on', () => {
		const signIn = page(Masuk, { turnstile: { siteKey: 'site-key-public' }, passkeyHost: true });
		expect(signIn.head).toContain(
			`src="${SCRIPT}?render=explicit&amp;onload=onloadTurnstileCallback"`
		);
		// The container sits inside the sign-in form, so the widget's hidden field posts with it.
		expect(signIn.body).toMatch(/<form[^>]*class="form[^"]*".*data-action="sign-in".*<\/form>/);
		expect(signIn.body).toContain(
			'Verifikasi keamanan membutuhkan JavaScript. Aktifkan JavaScript lalu muat ulang.'
		);
		const signUp = page(Daftar, {
			turnstile: { siteKey: 'site-key-public' },
			siteOrigin: 'http://localhost'
		});
		expect(signUp.head).toContain(SCRIPT);
		expect(signUp.body).toContain('data-action="sign-up"');
		const english = page(Masuk, { turnstile: { siteKey: 'k' }, passkeyHost: true }, 'en');
		expect(english.body).toContain(
			'The security check needs JavaScript. Enable JavaScript and reload.'
		);
	});

	it('draws no passkey button and keeps the plain e-mail autocomplete without JavaScript', () => {
		const { body } = page(Masuk, { turnstile: null, passkeyHost: true });
		expect(body).not.toContain('passkey');
		expect(body).toContain('autocomplete="email"');
		expect(body).toMatch(/<form method="POST"[^>]*>/);
	});
});
