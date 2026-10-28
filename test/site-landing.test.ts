import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';
import { PLAN_CATALOGUE, PLANS } from '#lib/shared/billing/plans';
import { formatMoney } from '#lib/shared/money-format';

const Harness = (await import('./helpers/I18nHarness.svelte')).default;
const Page = (await import('../src/routes/(site)/site/+page.svelte'))
	.default as unknown as Component<Record<string, unknown>>;

const html = (locale: 'id' | 'en' = 'id') =>
	render(Harness, { props: { component: Page, locale, props: {} } }).body;

describe('landing page pricing (FN-32 AC3)', () => {
	it('shows every FN-30 catalogue plan at its catalogue price, never a second copy', () => {
		const body = html();
		for (const plan of PLANS) {
			const entry = PLAN_CATALOGUE[plan];
			const card = body.slice(body.indexOf(`data-testid="site-plan-${plan}"`));
			expect(card).toContain(formatMoney(entry.priceMinor, entry.currency));
		}
	});

	it('badges every price as a placeholder, like /pengaturan/paket, in both languages', () => {
		expect(html().match(/harga sementara/g)).toHaveLength(PLANS.length);
		expect(html('en').match(/price placeholder/g)).toHaveLength(PLANS.length);
	});
});

describe('landing page sections (FN-32 AC1)', () => {
	it('renders hero, module tree, security, pricing and FAQ in both languages', () => {
		for (const locale of ['id', 'en'] as const) {
			const body = html(locale);
			for (const id of ['hero-title', 'eco-title', 'security-title', 'pricing-title', 'faq-title'])
				expect(body).toContain(`id="${id}"`);
		}
		expect(html('en')).toContain('Frequently asked questions');
	});

	it('the module tree: six modules from Koko, only Tanya and Agen marked as not active yet', () => {
		const body = html();
		const ids = [...body.matchAll(/data-testid="site-module-([a-z]+)"/g)].map((m) => m[1]);
		expect(ids).toEqual(['catat', 'lihat', 'atur', 'miliki', 'bagi', 'tanya']);
		expect(body.match(/class="status soon/g)).toHaveLength(1);
		expect(body.match(/class="status live/g)).toHaveLength(5);
		const tanya = body.slice(body.indexOf('data-testid="site-module-tanya"'));
		expect(tanya).toMatch(/class="status soon/);
		// Koko waves from the hub, decorative (its name is in the text beside it).
		expect(body).toMatch(/<svg[^>]*class="mascot pose-wave[^>]*aria-hidden="true"/);
	});

	it('says plainly that the super app moves no money', () => {
		expect(html()).toContain('kami tidak pernah memindahkan uang');
		expect(html('en')).toContain('we never move money');
	});

	it('names no reference product anywhere', () => {
		for (const locale of ['id', 'en'] as const)
			expect(html(locale)).not.toMatch(new RegExp('oy' + 'en', 'i'));
	});
});
