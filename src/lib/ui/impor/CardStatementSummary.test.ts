import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { afterEach, describe, expect, it } from 'vitest';
import I18nHarness from '../../../../test/helpers/I18nHarness.svelte';
import { amounts } from '../kit/amounts.svelte';
import CardStatementSummary from './CardStatementSummary.svelte';

function html(props: Record<string, unknown>) {
	return render(I18nHarness, {
		props: {
			component: CardStatementSummary as unknown as Component<Record<string, unknown>>,
			props,
			locale: 'id'
		}
	})
		.body.replace(/<!--[\s\S]*?-->/g, '')
		.replaceAll('\u00a0', ' ');
}

afterEach(() => {
	amounts.hidden = false;
});

const card = {
	statementDate: '2026-10-25',
	dueDate: '2026-11-12',
	previousBalanceMinor: -200000000,
	newBalanceMinor: -132500050,
	minimumPaymentMinor: 10000000,
	limitMinor: 1500000000,
	totals: { payments: 200000000, credits: 0, purchases: 125000050 },
	feesAndInterestMinor: 7512345,
	walletBalanceMinor: -200000000
};

describe('CardStatementSummary (FN-55b, red team L3)', () => {
	it('shows each printed figure and the exact fees + interest sum', () => {
		const out = html({ card, firstStatement: true });
		expect(out).toContain('Rp 1.325.000,50');
		expect(out).toContain('Rp 75.123,45');
		expect(out).toContain('Rp 100.000');
		expect(out).toContain('Saldo dompet kartu sekarang −Rp 2.000.000');
	});
	it('a sum too large to show exactly is named, never rounded', () => {
		expect(
			html({ card: { ...card, feesAndInterestMinor: null }, firstStatement: false })
		).toContain('Total terlalu besar untuk ditampilkan');
	});
	it('hidden amounts mask every figure', () => {
		amounts.hidden = true;
		const out = html({ card, firstStatement: true });
		for (const figure of ['1.325.000', '2.000.000', '75.123', '100.000', '15.000.000', '1.250.000'])
			expect(out).not.toContain(figure);
		expect(out).toContain('••••');
	});
});
