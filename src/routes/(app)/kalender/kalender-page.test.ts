import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import AmountsAtLoadHarness from '../../../../test/helpers/AmountsAtLoadHarness.svelte';
import { stripComments } from '../../../../test/helpers/html';

// FN-54 QA cycle 2 (criterion 7): /kalender is rendered masked from the first server render when the
// `montra-amounts-hidden` cookie is set, like Beranda, Dompet and Laporan. SvelteKit-only imports are stubbed.
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/kalender') },
	navigating: { to: null }
}));
vi.mock('$app/navigation', () => ({ invalidateAll: async () => {} }));

const Page = (await import('./+page.svelte')).default as unknown as Component<
	Record<string, unknown>
>;

const row = {
	id: 't1',
	type: 'expense',
	amountMinor: 2_500_000,
	currency: 'IDR',
	title: 'Kopi susu',
	occurredOn: '2026-10-13',
	occurredAt: 0,
	source: 'manual',
	isDemo: false,
	category: null,
	wallet: { id: 'w', name: 'BCA' },
	toWallet: null,
	adjustmentDirection: null,
	recurringSeriesId: null,
	patungan: null
};
const data = {
	today: '2026-10-13',
	month: '2026-10',
	thisMonth: '2026-10',
	day: '2026-10-13',
	neighbours: { prev: '2026-09', next: '2026-11' },
	spending: {
		currency: 'IDR',
		otherCurrencies: false,
		days: [
			{ date: '2026-10-12', minor: 0, level: 0, future: false },
			{ date: '2026-10-13', minor: 2_500_000, level: 4, future: false },
			{ date: '2026-10-14', minor: 0, level: 0, future: true }
		]
	},
	closedOn: [],
	upcoming: [
		{
			date: '2026-10-14',
			kind: 'subscription',
			id: 's1',
			type: 'expense',
			title: 'Netflix',
			category: null,
			amountMinor: 18_600_000,
			currency: 'IDR',
			walletName: null,
			isDemo: false
		}
	],
	dayRows: {
		group: {
			date: '2026-10-13',
			totals: [{ currency: 'IDR', inMinor: 0, outMinor: 2_500_000 }],
			rows: [row]
		},
		hasMore: false
	}
};
const html = (hidden: boolean, day = '2026-10-13') =>
	stripComments(
		render(AmountsAtLoadHarness, {
			props: { component: Page, hidden, props: { data: { ...data, day } } }
		}).body
	);

describe('/kalender with hidden amounts (cold load)', () => {
	it('the cookie masks the day figure, every cell label, the rows and the due items; dates stay readable', () => {
		const body = html(true);
		expect(body).not.toMatch(/Rp\s?[\d.]/);
		expect(body).toContain('••••');
		expect(body).toMatch(/aria-label="13 Okt: ••••"/);
		expect(body).toMatch(/aria-label="12 Okt: ••••"/);
		expect(body).toContain('Kopi susu');
		expect(html(true, '2026-10-14')).not.toMatch(/Rp\s?[\d.]/);
	});

	it('without the cookie the figures show, and the next request starts shown again', () => {
		html(true);
		expect(html(false)).toMatch(/Rp\s?25\.000/);
	});
});
