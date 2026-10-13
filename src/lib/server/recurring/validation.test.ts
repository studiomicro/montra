import { describe, expect, it } from 'vitest';
import { AMOUNT_INVALID, AMOUNT_INVALID_CENTS } from '../transactions/messages';
import { parseRecurringForm, resolveRecurringInput, type RecurringDraft } from './validation';

const TODAY = '2026-10-08';

function form(fields: Record<string, string> = {}): FormData {
	const f = new FormData();
	const all = {
		type: 'expense',
		amount: '1.500.000',
		walletId: 'w1',
		categoryId: 'c1',
		title: 'Sewa kos',
		note: '',
		frequency: 'monthly',
		day: '12',
		weekday: '3',
		startOn: '2026-10-01',
		endOn: '',
		...fields
	};
	for (const [k, v] of Object.entries(all)) f.set(k, v);
	return f;
}
const ok = (fields: Record<string, string> = {}) => {
	const r = parseRecurringForm(form(fields), TODAY, 'id');
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.draft;
};
const errors = (fields: Record<string, string>) => {
	const r = parseRecurringForm(form(fields), TODAY, 'id');
	if (r.ok) throw new Error('expected a refusal');
	return r.errors;
};

describe('parseRecurringForm (FN-36)', () => {
	it('reads a monthly expense', () => {
		expect(ok()).toEqual({
			type: 'expense',
			amountText: '1.500.000',
			locale: 'id',
			walletId: 'w1',
			categoryId: 'c1',
			title: 'Sewa kos',
			note: null,
			frequency: 'monthly',
			day: 12,
			startOn: '2026-10-01',
			endOn: null
		});
	});

	it('reads only the chosen frequency’s day field', () => {
		expect(ok({ frequency: 'weekly', day: '99' }).day).toBe(3);
		expect(ok({ frequency: 'monthly', weekday: '99' }).day).toBe(12);
	});

	it('refuses transfers, balance adjustments and unknown types (owner decision A)', () => {
		for (const type of ['transfer', 'adjustment', '__proto__', ''])
			expect(errors({ type }).type).toBe('Pilih pengeluaran atau pemasukan.');
	});

	it('refuses a day outside 1–31 (monthly) and 1–7 (weekly) and an unknown frequency', () => {
		expect(errors({ day: '0' }).day).toBe('Pilih tanggal 1 sampai 31.');
		expect(errors({ day: '32' }).day).toBe('Pilih tanggal 1 sampai 31.');
		expect(errors({ day: '1.5' }).day).toBe('Pilih tanggal 1 sampai 31.');
		expect(errors({ frequency: 'weekly', weekday: '8' }).day).toBe('Pilih hari dalam seminggu.');
		expect(errors({ frequency: 'daily' }).frequency).toBe('Pilih bulanan atau mingguan.');
	});

	/** The posted amount read with a wallet of `currency`, as the action does (FN-47). */
	const amountIn = (amount: string, currency: string, locale: 'id' | 'en' = 'id') => {
		const r = parseRecurringForm(form({ amount }), TODAY, locale);
		if (!r.ok) return 'refused at parse';
		const resolved = resolveRecurringInput(r.draft, {
			wallet: { id: 'w1', currency },
			category: { id: 'c1', kind: 'expense' }
		});
		return resolved.ok ? resolved.value.amountMinor : resolved.errors.amountMinor;
	};

	it('IDR and JPY amounts are whole units with grouping dots, never parsed as floats', () => {
		expect(amountIn('25.000', 'IDR')).toBe(2_500_000);
		expect(amountIn('0025000', 'IDR')).toBe(2_500_000);
		// Red team FN-47 L2: plain digits or exact groups of three only; `.` is never dropped anywhere.
		for (const amount of ['0025 000', '12.50', '1.2500'])
			expect(amountIn(amount, 'IDR', 'en')).toBe(AMOUNT_INVALID);
		expect(amountIn('1.500', 'JPY')).toBe(1_500);
		for (const amount of ['-5', '0', '', '1e6', '25rb'])
			expect(errors({ amount }).amountMinor).toBeDefined();
		// A decimal comma or a 14th digit is refused once the wallet (IDR) is known.
		expect(amountIn('1,5', 'IDR')).toBe(AMOUNT_INVALID);
		expect(amountIn('25,50', 'JPY')).toBe(AMOUNT_INVALID);
		expect(amountIn('1'.repeat(14), 'IDR')).toBe(AMOUNT_INVALID);
	});

	it('FN-47: a wallet currency with cents takes up to two fraction digits in the UI language', () => {
		expect(amountIn('12,50', 'USD')).toBe(1250);
		expect(amountIn('1.234,56', 'CNY')).toBe(123_456);
		expect(amountIn('0,5', 'HKD')).toBe(50);
		expect(amountIn('1,250.50', 'TWD', 'en')).toBe(125_050);
		for (const [amount, locale] of [
			['12,345', 'id'],
			['12.345', 'en'],
			['12.50', 'id']
		] as const)
			expect(amountIn(amount, 'USD', locale)).toBe(AMOUNT_INVALID_CENTS);
	});

	it('dates: a real start date; an optional end not before the first run', () => {
		expect(errors({ startOn: '2026-02-30' }).startOn).toBe('Pilih tanggal mulai yang benar.');
		expect(errors({ endOn: 'besok' }).endOn).toBe(
			'Pilih tanggal selesai yang benar, atau kosongkan.'
		);
		// The first run on or after both the start (1 Oct) and today (8 Oct) is 12 October.
		expect(errors({ endOn: '2026-10-11' }).endOn).toBe(
			'Tanggal selesai lebih awal dari transaksi pertama seri ini.'
		);
		expect(ok({ endOn: '2026-10-12' }).endOn).toBe('2026-10-12');
	});

	it('cleans the title and note (control and zero-width characters) and caps them', () => {
		expect(ok({ title: ' Se​wa\u0007 kos ' }).title).toBe('Sewa kos');
		expect(ok({ title: 'x'.repeat(200) }).title).toHaveLength(80);
		expect(ok({ note: 'y'.repeat(900) }).note).toHaveLength(500);
		expect(errors({ walletId: 'w'.repeat(65) }).walletId).toBeDefined();
	});
});

