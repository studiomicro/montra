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
	it('renders hero, how-it-works, features, security, pricing and FAQ in both languages', () => {
		for (const locale of ['id', 'en'] as const) {
			const body = html(locale);
			for (const id of [
				'hero-title',
				'how-title',
				'features-title',
				'security-title',
				'pricing-title',
				'faq-title'
			])
				expect(body).toContain(`id="${id}"`);
		}
		expect(html('en')).toContain('Frequently asked questions');
	});

	it('names no reference product anywhere', () => {
		for (const locale of ['id', 'en'] as const)
			expect(html(locale)).not.toMatch(new RegExp('oy' + 'en', 'i'));
	});
});
