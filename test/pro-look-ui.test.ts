import { readFileSync } from 'node:fs';
import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Plan } from '#lib/shared/billing/plans';

// FN-46 Parts 1, 2 and 4: where the Pro look shows, server-rendered from the plan the layout passes (`shell.plan`,
// from hooks.server.ts's planOf) — and never on Gratis. SvelteKit-only imports are stubbed for a plain render.
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/pengaturan'), data: {} },
	navigating: { to: null }
}));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ invalidateAll: async () => {}, goto: async () => {} }));

const Harness = (await import('./helpers/I18nHarness.svelte')).default;
type Any = Component<Record<string, unknown>>;
const load = async (path: string) => (await import(path)).default as unknown as Any;
const Sidebar = await load('../src/lib/ui/shell/Sidebar.svelte');
const Pengaturan = await load('../src/routes/(app)/pengaturan/+page.svelte');
const Akun = await load('../src/routes/(app)/pengaturan/akun/+page.svelte');
const Tampilan = await load('../src/routes/(app)/pengaturan/tampilan/+page.svelte');
const Instal = await load('../src/routes/(app)/pengaturan/instal/+page.svelte');
const HeroAmount = await load('../src/lib/ui/kit/HeroAmount.svelte');
const ProBadge = await load('../src/lib/ui/kit/ProBadge.svelte');

const html = (component: Any, props: Record<string, unknown>, locale: 'id' | 'en' = 'id') =>
	render(Harness, { props: { component, locale, props } }).body;
const badges = (body: string) => (body.match(/data-testid="pro-badge"/g) ?? []).length;

const shell = (plan: Plan) => ({
	space: { name: 'Pribadi', kind: 'personal', role: 'owner' },
	account: { name: 'Sari Wulandari', email: 'sari@contoh.id' },
	plan
});
const PAID = ['pro', 'agen'] as const;

/** Each surface the badge sits on, rendered for `plan`. */
const SURFACES: [string, (plan: Plan) => string][] = [
	['sidebar', (plan) => html(Sidebar, { onadd: () => {}, shell: shell(plan) })],
	['pengaturan', (plan) => html(Pengaturan, { data: { shell: shell(plan) } })],
	[
		'pengaturan/akun',
		(plan) =>
			html(Akun, {
				data: {
					shell: shell(plan),
					account: {
						name: 'Sari Wulandari',
						email: 'sari@contoh.id',
						createdAt: 1_790_000_000_000
					},
					accountKey: { exists: false, stale: false }
				},
				form: null
			})
	]
];

describe('Sidebar plan card', () => {
	it('offers "Punya voucher?" on Gratis only; a paid plan never sees the voucher upsell', () => {
		const sidebar = (plan: Plan) => html(Sidebar, { onadd: () => {}, shell: shell(plan) });
		expect(sidebar('gratis')).toContain('Punya voucher?');
		for (const plan of PAID) expect(sidebar(plan)).not.toContain('Punya voucher?');
	});
});

