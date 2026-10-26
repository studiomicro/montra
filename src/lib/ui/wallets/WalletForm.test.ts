import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Locale } from '#lib/shared/i18n';
import { EMONEY_QUICK_PICKS, WALLET_QUICK_PICKS, type WalletFormValues } from '#lib/shared/wallets';
import Harness from '../../../../test/helpers/I18nHarness.svelte';
import WalletForm from './WalletForm.svelte';
import { stripComments } from '../../../../test/helpers/html';

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const values: WalletFormValues = {
	name: '',
	type: 'tunai',
	currency: 'IDR',
	openingBalance: '',
	negative: false,
	isFavourite: false,
	lastFour: '',
	balanceMode: 'plain',
	overpaid: false,
	creditLimit: '',
	statementDay: '',
	dueDay: '',
	emoneyIssuer: ''
};

function html(props: Record<string, unknown>, locale: Locale) {
	return stripComments(
		render(Harness, {
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
		}).body
	).replace(/\s+/g, ' ');
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

describe('WalletForm FN-55a card wording', () => {
	it('a card form posts the card wording, the bill with its sen, and the limit and days', () => {
		const out = html(
			{
				values: {
					...values,
					type: 'kartu_kredit',
					balanceMode: 'card',
					openingBalance: '1.250.000,50',
					creditLimit: '15.000.000',
					statementDay: '25',
					dueDay: '12'
				}
			},
			'id'
		);
		expect(out).toMatch(/name="balanceMode" value="card"/);
		expect(out).toContain('Tagihan berjalan sekarang (utang)');
		expect(out).toMatch(/name="openingBalance"[^>]*value="1.250.000,50"/);
		expect(out).toContain('Kartu ini sedang lebih bayar (saldo kredit)');
		expect(out).toMatch(/name="creditLimit"[^>]*value="15.000.000"/);
		expect(out).toMatch(/name="statementDay"[^>]*value="25"/);
		expect(out).toMatch(/name="dueDay"[^>]*value="12"/);
		expect(out).not.toContain('Saldo minus');
	});
	it('without JavaScript a plain form keeps "Saldo awal" and still offers the card fields (refused on another type)', () => {
		const out = html({}, 'en');
		expect(out).toMatch(/name="balanceMode" value="plain"/);
		expect(out).toContain('Credit cards only (leave empty for other types)');
		expect(out).toContain('href="/dompet?tambah=1&amp;jenis=kartu_kredit"');
	});
});

describe('WalletForm FN-55 QA: the card quick start is not an e-wallet pick', () => {
	it('the e-wallet group holds the 4 e-wallets only; the card chip has its own group', () => {
		const out = html({}, 'id');
		const groups = out.split('role="group"');
		const ewallet = groups.find((g) => g.includes('Isi cepat e-wallet'))!;
		expect(ewallet.split('</div>')[0]).not.toContain('jenis=kartu_kredit');
		expect(out).toContain('Atau mulai sebagai kartu kredit');
	});
});

describe('WalletForm FN-58 pass 1 e-money cards', () => {
	it('a new wallet offers "Kartu e-money" as a type and one no-JavaScript quick pick per issuer', () => {
		for (const locale of ['id', 'en'] as const) {
			const out = html({}, locale);
			expect(out).toMatch(/name="type" value="e_money"/);
			expect(out).toContain(locale === 'en' ? 'E-money card' : 'Kartu e-money');
			for (const pick of EMONEY_QUICK_PICKS)
				expect(out).toContain(`href="/dompet?tambah=1&amp;kartu=${pick.issuer}"`);
			// No brand badge for an issuer (no badge pattern exists for these cards).
			expect(out).not.toMatch(/kartu=bca_flazz"[^>]*> ?<span class="tile/);
		}
	});
	it('a prefilled e-money form shows the choice and its issuer selected', () => {
		const out = html(
			{ values: { ...values, name: 'BCA Flazz', type: 'e_money', emoneyIssuer: 'bca_flazz' } },
			'id'
		);
		expect(out).toMatch(/value="e_money" checked/);
		expect(out).toMatch(/name="emoneyIssuer"/);
		expect(out).toMatch(/<option value="bca_flazz" selected/);
	});
	it('a refused issuer shows its message', () => {
		const out = html(
			{
				values: { ...values, type: 'e_money' },
				errors: { emoneyIssuer: 'Pilih penerbit kartu e-money.' }
			},
			'en'
		);
		expect(out).toContain('Choose the e-money card issuer.');
	});
	it('editing shows no e-money quick picks', () => {
		const out = html(
			{ action: '?/updateWallet', wallet: { id: 'w1', updatedAt: 1, isFavourite: false } },
			'id'
		);
		expect(out).not.toContain('kartu=bca_flazz');
	});
});
