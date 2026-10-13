import { describe, expect, it } from 'vitest';
import { amountFractionDigits } from './amount-input';
import { currencyExponent, formatMoney } from './money-format';
import { createTranslator } from './i18n';
import {
	maskedLastFour,
	WALLET_CURRENCIES,
	WALLET_NAME_MAX_LENGTH,
	WALLET_QUICK_PICKS,
	WALLET_TYPE_LABELS,
	WALLET_TYPES,
	walletCurrencyLabel,
	walletQuickPick
} from './wallets';

describe('wallet constants', () => {
	it('shows at most the last 4 digits', () => {
		expect(maskedLastFour('1234')).toBe('•••• 1234');
	});

	it('every allow-listed currency has a known exponent and formats with its code', () => {
		expect(WALLET_CURRENCIES[0]).toBe('IDR');
		for (const code of WALLET_CURRENCIES) {
			// ISO exponents: IDR keeps 2 (stored sen); only its typing is whole-unit (amountFractionDigits).
			expect(currencyExponent(code)).toBe(code === 'JPY' ? 0 : 2);
			expect(amountFractionDigits(code)).toBe(code === 'JPY' || code === 'IDR' ? 0 : 2);
			if (code !== 'IDR') expect(formatMoney(100, code).startsWith(code)).toBe(true);
		}
	});

	it('FN-47: lists TWD, HKD and CNY after the first eight, in picker order', () => {
		expect(WALLET_CURRENCIES).toEqual([
			'IDR',
			'USD',
			'SGD',
			'MYR',
			'EUR',
			'JPY',
			'AUD',
			'GBP',
			'TWD',
			'HKD',
			'CNY'
		]);
	});

	it('FN-47: picker labels are bare codes except "CNY (RMB)", never translated; money keeps the code', () => {
		expect(WALLET_CURRENCIES.map(walletCurrencyLabel)).toEqual([
			'IDR',
			'USD',
			'SGD',
			'MYR',
			'EUR',
			'JPY',
			'AUD',
			'GBP',
			'TWD',
			'HKD',
			'CNY (RMB)'
		]);
		const { tr } = createTranslator('en');
		for (const code of WALLET_CURRENCIES)
			expect(tr(walletCurrencyLabel(code))).toBe(walletCurrencyLabel(code));
		expect(formatMoney(123_456, 'HKD')).toBe('HKD\u00a01.234,56');
		expect(formatMoney(123_456, 'HKD', 'auto', 'en')).toBe('HKD\u00a01,234.56');
		expect(formatMoney(-2500, 'CNY')).toBe('\u2212CNY\u00a025');
		expect(formatMoney(100, 'TWD')).toBe('TWD\u00a01');
	});

	it('labels every type and has no investasi type (owner decision E)', () => {
		expect(Object.keys(WALLET_TYPE_LABELS).sort()).toEqual([...WALLET_TYPES].sort());
		expect(WALLET_TYPES).not.toContain('investasi');
	});
});

describe('wallet quick picks (FN-39)', () => {
	it('GoPay, OVO, ShopeePay and DANA, no GrabPay (it is OVO in Indonesia)', () => {
		expect(WALLET_QUICK_PICKS.map((p) => p.name)).toEqual(['GoPay', 'OVO', 'ShopeePay', 'DANA']);
		for (const p of WALLET_QUICK_PICKS) {
			expect(p.id).toMatch(/^[a-z]{1,20}$/);
			expect(p.name.length).toBeLessThanOrEqual(WALLET_NAME_MAX_LENGTH);
		}
	});
	it('finds a pick by id only; anything else is null', () => {
		expect(walletQuickPick('gopay')).toEqual({ id: 'gopay', name: 'GoPay' });
		for (const id of [null, '', 'grabpay', 'GoPay', '__proto__', 'constructor'])
			expect(walletQuickPick(id)).toBeNull();
	});
	it('names are proper nouns: the English table never translates them', () => {
		const { tr } = createTranslator('en');
		for (const p of WALLET_QUICK_PICKS) expect(tr(p.name)).toBe(p.name);
	});
});
