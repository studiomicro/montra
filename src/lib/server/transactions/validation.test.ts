import { describe, expect, it } from 'vitest';
import { minorToAmountText } from '#lib/shared/amount-input';
import {
	AMOUNT_INVALID,
	AMOUNT_INVALID_CENTS,
	AMOUNT_TOO_LARGE,
	CATEGORY_KIND_MISMATCH,
	CATEGORY_NOT_FOUND,
	CATEGORY_REQUIRED,
	CURRENCY_MISMATCH,
	DATE_INVALID,
	TIME_INVALID,
	TRANSACTION_CHANGED,
	TRANSFER_CURRENCY,
	TRANSFER_SAME_WALLET,
	TRANSFER_TO_REQUIRED,
	TYPE_INVALID,
	WALLET_NOT_FOUND,
	WALLET_REQUIRED
} from './messages';
import { WALLET_CHANGED } from '../wallets/messages';
import {
	capturedTransactionInput,
	composeAmountMinor,
	parseTransactionForm,
	resolveTransactionInput,
	type CapturedFields,
	type DraftRefs
} from './validation';

function form(fields: Record<string, string>): FormData {
	const f = new FormData();
	const base = {
		type: 'expense',
		amount: '25.000',
		walletId: 'w1',
		categoryId: 'c1',
		title: 'Kopi susu',
		note: '',
		occurredOn: '2026-10-08'
	};
	for (const [k, v] of Object.entries({ ...base, ...fields })) f.set(k, v);
	return f;
}

const refs = (over: Partial<DraftRefs> = {}): DraftRefs => ({
	wallet: { id: 'w1', currency: 'IDR' },
	toWallet: { id: 'w2', currency: 'IDR' },
	category: { id: 'c1', kind: 'expense' },
	...over
});

function resolve(
	fields: Record<string, string>,
	over: Partial<DraftRefs> = {},
	locale: 'id' | 'en' = 'id'
) {
	const parsed = parseTransactionForm(form(fields), locale);
	if (!parsed.ok) return parsed;
	return resolveTransactionInput(parsed.draft, refs(over));
}

