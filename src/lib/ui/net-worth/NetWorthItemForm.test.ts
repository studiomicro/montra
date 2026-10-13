import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import I18nHarness from '../../../../test/helpers/I18nHarness.svelte';
import NetWorthItemForm from './NetWorthItemForm.svelte';

// A server render never runs `use:enhance`; the module only has to resolve outside SvelteKit.
vi.mock('$app/forms', () => ({ enhance: () => ({}) }));

const values = (currency: string) => ({
	kind: 'cash',
	name: 'Tabungan',
	currency,
	priceSource: 'manual',
	symbol: '',
	quantity: '',
	manualValue: '',
	acquiredOn: '',
	note: ''
});

const renderForm = (currency: string) =>
	render(I18nHarness, {
		props: {
			component: NetWorthItemForm as unknown as Component<Record<string, unknown>>,
			props: { action: '?/createItem', values: values(currency), busy: false, submit: () => {} }
		}
	}).body;

// FN-47 follow-up: the value hint names the rule of the item's currency.
describe('NetWorthItemForm value hint', () => {
	it('says whole numbers for rupiah', () => {
		expect(renderForm('IDR')).toContain('Perkiraanmu sendiri, dalam angka bulat.');
	});

	it('allows cents for a currency that has them', () => {
		const body = renderForm('USD');
		expect(body).toContain('Perkiraanmu sendiri, boleh dengan sen.');
		expect(body).not.toContain('dalam angka bulat');
	});
});