describe('resolveRecurringInput', () => {
	const draft: RecurringDraft = {
		type: 'income',
		amountText: '8.000.000',
		locale: 'id',
		walletId: 'w1',
		categoryId: 'c1',
		title: null,
		note: null,
		frequency: 'monthly',
		day: 25,
		startOn: '2026-10-01',
		endOn: null
	};
	it('reads the amount with the wallet’s currency and keeps the schedule', () => {
		expect(
			resolveRecurringInput(draft, {
				wallet: { id: 'w1', currency: 'IDR' },
				category: { id: 'c1', kind: 'income' }
			})
		).toEqual({
			ok: true,
			value: {
				type: 'income',
				amountMinor: 8_000_000_00,
				currency: 'IDR',
				walletId: 'w1',
				categoryId: 'c1',
				title: null,
				note: null,
				schedule: { frequency: 'monthly', day: 25 },
				startOn: '2026-10-01',
				endOn: null
			}
		});
	});
	it('refuses a missing wallet, a missing category and a category of the other kind', () => {
		expect(resolveRecurringInput(draft, { wallet: null, category: null })).toMatchObject({
			ok: false,
			errors: { walletId: 'Dompet tidak ditemukan.' }
		});
		expect(
			resolveRecurringInput(draft, {
				wallet: { id: 'w1', currency: 'IDR' },
				category: { id: 'c1', kind: 'expense' }
			})
		).toMatchObject({ ok: false, errors: { categoryId: expect.any(String) } });
	});
});