describe('parseTransactionForm + resolveTransactionInput', () => {
	it('stores a positive magnitude in the wallet’s minor units, with the wallet’s currency', () => {
		expect(resolve({})).toEqual({
			ok: true,
			value: {
				type: 'expense',
				amountMinor: 2_500_000,
				currency: 'IDR',
				walletId: 'w1',
				transferToWalletId: null,
				categoryId: 'c1',
				title: 'Kopi susu',
				note: null,
				occurredOn: '2026-10-08',
				occurredTime: null
			}
		});
		expect(resolve({ amount: '1.500' }, { wallet: { id: 'w1', currency: 'JPY' } })).toMatchObject({
			ok: true,
			value: { amountMinor: 1500, currency: 'JPY' }
		});
	});

	it('refuses zero, letters, sen, a minus and more than 13 digits — never parseFloat', () => {
		for (const amount of [
			'',
			'0',
			'000',
			'12abc',
			'1.250.000,50',
			'-5000',
			'1e9',
			'12345678901234'
		])
			expect(resolve({ amount })).toMatchObject({
				ok: false,
				errors: { amountMinor: AMOUNT_INVALID }
			});
		// Leading zeros are dropped from plain digits; `0001.234` is not a group of three, so it is refused.
		expect(resolve({ amount: '0001234' })).toMatchObject({
			ok: true,
			value: { amountMinor: 123_400 }
		});
		expect(resolve({ amount: '0001.234' })).toMatchObject({
			ok: false,
			errors: { amountMinor: AMOUNT_INVALID }
		});
	});

	it('FN-47 red team L2: IDR/JPY take plain digits or exact groups of three, never `.` anywhere', () => {
		const minor = (amount: string, currency: string, locale: 'id' | 'en') => {
			const r = resolve({ amount }, { wallet: { id: 'w1', currency } }, locale);
			return r.ok ? r.value.amountMinor : r.errors.amountMinor;
		};
		expect(composeAmountMinor('12.50', 'IDR', 'en')).toBeNull();
		expect(composeAmountMinor('12.5', 'JPY', 'en')).toBeNull();
		for (const locale of ['id', 'en'] as const) {
			// An en `12.50` typed for a USD wallet and posted against an IDR or JPY wallet: refused, never ×100.
			expect(minor('12.50', 'IDR', locale)).toBe(AMOUNT_INVALID);
			expect(minor('12.5', 'JPY', locale)).toBe(AMOUNT_INVALID);
			for (const amount of ['1.25.000', '1.2500', '12.500.00', '25 000', '1. 250', '.250', '250.'])
				expect(minor(amount, 'IDR', locale)).toBe(AMOUNT_INVALID);
			expect(minor('25000', 'IDR', locale)).toBe(2_500_000);
			expect(minor('1.250.000', 'IDR', locale)).toBe(125_000_000);
			expect(minor(' 25.000 ', 'IDR', locale)).toBe(2_500_000);
			expect(minor('1.500', 'JPY', locale)).toBe(1500);
		}
	});

	it('QA FN-47 #2: a refused amount is told the rule of its currency', () => {
		const error = (amount: string, currency: string) => {
			const r = resolve({ amount }, { wallet: { id: 'w1', currency } });
			return r.ok ? null : r.errors.amountMinor;
		};
		expect(error('12,345', 'USD')).toBe(AMOUNT_INVALID_CENTS);
		expect(error('12,345', 'HKD')).toBe(AMOUNT_INVALID_CENTS);
		expect(error('12,50', 'IDR')).toBe(AMOUNT_INVALID);
		expect(error('12,50', 'JPY')).toBe(AMOUNT_INVALID);
	});

	it('FN-47: a wallet with cents reads up to two fraction digits in the UI language; IDR/JPY never', () => {
		const usd = { wallet: { id: 'w1', currency: 'USD' } };
		const minor = (amount: string, currency: string, locale: 'id' | 'en' = 'id') => {
			const r = resolve({ amount }, { wallet: { id: 'w1', currency } }, locale);
			return r.ok ? r.value.amountMinor : r.errors.amountMinor;
		};
		expect(resolve({ amount: '12,50' }, usd)).toMatchObject({
			ok: true,
			value: { amountMinor: 1250, currency: 'USD' }
		});
		expect(minor('20,75', 'USD')).toBe(2075);
		expect(minor('0,5', 'EUR')).toBe(50);
		expect(minor(',50', 'SGD')).toBe(50);
		expect(minor('1.234,56', 'CNY')).toBe(123_456);
		expect(minor('12.50', 'USD', 'en')).toBe(1250);
		expect(minor('1,250.50', 'HKD', 'en')).toBe(125_050);
		expect(minor('25.000', 'TWD')).toBe(2_500_000);
		// Three fraction digits are refused, never rounded or cut; IDR and JPY take no fraction at all.
		expect(minor('12,345', 'USD')).toBe(AMOUNT_INVALID_CENTS);
		expect(minor('12.345', 'USD', 'en')).toBe(AMOUNT_INVALID_CENTS);
		expect(minor('12,50', 'IDR')).toBe(AMOUNT_INVALID);
		expect(minor('12,50', 'JPY')).toBe(AMOUNT_INVALID);
		expect(minor('12,50', 'IDR', 'en')).toBe(AMOUNT_INVALID);
	});

	it('FN-47: an edit form pre-filled from a stored amount saves the same amount (cents kept)', () => {
		for (const [stored, currency, locale] of [
			[1250, 'USD', 'id'],
			[1250, 'USD', 'en'],
			[123_456, 'CNY', 'id'],
			[100, 'GBP', 'en'],
			[2_500_000, 'IDR', 'id'],
			[2_500_000, 'IDR', 'en'],
			[1500, 'JPY', 'en']
		] as const) {
			const amount = minorToAmountText(stored, currency, locale);
			const r = resolve({ amount }, { wallet: { id: 'w1', currency } }, locale);
			expect(r.ok && r.value.amountMinor).toBe(stored);
		}
	});

	it('refuses an unknown type and requires a wallet and, for expense/income, a category', () => {
		expect(resolve({ type: 'refund' })).toMatchObject({
			ok: false,
			errors: { type: TYPE_INVALID }
		});
		expect(resolve({ type: '__proto__' })).toMatchObject({
			ok: false,
			errors: { type: TYPE_INVALID }
		});
		expect(resolve({ walletId: '' })).toMatchObject({
			ok: false,
			errors: { walletId: WALLET_REQUIRED }
		});
		expect(resolve({ categoryId: '' })).toMatchObject({
			ok: false,
			errors: { categoryId: CATEGORY_REQUIRED }
		});
	});

	it('answers an id that is not in the space as not found (no detail)', () => {
		expect(resolve({}, { wallet: null })).toMatchObject({
			ok: false,
			errors: { walletId: WALLET_NOT_FOUND }
		});
		expect(resolve({}, { category: null })).toMatchObject({
			ok: false,
			errors: { categoryId: CATEGORY_NOT_FOUND }
		});
	});

	it('requires a category of the type’s kind', () => {
		expect(resolve({ type: 'income' })).toMatchObject({
			ok: false,
			errors: { categoryId: CATEGORY_KIND_MISMATCH }
		});
		expect(resolve({ type: 'income' }, { category: { id: 'c1', kind: 'income' } })).toMatchObject({
			ok: true
		});
	});

	describe('transfers', () => {
		it('needs a different destination of the same currency and drops the category', () => {
			expect(resolve({ type: 'transfer', transferToWalletId: 'w2' })).toMatchObject({
				ok: true,
				value: { type: 'transfer', transferToWalletId: 'w2', categoryId: null }
			});
			expect(resolve({ type: 'transfer' })).toMatchObject({
				ok: false,
				errors: { transferToWalletId: TRANSFER_TO_REQUIRED }
			});
		});

		it('refuses the same wallet on both sides', () => {
			expect(resolve({ type: 'transfer', transferToWalletId: 'w1' })).toMatchObject({
				ok: false,
				errors: { transferToWalletId: TRANSFER_SAME_WALLET }
			});
		});

		it('refuses two different currencies (owner decision E)', () => {
			expect(
				resolve(
					{ type: 'transfer', transferToWalletId: 'w2' },
					{ toWallet: { id: 'w2', currency: 'USD' } }
				)
			).toMatchObject({ ok: false, errors: { transferToWalletId: TRANSFER_CURRENCY } });
		});

		it('ignores a destination on an expense (the hidden field stays in the form)', () => {
			expect(resolve({ transferToWalletId: 'w2' })).toMatchObject({
				ok: true,
				value: { transferToWalletId: null }
			});
		});
	});

	it('validates the WIB date and the optional time', () => {
		for (const occurredOn of ['', '2026-02-30', '08/10/2026', '1999-12-31'])
			expect(resolve({ occurredOn })).toMatchObject({
				ok: false,
				errors: { occurredOn: DATE_INVALID }
			});
		expect(resolve({ occurredTime: '23:30' })).toMatchObject({
			ok: true,
			value: { occurredTime: '23:30' }
		});
		for (const occurredTime of ['24:00', '7:5', 'pagi'])
			expect(resolve({ occurredTime })).toMatchObject({
				ok: false,
				errors: { occurredTime: TIME_INVALID }
			});
	});

	it('strips control and zero-width characters and caps title (80) and note (500)', () => {
		const r = resolve({
			title: ' Kopi​ susu\u0007 ',
			note: `${'n'.repeat(600)}`
		});
		expect(r).toMatchObject({ ok: true, value: { title: 'Kopi susu' } });
		if (r.ok) expect(r.value.note).toHaveLength(500);
		expect(resolve({ title: 'x'.repeat(200) })).toMatchObject({
			ok: true,
			value: { title: 'x'.repeat(80) }
		});
		expect(resolve({ title: '​\u0000' })).toMatchObject({ ok: true, value: { title: null } });
	});

	it('caps one amount at 10^13 minor units (Rp 100.000.000.000), so totals stay countable (M1)', () => {
		expect(resolve({ amount: '100.000.000.000' })).toMatchObject({
			ok: true,
			value: { amountMinor: 10_000_000_000_000 }
		});
		expect(resolve({ amount: '100.000.000.001' })).toMatchObject({
			ok: false,
			errors: { amountMinor: AMOUNT_TOO_LARGE }
		});
		// The red-team repro: 9.999.999.999.999 in a USD wallet.
		expect(
			resolve({ amount: '9.999.999.999.999' }, { wallet: { id: 'w1', currency: 'USD' } })
		).toMatchObject({ ok: false, errors: { amountMinor: AMOUNT_TOO_LARGE } });
		expect(
			resolve({ amount: '9.999.999.999.999' }, { wallet: { id: 'w1', currency: 'JPY' } })
		).toMatchObject({ ok: true, value: { amountMinor: 9_999_999_999_999 } });
	});

	it('echoes what was typed back for a refused form', () => {
		const r = parseTransactionForm(form({ amount: 'abc', title: 'Parkir' }), 'id');
		expect(r).toMatchObject({
			ok: false,
			values: { amount: 'abc', title: 'Parkir', type: 'expense' }
		});
	});

	it('reuses FN-04’s "changed meanwhile" phrase, not a second key', () => {
		expect(TRANSACTION_CHANGED).toBe(WALLET_CHANGED);
	});
});

