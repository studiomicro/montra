import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Locale } from '#lib/shared/i18n';
import { WALLET_QUICK_PICKS, type WalletFormValues } from '#lib/shared/wallets';
import Harness from '../../../../test/helpers/I18nHarness.svelte';
import WalletForm from './WalletForm.svelte';

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const values: WalletFormValues = {
	name: '',
	type: 'tunai',
	currency: 'IDR',
	openingBalance: '',
	negative: false,
	isFavourite: false,
	lastFour: ''
};

function html(props: Record<string, unknown>, locale: Locale) {
	return render(Harness, {
		props: {
			component: WalletForm as unknown as Component<Record<string, unknown>>,
			locale,
			props: {
				action: '?/createWallet',
				values,
				busy: false,
				firstWallet: false,
				submit: () => {},
				...props
			}
		}
	})
		.body.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\s+/g, ' ');
}

describe('WalletForm quick picks (FN-39)', () => {
	it('a new wallet gets one no-JavaScript link per pick, its brand badge and the proper name in both locales', () => {
		for (const locale of ['id', 'en'] as const) {
			const out = html({}, locale);
			for (const pick of WALLET_QUICK_PICKS)
				expect(out).toMatch(
					new RegExp(
						`<a class="chip[^"]*" href="/dompet\\?tambah=1&amp;dompet=${pick.id}"[^>]*> ?<span class="tile s24 b-${pick.id}[^"]*" aria-hidden="true">${pick.name[0]}</span> ?${pick.name} </a>`
					)
				);
			expect(out).toContain(locale === 'en' ? 'Quick fill an e-wallet' : 'Isi cepat e-wallet');
			expect(out).not.toContain('GrabPay');
		}
	});
	it('a prefilled form shows the pick’s name and the e-wallet type selected', () => {
		const out = html({ values: { ...values, name: 'GoPay', type: 'e_wallet' } }, 'id');
		expect(out).toMatch(/name="name"[^>]*value="GoPay"/);
		expect(out).toMatch(/value="e_wallet" checked/);
	});
	it('editing a wallet shows no picks', () => {
		const out = html(
			{ action: '?/updateWallet', wallet: { id: 'w1', updatedAt: 1, isFavourite: false } },
			'id'
		);
		expect(out).not.toContain('dompet=gopay');
	});
});

describe('WalletForm QA FN-47 #3: a refused opening balance is echoed as typed', () => {
	it('a refused `12,345` (USD) stays `12,345` beside its error; an accepted form re-reads normally', () => {
		const refused = html(
			{
				values: { ...values, currency: 'USD', openingBalance: '12,345' },
				errors: { openingBalanceMinor: 'Isi saldo awal dengan maksimal 2 angka di belakang koma.' }
			},
			'id'
		);
		expect(refused).toMatch(/name="openingBalance"[^>]*value="12,345"/);
		expect(refused).toContain('Isi saldo awal dengan maksimal 2 angka di belakang koma.');
		const other = html(
			{
				values: { ...values, currency: 'USD', openingBalance: '12,5' },
				errors: { name: 'Isi nama dompet.' }
			},
			'id'
		);
		expect(other).toMatch(/name="openingBalance"[^>]*value="12,50"/);
	});

	it('English: the refusal and the echo', () => {
		const out = html(
			{
				values: { ...values, currency: 'USD', openingBalance: '12.345' },
				errors: { openingBalanceMinor: 'Isi saldo awal dengan maksimal 2 angka di belakang koma.' }
			},
			'en'
		);
		expect(out).toMatch(/name="openingBalance"[^>]*value="12.345"/);
		expect(out).toContain(
			'Enter the opening balance with at most 2 digits after the decimal point.'
		);
	});
});
