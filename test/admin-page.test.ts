import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';

const Harness = (await import('./helpers/I18nHarness.svelte')).default;
const Page = (await import('../src/routes/pengaturan/integrasi/admin/+page.svelte'))
	.default as unknown as Component<Record<string, unknown>>;

const base = {
	webPush: 'missing',
	turnstile: 'missing',
	connectedApps: { configured: false, previous: false },
	aiKeys: { configured: true, previous: false },
	claimHash: { configured: false, previous: false },
	supportEmail: false,
	aiGateway: false,
	billingMock: { enabled: true, webhookSecret: true },
	appEnv: 'staging',
	keyCount: 2
};
const ROW = {
	id: 'rf-1',
	provider: 'mock',
	reference: 'mock_ref_0123456789abcdef',
	amountMinor: 4_900_000,
	currency: 'IDR',
	reason: 'plan_higher',
	createdAt: Date.parse('2026-10-09T17:30:00Z')
};

const html = (refunds: unknown, locale: 'id' | 'en' = 'id') =>
	render(Harness, {
		props: { component: Page, locale, props: { data: { ...base, refunds } } }
	}).body.replace(/\s+/g, ' ');

describe('/pengaturan/integrasi/admin render (FN-30 hardening criteria 19, 27)', () => {
	it('shows the exact pending count and each row: provider, full reference, amount, reason, WIB date', () => {
		const body = html({
			count: 104,
			rows: [
				ROW,
				{ ...ROW, id: 'rf-2', reason: 'checkout_expired' },
				{ ...ROW, id: 'rf-3', reason: 'unknown' }
			]
		});
		expect(body).toContain('Pengembalian dana menunggu');
		expect(body).toContain('104 pengembalian dana menunggu');
		expect(body).toContain('Menampilkan 3 terbaru');
		expect(body).toContain('mock · mock_ref_0123456789abcdef');
		expect(body).toContain('Rp 49.000');
		expect(body).toContain('Paket lebih tinggi aktif');
		expect(body).toContain('Checkout kedaluwarsa');
		expect(body).toContain('Tidak diketahui');
		expect(body).toMatch(/10 Oktober 2026/);
		expect(html({ count: 1, rows: [ROW] }, 'en')).toContain('Higher plan active');
	});

	it('says "Belum ada" with no pending refund', () => {
		expect(html({ count: 0, rows: [] })).toMatch(/data-testid="refund-count"[^>]*> ?Belum ada/);
	});

	it('a failed refund query shows its error line while the status lines still render', () => {
		const body = html(null);
		expect(body).toContain('Daftar pengembalian dana tidak bisa dimuat. Muat ulang halaman.');
		expect(body).toContain('Rahasia aplikasi');
		expect(body).toContain('CLAIM_HASH_KEY');
		expect(body).toContain('2 pengguna menyimpan kunci Anthropic');
	});

	it('shows CLAIM_HASH_KEY as not configured, and the rotation note while _PREVIOUS is set', () => {
		const body = html({ count: 0, rows: [] });
		expect(body).toMatch(/Penanda klaim ulang.*?Belum dikonfigurasi.*?CLAIM_HASH_KEY/);
		const rotating = render(Harness, {
			props: {
				component: Page,
				locale: 'id',
				props: {
					data: {
						...base,
						claimHash: { configured: true, previous: true },
						refunds: { count: 0, rows: [] }
					}
				}
			}
		}).body.replace(/\s+/g, ' ');
		expect(rotating).toMatch(
			/Penanda klaim ulang.*?Terkonfigurasi.*?CLAIM_HASH_KEY.*?rotasi kunci/
		);
	});
});

describe('/pengaturan/integrasi/admin render: Turnstile row (FN-50 AC 14)', () => {
	const turnstile = (state: string, locale: 'id' | 'en' = 'id') =>
		render(Harness, {
			props: {
				component: Page,
				locale,
				props: { data: { ...base, turnstile: state, refunds: { count: 0, rows: [] } } }
			}
		}).body.replace(/\s+/g, ' ');

	it('shows ok / sebagian / Belum dikonfigurasi with the two names and no value', () => {
		expect(turnstile('missing')).toMatch(
			/Turnstile \(pemeriksaan bot\).*?Belum dikonfigurasi.*?TURNSTILE_SITE_KEY · TURNSTILE_SECRET_KEY/
		);
		const partial = turnstile('partial');
		expect(partial).toMatch(/Turnstile \(pemeriksaan bot\).*?Belum lengkap.*?Baru sebagian diisi/);
		expect(partial).toContain('Baru sebagian diisi: isi keduanya atau kosongkan keduanya.');
		expect(turnstile('ok')).toMatch(/Turnstile \(pemeriksaan bot\).*?Terkonfigurasi/);
		expect(turnstile('ok')).not.toContain('sebagian');
		expect(turnstile('partial', 'en')).toContain('Only partly set: set both or neither.');
	});
});