describe('capturedTransactionInput (FN-11: a stored draft through the same schema and id rules)', () => {
	const captured = (over: Partial<CapturedFields> = {}): CapturedFields => ({
		type: 'expense',
		amountMinor: 2_850_050,
		currency: 'IDR',
		walletId: 'w1',
		categoryId: 'c1',
		title: 'Kedai Kopi',
		note: null,
		occurredOn: '2026-10-08',
		...over
	});

	it('keeps the exact captured minor amount (sen included) and the wallet’s currency', () => {
		expect(capturedTransactionInput(captured(), refs({ toWallet: null }))).toEqual({
			ok: true,
			value: {
				type: 'expense',
				amountMinor: 2_850_050,
				currency: 'IDR',
				walletId: 'w1',
				transferToWalletId: null,
				categoryId: 'c1',
				title: 'Kedai Kopi',
				note: null,
				occurredOn: '2026-10-08',
				occurredTime: null
			}
		});
	});

	it('needs a wallet and a category (an incomplete draft never becomes a transaction)', () => {
		expect(capturedTransactionInput(captured({ walletId: null }), refs())).toMatchObject({
			ok: false,
			errors: { walletId: WALLET_REQUIRED }
		});
		expect(capturedTransactionInput(captured({ categoryId: null }), refs())).toMatchObject({
			ok: false,
			errors: { categoryId: CATEGORY_REQUIRED }
		});
	});

	it('refuses ids that point at nothing in the space, or a category of the other kind', () => {
		expect(capturedTransactionInput(captured(), refs({ wallet: null }))).toMatchObject({
			ok: false,
			errors: { walletId: WALLET_NOT_FOUND }
		});
		expect(capturedTransactionInput(captured(), refs({ category: null }))).toMatchObject({
			ok: false,
			errors: { categoryId: CATEGORY_NOT_FOUND }
		});
		expect(
			capturedTransactionInput(
				captured({ type: 'income' }),
				refs({ category: { id: 'c1', kind: 'expense' } })
			)
		).toMatchObject({ ok: false, errors: { categoryId: CATEGORY_KIND_MISMATCH } });
	});

	it('never converts: a wallet in another currency is refused', () => {
		expect(
			capturedTransactionInput(captured(), refs({ wallet: { id: 'w1', currency: 'USD' } }))
		).toMatchObject({ ok: false, errors: { walletId: CURRENCY_MISMATCH } });
	});

	it('bounds the amount like the form: 1 … 10^13, safe integers only', () => {
		for (const amountMinor of [0, -5, 1.5, Number.NaN])
			expect(capturedTransactionInput(captured({ amountMinor }), refs())).toMatchObject({
				ok: false,
				errors: { amountMinor: AMOUNT_INVALID }
			});
		expect(
			capturedTransactionInput(captured({ amountMinor: 10_000_000_000_001 }), refs())
		).toMatchObject({ ok: false, errors: { amountMinor: AMOUNT_TOO_LARGE } });
		expect(
			capturedTransactionInput(captured({ amountMinor: 10_000_000_000_000 }), refs())
		).toMatchObject({ ok: true });
	});

	it('cleans and caps captured text, and refuses a date that is not real', () => {
		const r = capturedTransactionInput(
			captured({ title: `  Kopi\u200b susu\u0007 ${'x'.repeat(200)}`, note: '\u200b' }),
			refs()
		);
		expect(r.ok && r.value.title?.startsWith('Kopi susu')).toBe(true);
		expect(r.ok && (r.value.title ?? '').length).toBeLessThanOrEqual(80);
		expect(r.ok && r.value.note).toBeNull();
		expect(capturedTransactionInput(captured({ occurredOn: '2026-02-30' }), refs())).toMatchObject({
			ok: false,
			errors: { occurredOn: DATE_INVALID }
		});
	});
});

