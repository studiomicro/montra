import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { moneyParts } from '#lib/shared/money-format';
import AmountsAtLoadHarness from '../../../../test/helpers/AmountsAtLoadHarness.svelte';
import FigureBeforeHero from '../../../../test/helpers/FigureBeforeHero.svelte';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import I18nHarness from '../../../../test/helpers/I18nHarness.svelte';
import { HIDDEN_AMOUNT } from './amount-visibility';
import { amounts } from './amounts.svelte';
import HeroAmount from './HeroAmount.svelte';

describe('HeroAmount first paint', () => {
	it('server-renders the exact figure (the count only runs after a change on the page)', () => {
		const body = render(I18nHarness, {
			props: {
				component: HeroAmount as unknown as Component<Record<string, unknown>>,
				props: { label: 'Pengeluaran Oktober', amountMinor: 98_750_050, hideToggle: false }
			}
		}).body;
		const { figure } = moneyParts(98_750_050, 'IDR', 'id');
		expect(body.replace(/<!--[\s\S]*?-->/g, '')).toContain(`</span>${figure}</p>`);
	});
});

// FN-53 QA low: a signed change reads "−Rp 124.900.000" / "+Rp …" (sign before the symbol, U+2212), and while
// amounts are hidden the sign is not shown either (red team L2: no direction).
describe('HeroAmount signed', () => {
	const signed = (minor: number, hidden: boolean) =>
		render(AmountsAtLoadHarness, {
			props: {
				component: HeroAmount as unknown as Component<Record<string, unknown>>,
				hidden,
				props: { label: 'Perubahan', amountMinor: minor, signed: true }
			}
		})
			.body.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/<[^>]+>/g, '');
	it('puts the sign before the symbol', () => {
		expect(signed(-12_490_000_000, false)).toContain('\u2212Rp124.900.000');
		expect(signed(2_500_000_000, false)).toContain('+Rp25.000.000');
		expect(signed(-12_490_000_000, false)).not.toContain('Rp\u2212');
	});
	it('hides the sign with the figure', () => {
		const body = signed(-12_490_000_000, true);
		expect(body).toContain(`Rp${HIDDEN_AMOUNT}`);
		expect(body).not.toMatch(/[\u2212+]Rp/);
	});
});

// FN-25b red team 1: with the eye closed, the server render is already masked (no flash before hydration), and
// the next request starts shown again.
describe('HeroAmount with hidden amounts', () => {
	const hero = (hidden: boolean, hideToggle = true) =>
		render(AmountsAtLoadHarness, {
			props: {
				component: HeroAmount as unknown as Component<Record<string, unknown>>,
				hidden,
				props: { label: 'Kekayaan bersih', amountMinor: 98_750_050, hideToggle }
			}
		}).body.replace(/<!--[\s\S]*?-->/g, '');
	const { figure } = moneyParts(98_750_050, 'IDR', 'id');

	it('renders the mask, never the figure, when the cookie says hidden', () => {
		const body = hero(true);
		expect(body).toContain(HIDDEN_AMOUNT);
		expect(body).not.toContain(figure);
	});

	it('a later render without the cookie (or without the eye button) shows the figure', () => {
		hero(true);
		expect(hero(false)).toContain(figure);
		hero(true);
		expect(hero(true, false)).toContain(figure);
		expect(amounts.hidden).toBe(false);
	});
});

// Red team N5 (cycle 2): the mask does not depend on where the hero sits in the page.
describe('hidden amounts before the hero', () => {
	it('a page that applies the cookie choice first masks figures before any hero, plain consts included', () => {
		const body = render(AmountsAtLoadHarness, {
			props: {
				component: FigureBeforeHero as unknown as Component<Record<string, unknown>>,
				hidden: true,
				props: {}
			}
		}).body;
		expect(body).not.toContain('9.999');
		expect(body).not.toContain('6.666');
	});

	it('every route page with a HeroAmount or NetWorthSection applies the choice in its script', () => {
		const files = execFileSync('grep', [
			'-rl',
			'-e',
			'<HeroAmount',
			'-e',
			'<NetWorthSection',
			'src/routes'
		])
			.toString()
			.trim()
			.split('\n');
		expect(files.length).toBeGreaterThan(0);
		for (const f of files)
			expect(readFileSync(f, 'utf8'), f).toContain('applyAmountsHiddenAtLoad();');
	});
});
