import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { afterEach, describe, expect, it } from 'vitest';
import { allocationOf } from '#lib/shared/wealth';
import I18nHarness from '../../../../test/helpers/I18nHarness.svelte';
import { HIDDEN_AMOUNT } from '../kit/amount-visibility';
import { amounts } from '../kit/amounts.svelte';
import AllocationBar from './AllocationBar.svelte';
import CreditCardCard from './CreditCardCard.svelte';
import MissingSuggestions from './MissingSuggestions.svelte';
import PeriodTrend from './PeriodTrend.svelte';
import TrendChart from './TrendChart.svelte';

// FN-25b components, server-rendered: what each one shows, and that every figure follows the eye button.
function html(component: unknown, props: Record<string, unknown>, locale: 'id' | 'en' = 'id') {
	return render(I18nHarness, {
		props: { component: component as Component<Record<string, unknown>>, props, locale }
	})
		.body.replace(/<!--[\s\S]*?-->/g, '')
		.replaceAll(' ', ' ');
}

afterEach(() => {
	amounts.hidden = false;
});

const allocation = allocationOf([
	{ cls: 'wallets', minor: 21_621_500_00 },
	{ cls: 'property', minor: 18_500_000_00 },
	{ cls: 'debt', minor: -250_000_000_00 }
]);

describe('AllocationBar', () => {
	it('draws a segment per asset class only; the debt is its own minus line', () => {
		const body = html(AllocationBar, { allocation });
		expect(body.match(/<rect /g)).toHaveLength(2);
		expect(body).toMatch(/<rect [^>]*class="c-wallets/);
		expect(body).not.toContain('c-debt');
		expect(body).toContain('Rp21,6 jt · 54%');
		expect(body).toContain('Rp18,5 jt · 46%');
		expect(body).toMatch(/Utang<\/span>\s*<span class="num[^"]*">−Rp 250.000.000<\/span>/);
		// Plain debt is ink with its minus sign, never red (red means "more than" or an error).
		expect(body).not.toContain('minus');
	});

	it('masks every figure, share and segment width while amounts are hidden (owner decision 2026-10-13)', () => {
		amounts.hidden = true;
		const body = html(AllocationBar, { allocation });
		expect(body).not.toContain('Rp');
		expect(body).not.toContain('%');
		expect(body).toContain(`${HIDDEN_AMOUNT} · ${HIDDEN_AMOUNT}`);
		// One plain segment: the split between classes is not drawn.
		expect(body.match(/<rect /g)).toHaveLength(1);
		expect(body).not.toMatch(/class="c-(wallets|property)/);
	});
});

const points = [
	{ date: '2026-09-12', totalMinor: 44_000_000_00, partial: false },
	{ date: '2026-09-20', totalMinor: 43_000_000_00, partial: true },
	{ date: '2026-10-11', totalMinor: 49_304_398_00, partial: false }
];

describe('TrendChart', () => {
	it('plots the stored points, marks a partial day and labels the first and last date', () => {
		const body = html(TrendChart, { points, label: 'Perjalanan' });
		expect(body.match(/data-partial="1"/g)).toHaveLength(1);
		expect(body).toContain('<span>12 Sep</span><span>11 Okt</span>');
		// The read-out starts on the last day.
		expect(body).toContain('Rp 49.304.398');
		// Up over the range: the money-in colour (no "down" class).
		expect(body).not.toMatch(/class="trend[^"]*down/);
	});

	it('a falling range takes the down colour', () => {
		const body = html(TrendChart, { points: [...points].reverse(), label: 'Perjalanan' });
		expect(body).toMatch(/class="trend[^"]*down/);
	});

	it('while hidden: no line, area, dots or rising/falling colour; the read-out masks (owner decision 2026-10-13)', () => {
		amounts.hidden = true;
		const body = html(TrendChart, { points: [...points].reverse(), label: 'Perjalanan' });
		expect(body).toContain(HIDDEN_AMOUNT);
		expect(body).not.toContain('Rp ');
		expect(body).not.toContain('<polyline');
		expect(body).not.toContain('class="area');
		expect(body).not.toContain('data-partial');
		expect(body).not.toMatch(/class="trend[^"]*down/);
	});
});

