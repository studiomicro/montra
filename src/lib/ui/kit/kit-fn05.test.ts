import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { stripComments, stripTags } from '../../../../test/helpers/html';
import Chip from './Chip.svelte';
import Segmented from './Segmented.svelte';
import TransactionRow from './TransactionRow.svelte';

const text = (html: string) => stripTags(stripComments(html.replace(/\u00a0/g, ' ')), ' ');

describe('Segmented (native radios: arrow keys, one tab stop, posts without JavaScript)', () => {
	const options = [
		{ value: 'expense', label: 'Pengeluaran' },
		{ value: 'income', label: 'Pemasukan' },
		{ value: 'transfer', label: 'Transfer' }
	];

	it('renders one radio per option under the given form name, the value checked', () => {
		const { body } = render(Segmented, {
			props: { options, value: 'income', label: 'Jenis', name: 'type' }
		});
		const radios = [...body.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
		expect(radios).toHaveLength(3);
		expect(radios.every((r) => r.includes('name="type"'))).toBe(true);
		expect(radios.filter((r) => /\schecked/.test(r))).toHaveLength(1);
		expect(radios.find((r) => /\schecked/.test(r))).toContain('value="income"');
		expect(body).toContain('role="radiogroup"');
		expect(body).toContain('aria-label="Jenis"');
	});

	it('groups its radios under a unique name when none is given', () => {
		const a = render(Segmented, { props: { options, value: 'expense', label: 'A' } }).body;
		const name = a.match(/name="([^"]+)"/)?.[1];
		expect(name).toBeTruthy();
		expect([...a.matchAll(/name="([^"]+)"/g)].every((m) => m[1] === name)).toBe(true);
	});
});

describe('TransactionRow kinds', () => {
	const base = { title: 'x', meta: 'm', category: 'lain' as const, currency: 'IDR' };

	it('infers expense/income from the sign (existing call sites unchanged)', () => {
		expect(
			text(render(TransactionRow, { props: { ...base, amountMinor: -2_500_000 } }).body)
		).toContain('−Rp 25.000');
		const income = render(TransactionRow, { props: { ...base, amountMinor: 950_000_000 } }).body;
		expect(text(income)).toContain('+Rp 9.500.000');
		expect(income).toMatch(/class="amount num[^"]* income"/);
	});

	it('shows a transfer unsigned and uncoloured', () => {
		const body = render(TransactionRow, {
			props: { ...base, amountMinor: 10_000_000, kind: 'transfer' }
		}).body;
		expect(text(body)).toContain('Rp 100.000');
		expect(text(body)).not.toContain('+Rp');
		expect(body).not.toMatch(/class="amount num[^"]* income"/);
	});
});

describe('Chip as a filter link', () => {
	it('renders a link marked aria-current when selected', () => {
		const body = render(Chip, {
			props: {
				href: '/riwayat?type=expense',
				selected: true,
				count: 3,
				children: (() => {}) as never
			}
		}).body;
		expect(body).toMatch(/<a[^>]*href="\/riwayat\?type=expense"/);
		expect(body).toContain('aria-current="true"');
	});
});