describe('ProBadge', () => {
	it('is Montra’s own crown (pixels, no image or colour in the markup) and the word Pro', () => {
		const body = html(ProBadge, {});
		expect(body).toContain('>Pro<');
		expect(body.match(/<rect /g)?.length).toBeGreaterThan(10);
		expect(body).not.toMatch(/<image|href=|#[0-9a-f]{3,8}\b|\sfill=/i);
		expect(body).toMatch(/<svg[^>]*aria-hidden="true"/);
	});
});

describe.each(SURFACES)('Pro badge on %s (AC 1, 2, 4, 5)', (_name, surface) => {
	it.each(PAID)('%s: the badge beside the account name', (plan) => {
		const body = surface(plan);
		expect(badges(body)).toBe(1);
		const name = body.indexOf('Sari Wulandari');
		expect(name).toBeGreaterThan(-1);
		expect(Math.abs(body.indexOf('data-testid="pro-badge"') - name)).toBeLessThan(400);
	});

	it('Gratis (never paid, or lapsed: the plan in force is Gratis either way): no badge', () => {
		expect(badges(surface('gratis'))).toBe(0);
	});

	it('Agen renders exactly what Pro renders', () => {
		expect(surface('agen')).toBe(surface('pro'));
	});
});

describe('Pengaturan shows who is signed in (FN-46 Part 1)', () => {
	it('the initials tile and the name, the e-mail kept as the subtitle', () => {
		const body = html(Pengaturan, { data: { shell: shell('gratis') } });
		expect(body).toContain('data-testid="settings-account"');
		expect(body).toMatch(/class="tile[^"]*"[^>]*>SW</);
		expect(body).toContain('sari@contoh.id');
	});
});

describe('Pengaturan › Tampilan (FN-46 Part 2, AC 6)', () => {
	const page = (plan: Plan, locale: 'id' | 'en' = 'id') =>
		html(Tampilan, { data: { shell: shell(plan), theme: 'system' }, form: null }, locale);

	it('Gratis: Emas and Hijau tua are locked links to Paket, never radios', () => {
		const body = page('gratis');
		for (const value of ['gold', 'emerald']) {
			expect(body).toContain(`data-testid="locked-${value}"`);
			expect(body).not.toContain(`value="${value}"`);
		}
		expect(body.match(/href="\/pengaturan\/paket"/g)).toHaveLength(2);
		expect(body.match(/Perlu paket Pro atau Agen/g)).toHaveLength(2);
		expect(body).toContain('Emas');
		expect(body).toContain('Hijau tua');
		// The four free choices stay radios.
		for (const value of ['system', 'light', 'dark', 'mono'])
			expect(body).toContain(`value="${value}"`);
		const en = page('gratis', 'en');
		expect(en).toContain('Gold');
		expect(en).toContain('Deep green');
		expect(en).toContain('Needs the Pro or Agent plan');
	});

	it.each(PAID)('%s: both Pro themes are radios like the others, no lock', (plan) => {
		const body = page(plan);
		expect(body).toContain('value="gold"');
		expect(body).toContain('value="emerald"');
		expect(body).not.toContain('data-testid="locked-');
		expect(body).not.toContain('Perlu paket Pro atau Agen');
	});
});

describe('Pengaturan › Pasang aplikasi (FN-46 Part 3, AC 15)', () => {
	const page = (plan: Plan, locale: 'id' | 'en' = 'id') =>
		html(
			Instal,
			{ data: { shell: shell(plan), inAppBrowser: null, iosBrowser: null, guideUrl: null } },
			locale
		);

	it.each(PAID)('%s: says the Pro icon comes with a reinstall, never a silent swap', (plan) => {
		expect(page(plan)).toContain(
			'Ikon Pro terlihat saat kamu memasang ulang aplikasi dari layar utama.'
		);
		expect(page(plan, 'en')).toContain(
			'The Pro icon shows the next time you reinstall the app from your home screen.'
		);
	});

	it('Gratis: no notice', () => {
		expect(page('gratis')).not.toContain('data-testid="pro-icon-note"');
	});
});

describe('Beranda’s hero frame (FN-46 Part 4, AC 18, 19, 22)', () => {
	const hero = (pro?: boolean) =>
		html(HeroAmount, { label: 'Pengeluaran Oktober', amountMinor: 1_264_000_00, pro });

	it('pro adds only the frame class: label, figure and context are the same markup', () => {
		const plain = hero(false);
		const framed = hero(true);
		expect(framed).toMatch(/<section class="hero[^"]*\bpro\b/);
		expect(plain).not.toMatch(/<section class="hero[^"]*\bpro\b/);
		expect(hero()).toBe(plain);
		const strip = (body: string) =>
			body.replace(/<section class="hero[^"]*"/, '<section').replace(/ svelte-[\w-]+/g, '');
		expect(strip(framed)).toBe(strip(plain));
	});

	it('the frame is a background only (no figure size, colour or layout change) and blur-free', () => {
		const css = readFileSync('src/lib/ui/kit/HeroAmount.svelte', 'utf8');
		const rule = /\.hero\.pro \{([^}]*)\}/.exec(css)?.[1] ?? '';
		const props = [...rule.matchAll(/^\s*([\w-]+):/gm)].map((m) => m[1]);
		expect(props.sort()).toEqual(['background', 'border', 'border-radius', 'padding']);
		expect(rule).toContain('var(--pro-soft)');
		expect(rule).not.toMatch(/blur|#[0-9a-f]{3,8}\b/i);
		expect(css).not.toMatch(/\.pro[^{]*\.figure|\.pro[^{]*\.cur/);
	});

	it('Beranda passes the plan’s flag, never a property of the rows it shows (demo or not)', () => {
		const src = readFileSync('src/routes/(app)/+page.svelte', 'utf8');
		const call = src.slice(src.indexOf('<HeroAmount'), src.indexOf('>', src.indexOf('pro=')));
		expect(call).toContain('pro={hasProLook(data.shell.plan)}');
		expect(call).not.toMatch(/isDemo|demo/i);
	});
});
