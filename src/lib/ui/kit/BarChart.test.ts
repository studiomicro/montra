import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import BarChart from './BarChart.svelte';

const days = [
	{ label: '6 Okt', minor: 0 },
	{ label: '7 Okt', minor: 1_000_000 },
	{ label: '8 Okt', minor: 2_500_000 }
];
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const buttons = (html: string) =>
	[...html.matchAll(/<rect[^>]*role="button"[^>]*>/g)].map((m) => m[0]);

describe('BarChart touch targets (criterion 28: ≥44×44 px per day)', () => {
	it('gives every day a full-height hit column at least 44 px wide, zero days included', () => {
		const { body } = render(BarChart, { props: { days, label: 'Pengeluaran' } });
		const hits = buttons(body);
		expect(hits).toHaveLength(3);
		for (const hit of hits) {
			expect(Number(attr(hit, 'width'))).toBeGreaterThanOrEqual(44);
			expect(Number(attr(hit, 'height'))).toBeGreaterThanOrEqual(44);
			expect(attr(hit, 'y')).toBe('0');
			expect(attr(hit, 'tabindex')).toBe('0');
		}
		// Columns sit side by side without overlapping.
		const xs = hits.map((h) => Number(attr(h, 'x')));
		expect(xs[1]! - xs[0]!).toBeGreaterThanOrEqual(44);
	});

	it('the visible bar is drawn inside its column and narrower than it', () => {
		const { body } = render(BarChart, { props: { days, label: 'Pengeluaran' } });
		const bars = [...body.matchAll(/<rect[^>]*class="bar[^"]*"[^>]*>/g)].map((m) => m[0]);
		expect(bars).toHaveLength(3);
		const hit = buttons(body)[1]!;
		const bar = bars[1]!;
		expect(Number(attr(bar, 'width'))).toBeLessThan(Number(attr(hit, 'width')));
		expect(Number(attr(bar, 'x'))).toBeGreaterThan(Number(attr(hit, 'x')));
		expect(bar).toMatch(/aria-hidden="true"/);
	});

	it('marks only the selected day as pressed (the last by default), with its label and amount', () => {
		const { body } = render(BarChart, { props: { days, label: 'Pengeluaran' } });
		const hits = buttons(body);
		expect(hits.map((h) => attr(h, 'aria-pressed'))).toEqual(['false', 'false', 'true']);
		expect(attr(hits[2]!, 'aria-label')).toBe('8 Okt: Rp 25.000');
		expect(body).not.toMatch(/\sstyle=/);
	});

	it('formats amounts in the given currency', () => {
		const { body } = render(BarChart, {
			props: { days: [{ label: '8 Oct', minor: 1_250 }], label: 'Spending', currency: 'USD' }
		});
		expect(attr(buttons(body)[0]!, 'aria-label')).toBe('8 Oct: USD 12,50');
	});
});
