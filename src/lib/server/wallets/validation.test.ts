import { describe, expect, it } from 'vitest';
import { formatMoney } from '#lib/shared/money-format';
import { EMONEY_ISSUERS, WALLET_CURRENCIES } from '#lib/shared/wallets';
import { walletBalanceMinor } from './balance';
import {
	BALANCE_INVALID,
	BALANCE_INVALID_CENTS,
	CURRENCY_INVALID,
	EMONEY_FIELD_ONLY,
	EMONEY_ISSUER_REQUIRED,
	LAST_FOUR_INVALID,
	NAME_REQUIRED,
	TYPE_INVALID,
	WALLET_LIMIT
} from './messages';
import { MAX_WALLETS_PER_SPACE } from './repo';
import { parseWalletForm } from './validation';

function form(fields: Record<string, string>): FormData {
	const f = new FormData();
	const base = { name: 'BCA', type: 'bank', currency: 'IDR', openingBalance: '25.000' };
	for (const [k, v] of Object.entries({ ...base, ...fields })) f.set(k, v);
	return f;
}

describe('parseWalletForm', () => {
	it('reads a valid form into integer minor units', () => {
		const r = parseWalletForm(form({ lastFour: '1234', favourite: 'on' }), 'id');
		expect(r).toEqual({
			ok: true,
			value: {
				name: 'BCA',
				type: 'bank',
				currency: 'IDR',
				openingBalanceMinor: 2_500_000,
				isFavourite: true,
				lastFour: '1234',
				creditLimitMinor: null,
				statementDay: null,
				dueDay: null,
				emoneyIssuer: null
			}
		});
	});

	it('defaults the currency to IDR, the balance to 0 and the last 4 to none', () => {
		const f = new FormData();
		f.set('name', 'Dompet');
		f.set('type', 'tunai');
		expect(parseWalletForm(f, 'id')).toMatchObject({
			ok: true,
			value: { currency: 'IDR', openingBalanceMinor: 0, lastFour: null, isFavourite: false }
		});
	});

	it('uses the chosen currency’s exponent', () => {
		expect(parseWalletForm(form({ currency: 'JPY', openingBalance: '1.500' }), 'id')).toMatchObject(
			{
				ok: true,
				value: { openingBalanceMinor: 1500 }
			}
		);
		expect(parseWalletForm(form({ currency: 'USD', openingBalance: '12' }), 'id')).toMatchObject({
			ok: true,
			value: { openingBalanceMinor: 1200 }
		});
	});

	it('makes the balance negative when ticked (decision D), never −0', () => {
		expect(
			parseWalletForm(
				form({ type: 'kartu_kredit', openingBalance: '1.250.000', negative: 'on' }),
				'id'
			)
		).toMatchObject({ ok: true, value: { openingBalanceMinor: -125_000_000 } });
		const zero = parseWalletForm(form({ openingBalance: '', negative: 'on' }), 'id');
		expect(zero.ok && Object.is(zero.value.openingBalanceMinor, 0)).toBe(true);
	});

	it('refuses sen, letters, a minus sign and more than 13 digits instead of guessing', () => {
		for (const openingBalance of ['1.250.000,50', '12abc', '-5000', '12345678901234', '1e9']) {
			expect(parseWalletForm(form({ openingBalance }), 'id')).toMatchObject({
				ok: false,
				errors: { openingBalanceMinor: BALANCE_INVALID }
			});
		}
		expect(parseWalletForm(form({ openingBalance: '1.234.567.890.123' }), 'id')).toMatchObject({
			ok: true,
			value: { openingBalanceMinor: 123_456_789_012_300 }
		});
	});

	it('reads Indonesian thousands dots; a decimal point is refused, never multiplied (red team L2)', () => {
		const minor = (openingBalance: string, currency = 'USD', locale: 'id' | 'en' = 'id') => {
			const r = parseWalletForm(form({ openingBalance, currency }), locale);
			return r.ok ? r.value.openingBalanceMinor : null;
		};
		for (const text of [
			'12.50',
			'12,345',
			'1e3',
			'1.25',
			'1.2500',
			'.250',
			'1..250',
			'1.250.',
			'1 250',
			'+5'
		])
			expect(parseWalletForm(form({ openingBalance: text, currency: 'USD' }), 'id')).toMatchObject({
				ok: false,
				errors: { openingBalanceMinor: BALANCE_INVALID_CENTS }
			});
		expect(minor('1.250')).toBe(125_000);
		expect(minor('1.250.000')).toBe(125_000_000);
		expect(minor(' 25000 ')).toBe(2_500_000);
		expect(minor('25000', 'JPY')).toBe(25_000);
		expect(minor('')).toBe(0);
	});

	it('FN-47: cents for a currency that has them, in the UI language; refused for IDR/JPY or a 3rd digit', () => {
		const minor = (openingBalance: string, currency: string, locale: 'id' | 'en' = 'id') => {
			const r = parseWalletForm(form({ openingBalance, currency }), locale);
			return r.ok ? r.value.openingBalanceMinor : null;
		};
		expect(minor('12,50', 'USD')).toBe(1250);
		expect(minor('12,5', 'USD')).toBe(1250);
		expect(minor('0,5', 'EUR')).toBe(50);
		expect(minor(',50', 'GBP')).toBe(50);
		expect(minor('1.234,56', 'TWD')).toBe(123_456);
		expect(minor('12.50', 'USD', 'en')).toBe(1250);
		expect(minor('1,250.50', 'HKD', 'en')).toBe(125_050);
		expect(minor('12,50', 'CNY')).toBe(1250);
		// Never rounded or cut server-side; IDR and JPY keep the whole-unit contract.
		expect(minor('12,345', 'USD')).toBeNull();
		expect(minor('12.345', 'USD', 'en')).toBeNull();
		expect(minor('12,50', 'USD', 'en')).toBeNull();
		expect(minor('25,50', 'IDR')).toBeNull();
		expect(minor('25,50', 'JPY')).toBeNull();
		const neg = parseWalletForm(
			form({ openingBalance: '12,50', currency: 'USD', negative: 'on' }),
			'id'
		);
		expect(neg.ok && neg.value.openingBalanceMinor).toBe(-1250);
	});

	it('strips control and zero-width characters, caps the name and refuses an empty one', () => {
		expect(parseWalletForm(form({ name: '  Go​Pay\u0007 ' }), 'id')).toMatchObject({
			ok: true,
			value: { name: 'GoPay' }
		});
		expect(parseWalletForm(form({ name: 'x'.repeat(500) }), 'id')).toMatchObject({
			ok: true,
			value: { name: 'x'.repeat(60) }
		});
		for (const name of ['', '   ', '​‍\u0000']) {
			expect(parseWalletForm(form({ name }), 'id')).toMatchObject({
				ok: false,
				errors: { name: NAME_REQUIRED }
			});
		}
	});

	it('refuses a last 4 that is not exactly 4 digits rather than truncating it', () => {
		for (const lastFour of ['4111111111111111', '123', '12a4', '１２３４', '12345']) {
			const r = parseWalletForm(form({ lastFour }), 'id');
			expect(r).toMatchObject({ ok: false, errors: { lastFour: LAST_FOUR_INVALID } });
		}
		expect(parseWalletForm(form({ lastFour: ' 0042 ' }), 'id')).toMatchObject({
			ok: true,
			value: { lastFour: '0042' }
		});
	});

	it('accepts only the allow-listed currencies and the five types', () => {
		for (const currency of WALLET_CURRENCIES)
			expect(parseWalletForm(form({ currency }), 'id').ok).toBe(true);
		for (const currency of ['XAU', 'idr', 'constructor', '__proto__', 'BTC']) {
			expect(parseWalletForm(form({ currency }), 'id')).toMatchObject({
				ok: false,
				errors: { currency: CURRENCY_INVALID }
			});
		}
		for (const type of ['investasi', '', 'Bank', 'toString']) {
			expect(parseWalletForm(form({ type }), 'id')).toMatchObject({
				ok: false,
				errors: { type: TYPE_INVALID }
			});
		}
	});

	it('echoes what was typed back for a refused form, except a refused last 4 (red team L1)', () => {
		const r = parseWalletForm(form({ name: '', lastFour: '4111111111111111' }), 'id');
		expect(r).toMatchObject({
			ok: false,
			values: { name: '', type: 'bank', openingBalance: '25.000', lastFour: '' }
		});
		expect(JSON.stringify(r)).not.toContain('4111111111111111');
		const kept = parseWalletForm(form({ name: '', lastFour: '1234' }), 'id');
		expect(kept).toMatchObject({ ok: false, values: { lastFour: '1234' } });
	});
});

