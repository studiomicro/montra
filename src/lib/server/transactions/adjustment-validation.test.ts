import { describe, expect, it } from 'vitest';
import {
	ADJUSTMENT_SAME,
	ADJUSTMENT_TOO_LARGE,
	BALANCE_INVALID,
	DATE_INVALID,
	TIME_INVALID,
	WALLET_REQUIRED
} from './messages';
import {
	adjustmentFor,
	MAX_AMOUNT_MINOR,
	parseAdjustmentEdit,
	parseAdjustmentForm,
	statedBalanceMinor
} from './validation';

function form(fields: Record<string, string>): FormData {
	const f = new FormData();
	const base = {
		walletId: 'w1',
		balance: '1.500.000',
		title: '',
		note: '',
		occurredOn: '2026-10-08'
	};
	for (const [k, v] of Object.entries({ ...base, ...fields })) f.set(k, v);
	return f;
}

describe('parseAdjustmentForm (FN-37)', () => {
	it('reads the wallet, the new balance as typed and the dated fields', () => {
		const r = parseAdjustmentForm(form({ title: ' Cocokkan​ ', occurredTime: '23:30' }), 'id');
		expect(r).toMatchObject({
			ok: true,
			draft: {
				walletId: 'w1',
				balance: '1.500.000',
				negative: false,
				title: 'Cocokkan',
				note: null,
				occurredOn: '2026-10-08',
				occurredTime: '23:30'
			}
		});
	});

	it('refuses a missing wallet, a non-whole balance, a bad date and a bad time, field by field', () => {
		const r = parseAdjustmentForm(
			form({ walletId: '', balance: '1,5 jt', occurredOn: '2026-02-30', occurredTime: '25:00' }),
			'id'
		);
		expect(r).toMatchObject({
			ok: false,
			errors: {
				walletId: WALLET_REQUIRED,
				amountMinor: BALANCE_INVALID,
				occurredOn: DATE_INVALID,
				occurredTime: TIME_INVALID
			},
			values: { balance: '1,5 jt' }
		});
	});

	it('an empty balance is 0 (like "Saldo awal"); "negative" makes it below zero', () => {
		const empty = parseAdjustmentForm(form({ balance: '' }), 'id');
		expect(empty.ok && statedBalanceMinor(empty.draft, 'IDR')).toBe(0);
		const neg = parseAdjustmentForm(form({ balance: '50.000', negative: 'on' }), 'id');
		expect(neg.ok && statedBalanceMinor(neg.draft, 'IDR')).toBe(-5_000_000);
		// The amount is read with the wallet's own exponent (JPY has none).
		expect(statedBalanceMinor({ balance: '1.000', negative: false, locale: 'id' }, 'JPY')).toBe(
			1_000
		);
		expect(statedBalanceMinor({ balance: '', negative: true, locale: 'id' }, 'IDR')).toBe(0);
	});
});

describe('parseAdjustmentEdit (owner decision A)', () => {
	it('reads only title, note, date and time; amount, wallet and type fields are ignored', () => {
		const f = form({
			title: 'Baru',
			amount: '1',
			walletId: 'other',
			type: 'expense',
			balance: 'x'
		});
		expect(parseAdjustmentEdit(f)).toEqual({
			ok: true,
			edit: { title: 'Baru', note: null, occurredOn: '2026-10-08', occurredTime: null }
		});
		expect(parseAdjustmentEdit(form({ occurredOn: 'x' }))).toMatchObject({
			ok: false,
			errors: { occurredOn: DATE_INVALID }
		});
	});
});

describe('adjustmentFor', () => {
	it('records the signed difference as a positive magnitude and its direction', () => {
		expect(adjustmentFor(150_000_000, 120_000_000n)).toEqual({
			ok: true,
			amountMinor: 30_000_000,
			direction: 'increase'
		});
		expect(adjustmentFor(90_000_000, 120_000_000n)).toEqual({
			ok: true,
			amountMinor: 30_000_000,
			direction: 'decrease'
		});
		expect(adjustmentFor(-5_000_000, 1n)).toEqual({
			ok: true,
			amountMinor: 5_000_001,
			direction: 'decrease'
		});
	});

	it('refuses no difference and a difference past the one-row bound, exactly', () => {
		expect(adjustmentFor(120_000_000, 120_000_000n)).toEqual({ ok: false, error: ADJUSTMENT_SAME });
		expect(adjustmentFor(0, 0n)).toEqual({ ok: false, error: ADJUSTMENT_SAME });
		expect(adjustmentFor(MAX_AMOUNT_MINOR, 0n)).toMatchObject({
			ok: true,
			amountMinor: MAX_AMOUNT_MINOR
		});
		expect(adjustmentFor(MAX_AMOUNT_MINOR + 1, 0n)).toEqual({
			ok: false,
			error: ADJUSTMENT_TOO_LARGE
		});
		expect(adjustmentFor(-MAX_AMOUNT_MINOR, 1n)).toEqual({
			ok: false,
			error: ADJUSTMENT_TOO_LARGE
		});
		// A balance already past 2^53 (exact BigInt read) is still compared exactly.
		expect(adjustmentFor(0, 2n ** 60n)).toEqual({ ok: false, error: ADJUSTMENT_TOO_LARGE });
	});
});
