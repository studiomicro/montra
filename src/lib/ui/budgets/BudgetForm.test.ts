import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import I18nHarness from '../../../../test/helpers/I18nHarness.svelte';
import BudgetForm from './BudgetForm.svelte';

// A server render never runs `use:enhance`; the module only has to resolve outside SvelteKit.
vi.mock('$app/forms', () => ({ enhance: () => ({}) }));

const renderForm = (props: Record<string, unknown>) =>
	render(I18nHarness, {
		props: {
			component: BudgetForm as unknown as Component<Record<string, unknown>>,
			props: {
				setAction: '?/setBudget',
				deleteAction: '?/deleteBudget',
				currency: 'USD',
				budget: { amountMinor: 50_000, updatedAt: 1 },
				label: 'Anggaran per bulan',
				hint: 'Berlaku untuk setiap bulan.',
				busy: '',
				submit: () => () => {},
				...props
			}
		}
	}).body;

const amountInput = (body: string) => /<input[^>]*name="amount"[^>]*>/.exec(body)?.[0] ?? '';

// FN-47 follow-up: after a refused no-JavaScript submit the form shows what was typed, not the stored budget.
describe('BudgetForm amount after a refusal', () => {
	it('shows the stored budget when nothing was refused', () => {
		expect(amountInput(renderForm({}))).toContain('value="500"');
	});

	it('shows the refused text exactly as typed', () => {
		const input = amountInput(renderForm({ typed: '12,345' }));
		expect(input).toContain('value="12,345"');
		expect(input).not.toContain('value="500"');
	});
});