describe('walletBalanceMinor (the FN-05 contract)', () => {
	it('is exactly the opening balance while there are no transactions', () => {
		const wallet = { openingBalanceMinor: 2_500_000, currency: 'IDR' };
		expect(walletBalanceMinor(wallet, 0)).toBe(wallet.openingBalanceMinor);
		expect(walletBalanceMinor(wallet)).toBe(2_500_000);
		expect(formatMoney(walletBalanceMinor(wallet, 0), wallet.currency)).toBe(
			formatMoney(wallet.openingBalanceMinor, wallet.currency)
		);
	});

	it('adds a signed transaction sum and refuses an unsafe result', () => {
		expect(walletBalanceMinor({ openingBalanceMinor: -100 }, 250)).toBe(150);
		expect(() => walletBalanceMinor({ openingBalanceMinor: Number.MAX_SAFE_INTEGER }, 1)).toThrow(
			RangeError
		);
	});
});

it('the cap message names the cap', () => {
	expect(WALLET_LIMIT).toContain(String(MAX_WALLETS_PER_SPACE));
});

describe('parseWalletForm FN-58 pass 1: "Kartu e-money"', () => {
	it('saves the choice as an e_wallet with its issuer and the optional last 4', () => {
		for (const issuer of EMONEY_ISSUERS)
			expect(
				parseWalletForm(
					form({ name: 'Flazz', type: 'e_money', emoneyIssuer: issuer, lastFour: '0042' }),
					'id'
				)
			).toMatchObject({
				ok: true,
				value: { type: 'e_wallet', emoneyIssuer: issuer, lastFour: '0042' }
			});
		expect(
			parseWalletForm(form({ type: 'e_money', emoneyIssuer: 'kmt', lastFour: '' }), 'id')
		).toMatchObject({ ok: true, value: { type: 'e_wallet', emoneyIssuer: 'kmt', lastFour: null } });
	});

	it('needs an issuer for the e-money choice: none or an unknown key is refused', () => {
		for (const emoneyIssuer of ['', 'gopay', 'BCA_FLAZZ', 'bca_flazz ; drop', 'e_wallet'])
			expect(parseWalletForm(form({ type: 'e_money', emoneyIssuer }), 'id')).toMatchObject({
				ok: false,
				errors: { emoneyIssuer: EMONEY_ISSUER_REQUIRED },
				values: { type: 'e_money' }
			});
		const f = form({ type: 'e_money' });
		f.delete('emoneyIssuer');
		expect(parseWalletForm(f, 'id')).toMatchObject({
			ok: false,
			errors: { emoneyIssuer: EMONEY_ISSUER_REQUIRED }
		});
	});

	it('refuses an issuer sent with any other type (a hidden field is not authorization)', () => {
		for (const type of ['tunai', 'bank', 'e_wallet', 'kartu_kredit', 'lainnya'])
			expect(parseWalletForm(form({ type, emoneyIssuer: 'bca_flazz' }), 'id')).toMatchObject({
				ok: false,
				errors: { emoneyIssuer: EMONEY_FIELD_ONLY }
			});
		// A plain e-wallet stays one, with no issuer.
		expect(parseWalletForm(form({ type: 'e_wallet', emoneyIssuer: '' }), 'id')).toMatchObject({
			ok: true,
			value: { type: 'e_wallet', emoneyIssuer: null }
		});
	});

	it('never takes a full card number: only the last 4', () => {
		const r = parseWalletForm(
			form({ type: 'e_money', emoneyIssuer: 'bca_flazz', lastFour: '6013500012345678' }),
			'id'
		);
		expect(r).toMatchObject({ ok: false, errors: { lastFour: LAST_FOUR_INVALID } });
		expect(!r.ok && r.values.lastFour).toBe('');
	});

	it('e_money is a form choice only, never a stored type', () => {
		const r = parseWalletForm(form({ type: 'e_money', emoneyIssuer: 'megacash' }), 'id');
		expect(r.ok && r.value.type).toBe('e_wallet');
	});
});