describe('an exact minor amount (FN-38 public API)', () => {
	const exact = (
		amount: number,
		fields: Record<string, string> = {},
		over: Partial<DraftRefs> = {}
	) => {
		const parsed = parseTransactionForm(form({ amount: 'not read', ...fields }), 'id', amount);
		if (!parsed.ok) return parsed;
		return resolveTransactionInput(parsed.draft, refs(over));
	};

	it('keeps sen exactly and ignores the typed amount field', () => {
		const r = exact(2_500_050);
		expect(r.ok && r.value.amountMinor).toBe(2_500_050);
		expect(r.ok && r.value.currency).toBe('IDR');
	});

	it('applies the capture rule: a safe integer from 1 to the maximum', () => {
		for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
			expect(exact(bad)).toMatchObject({ ok: false, errors: { amountMinor: AMOUNT_INVALID } });
		expect(exact(10_000_000_000_001)).toMatchObject({
			ok: false,
			errors: { amountMinor: AMOUNT_TOO_LARGE }
		});
		expect(exact(10_000_000_000_000).ok).toBe(true);
	});

	it('keeps every other rule of the compose form', () => {
		expect(exact(100, { type: 'adjustment' })).toMatchObject({
			ok: false,
			errors: { type: TYPE_INVALID }
		});
		expect(exact(100, {}, { wallet: null })).toMatchObject({
			ok: false,
			errors: { walletId: WALLET_NOT_FOUND }
		});
		expect(exact(100, { occurredTime: '25:00' })).toMatchObject({
			ok: false,
			errors: { occurredTime: TIME_INVALID }
		});
	});
});
