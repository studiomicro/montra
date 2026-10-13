import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Harness from '../../../../test/helpers/I18nHarness.svelte';
import AmountInput from './AmountInput.svelte';

const input = (body: string) => body.match(/<input[^>]*>/)?.[0] ?? '';

describe('AmountInput (server render)', () => {
	it('renders a pre-filled value grouped, so a form without JavaScript shows it', () => {
		const { body } = render(AmountInput, {
			props: { label: 'Saldo awal', valueMinor: 125_000_000, name: 'openingBalance' }
		});
		expect(input(body)).toContain('value="1.250.000"');
		expect(input(body)).toContain('name="openingBalance"');
		expect(body).toContain('>Rp<');
	});

	it('uses the currency’s symbol and exponent', () => {
		const { body } = render(AmountInput, {
			props: { label: 'Saldo awal', valueMinor: 1500, currency: 'JPY' }
		});
		expect(input(body)).toContain('value="1.500"');
		expect(body).toContain('>JPY<');
	});

	it('leaves an empty field without a name when none is given', () => {
		const { body } = render(AmountInput, { props: { label: 'Jumlah' } });
		expect(input(body)).toContain('value=""');
		expect(input(body)).not.toContain('name=');
	});
});

describe('AmountInput FN-47: cents for every currency but IDR and JPY (server render)', () => {
	const inLocale = (locale: 'id' | 'en', props: Record<string, unknown>) =>
		render(Harness, {
			props: {
				component: AmountInput as unknown as Component<Record<string, unknown>>,
				locale,
				props: { label: 'Saldo awal', name: 'openingBalance', ...props }
			}
		}).body;

	it('pre-fills a stored USD amount with its cents in the UI language, with a decimal keypad and hint', () => {
		const id = inLocale('id', { valueMinor: 125_050, currency: 'USD' });
		expect(input(id)).toContain('value="1.250,50"');
		expect(input(id)).toContain('inputmode="decimal"');
		expect(id).toContain('Pakai koma untuk sen: 12,50');
		const en = inLocale('en', { valueMinor: 125_050, currency: 'USD' });
		expect(input(en)).toContain('value="1,250.50"');
		expect(en).toContain('Use a dot for cents: 12.50');
		expect(input(inLocale('id', { valueMinor: 1_250_000, currency: 'TWD' }))).toContain(
			'value="12.500"'
		);
	});

	it('IDR and JPY keep the numeric keypad, dot grouping and no hint in both languages', () => {
		for (const locale of ['id', 'en'] as const) {
			const idr = inLocale(locale, { valueMinor: 125_000_000, currency: 'IDR' });
			expect(input(idr)).toContain('value="1.250.000"');
			expect(input(idr)).toContain('inputmode="numeric"');
			expect(idr).not.toContain('sen');
			expect(idr).not.toContain('cents');
			expect(input(inLocale(locale, { valueMinor: 1500, currency: 'JPY' }))).toContain(
				'value="1.500"'
			);
		}
	});
});

describe('AmountInput QA FN-47 #3: a refused submit echoes what was typed', () => {
	const inLocale = (locale: 'id' | 'en', props: Record<string, unknown>) =>
		render(Harness, {
			props: {
				component: AmountInput as unknown as Component<Record<string, unknown>>,
				locale,
				props: { label: 'Saldo awal', name: 'openingBalance', ...props }
			}
		}).body;

	it('shows `typed` verbatim, never a cut reading of it', () => {
		const id = inLocale('id', { valueMinor: 1234, currency: 'USD', typed: '12,345' });
		expect(input(id)).toContain('value="12,345"');
		const en = inLocale('en', { valueMinor: 1234, currency: 'USD', typed: '12.345' });
		expect(input(en)).toContain('value="12.345"');
		expect(input(inLocale('id', { currency: 'IDR', typed: '12.50' }))).toContain('value="12.50"');
	});

	it('escapes the echoed text', () => {
		const body = inLocale('id', { currency: 'USD', typed: '"><b>1' });
		// The quote is escaped, so the text never leaves the attribute.
		expect(body).toMatch(/value="&quot;>(?:<|&lt;)b>1"/);
		expect(body).not.toContain('value="">');
	});

	it('without `typed` the value’s own text is shown, as before', () => {
		expect(input(inLocale('id', { valueMinor: 1234, currency: 'USD' }))).toContain('value="12,34"');
	});
});