describe('MissingSuggestions', () => {
	it('links each card to the pre-filled form (works without JavaScript); nothing for an empty list', () => {
		const body = html(MissingSuggestions, { suggestions: ['gold', 'pension'], onpick: () => {} });
		expect(body).toContain('href="/kekayaan?aset=baru&amp;saran=emas"');
		expect(body).toContain('href="/kekayaan?aset=baru&amp;saran=pensiun"');
		expect(body).toContain('Belum dihitung');
		// The hide button needs JavaScript, so the server render has none.
		expect(body).not.toContain('Sembunyikan saran');
		expect(html(MissingSuggestions, { suggestions: [], onpick: () => {} })).toBe('');
		expect(html(MissingSuggestions, { suggestions: ['gold'], onpick: () => {} }, 'en')).toContain(
			'Not counted yet'
		);
	});
});

describe('CreditCardCard', () => {
	const card = {
		walletId: 'w1',
		name: 'Visa',
		lastFour: '4242',
		currency: 'IDR',
		from: '2026-09-12',
		to: '2026-10-11',
		totals: [{ currency: 'IDR', outMinor: 2_330_000_00 }]
	};
	it('shows the 30-day spend and links to the same Riwayat list', () => {
		const body = html(CreditCardCard, { card });
		expect(body).toContain('Rp 2.330.000');
		expect(body).toContain('•••• 4242');
		expect(body).toContain(
			'href="/riwayat?type=expense&amp;period=range&amp;from=2026-09-12&amp;to=2026-10-11&amp;wallet=w1"'
		);
	});
	it('nothing spent reads Rp 0 in the card currency; hidden amounts mask it', () => {
		expect(html(CreditCardCard, { card: { ...card, totals: [] } })).toContain('Rp 0');
		amounts.hidden = true;
		expect(html(CreditCardCard, { card })).not.toContain('Rp 2.330.000');
	});
});

describe('PeriodTrend', () => {
	const axis = (body: string) =>
		[...body.matchAll(/<p class="axis[^>]*>([\s\S]*?)<\/p>/g)][0]![1]!
			.replace(/<[^>]+>/g, ' ')
			.trim()
			.split(/\s{2,}/);
	const month = { key: '2026-10', date: '2026-10-15', minor: 15 * 100_000_000, partial: false };

	it('names an opening from before the period "Awal"', () => {
		const opening = { key: 'awal', date: '2026-09-30', minor: 100_000_000, partial: false };
		expect(axis(html(PeriodTrend, { points: [opening, month], label: 'x' }))[0]).toBe('Awal');
	});

	it('names an opening taken inside the period by its date, never "Awal"', () => {
		const since = { key: 'awal', date: '2026-10-11', minor: 100_000_000, partial: false };
		const labels = axis(html(PeriodTrend, { points: [since, month], label: 'x' }));
		expect(labels[0]).not.toBe('Awal');
		expect(labels[0]).toMatch(/11/);
	});

	it('says why the plot is empty below two recorded values, and keeps the steppable slots', () => {
		const lone = html(PeriodTrend, {
			points: [{ key: 'awal', date: null, minor: null, partial: false }, month],
			label: 'x'
		});
		expect(lone).toContain('role="slider"');
		expect(lone).toContain('Grafik tampil setelah beberapa hari pencatatan.');
		const opening = { key: 'awal', date: '2026-09-30', minor: 100_000_000, partial: false };
		expect(html(PeriodTrend, { points: [opening, month], label: 'x' })).not.toContain(
			'Grafik tampil setelah beberapa hari pencatatan.'
		);
	});
});
