import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Component } from 'svelte';

// The page's SvelteKit-only imports, stubbed for a plain server render.
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ invalidateAll: async () => {} }));

const Harness = (await import('./helpers/I18nHarness.svelte')).default;
const Page = (await import('../src/routes/(app)/pengaturan/paket/+page.svelte'))
	.default as unknown as Component<Record<string, unknown>>;

type State = { plan: string; storedPlan: string; currentPeriodEnd: number | null };
const GRATIS: State = { plan: 'gratis', storedPlan: 'gratis', currentPeriodEnd: null };

const data = (mockCheckout: boolean, refunds: unknown[] = [], state: State = GRATIS) => ({
	state,
	balance: 1250,
	ledger: [
		{
			id: 'l1',
			delta: 300,
			reason: 'starter_grant',
			createdAt: 1_800_000_000_000,
			balanceAfter: 300
		}
	],
	olderCursor: null,
	paged: false,
	refunds,
	mockCheckout,
	loadError: null
});

const html = (
	mockCheckout: boolean,
	locale: 'id' | 'en' = 'id',
	refunds: unknown[] = [],
	state: State = GRATIS
) =>
	render(Harness, {
		props: {
			component: Page,
			locale,
			props: { data: data(mockCheckout, refunds, state), form: null }
		}
	}).body;

const REFUND = {
	id: 'r1',
	provider: 'mock',
	amountMinor: 4_900_000,
	currency: 'IDR',
	plan: 'pro',
	status: 'pending',
	createdAt: Date.parse('2026-10-09T17:30:00Z')
};

describe('/pengaturan/paket refunds (FN-30 hardening criterion 8)', () => {
	it('no refunds: the group is absent, not shown empty', () => {
		const body = html(false);
		expect(body).not.toContain('Pengembalian dana');
		expect(body).not.toContain('data-testid="refunds"');
	});

	it('lists amount, WIB date, plan and status, with the test-mode note for a mock payment', () => {
		const body = html(false, 'id', [
			REFUND,
			{ ...REFUND, id: 'r2', provider: 'xendit', status: 'refunded' }
		]).replace(/\s+/g, ' ');
		expect(body).toContain('Pengembalian dana');
		expect(body).toContain('Rp 49.000');
		expect(body).toContain('Pembayaran Pro');
		expect(body).toContain('Menunggu diproses');
		expect(body).toContain('Sudah dikembalikan');
		// 17:30 UTC on 9 Oct is 00:30 WIB on 10 Oct.
		expect(body).toMatch(/10 Okt/);
		expect(body.match(/Mode uji — tidak ada uang yang berpindah/g)).toHaveLength(1);
		const en = html(false, 'en', [{ ...REFUND, status: 'cancelled' }]);
		expect(en).toContain('Refunds');
		expect(en).toContain('Cancelled');
		expect(en).toContain('Test mode — no money moved');
	});
});

describe('/pengaturan/paket render (FN-30 AC7, AC8)', () => {
	it('without the mock: no upgrade form, no test-mode banner in the HTML at all', () => {
		const body = html(false);
		expect(body).not.toContain('?/checkout');
		expect(body).not.toContain('Upgrade ke');
		expect(body).not.toContain('Mode uji');
		// The working parts are there regardless.
		expect(body).toContain('?/redeem');
		expect(body).toContain('Riwayat kredit');
	});

	it('with the mock: upgrade forms for Pro and Agen under the test-mode banner', () => {
		const body = html(true);
		expect(body.match(/action="\?\/checkout"/g)).toHaveLength(2);
		expect(body).toContain('Mode uji — tidak ada tagihan sebenarnya');
		expect(html(true, 'en')).toContain('Test mode — no real charge');
	});

	it('badges every price as a placeholder, in both languages', () => {
		expect(html(false).match(/harga sementara/g)).toHaveLength(3);
		expect(html(false, 'en').match(/price placeholder/g)).toHaveLength(3);
	});

	it('shows the credit balance as a plain number, never as rupiah', () => {
		const body = html(false);
		const balance = body.match(/data-testid="credit-balance"[^>]*>([^<]*)</)?.[1];
		expect(balance).toBe('1.250');
		expect(html(false, 'en').match(/data-testid="credit-balance"[^>]*>([^<]*)</)?.[1]).toBe(
			'1,250'
		);
	});
});

describe('credits are never formatted as money (AC8)', () => {
	it('no billing source passes a credit value to formatMoney/formatMoneyCompact', () => {
		const files = [
			'src/routes/(app)/pengaturan/paket/+page.svelte',
			'src/routes/(app)/pengaturan/paket/uji/[ref]/+page.svelte',
			...readdirSync('src/lib/server/billing').map((f) => join('src/lib/server/billing', f)),
			...readdirSync('src/lib/shared/billing').map((f) => join('src/lib/shared/billing', f))
		];
		for (const file of files) {
			for (const call of readFileSync(file, 'utf8').matchAll(/formatMoney(?:Compact)?\(([^)]*)\)/g))
				expect(call[1], `${file}: ${call[0]}`).toMatch(/priceMinor|amountMinor/);
		}
	});
});

describe('/pengaturan/paket Pro card (FN-46 AC 3, 4, 5)', () => {
	// 16:30 UTC on 10 Nov is 23:30 WIB the same day; 17:30 UTC is 00:30 WIB on 11 Nov.
	const END = Date.parse('2026-11-10T17:30:00Z');
	const card = (body: string) => {
		const at = body.indexOf('data-testid="pro-card"');
		return at < 0 ? null : body.slice(at, body.indexOf('</div>', at)).replace(/\s+/g, ' ');
	};

	it.each([
		['pro', 'Pro'],
		['agen', 'Agen']
	])('%s: a separate card with the badge, the plan label and its WIB end date', (plan, label) => {
		const body = html(false, 'id', [], { plan, storedPlan: plan, currentPeriodEnd: END });
		const text = card(body);
		expect(text).not.toBeNull();
		expect(text).toContain('data-testid="pro-badge"');
		expect(text).toContain(`Paketmu: ${label}`);
		expect(text).toMatch(/berlaku sampai 11 Nov/);
	});

	it('Agen’s card is Pro’s card with only the label changed', () => {
		const state = (plan: string) => ({ plan, storedPlan: plan, currentPeriodEnd: END });
		const pro = card(html(false, 'id', [], state('pro')));
		const agen = card(html(false, 'id', [], state('agen')));
		expect(agen).toBe(pro!.replace('Paketmu: Pro', 'Paketmu: Agen'));
	});

	it('never purchased, and lapsed (plan in force Gratis, stored Pro): no card, no badge', () => {
		for (const state of [
			GRATIS,
			{ plan: 'gratis', storedPlan: 'pro', currentPeriodEnd: END - 40 * 86_400_000 }
		]) {
			const body = html(false, 'id', [], state);
			expect(card(body)).toBeNull();
			expect(body).not.toContain('data-testid="pro-badge"');
			expect(body).toContain('Paketmu: Gratis');
		}
	});
});
