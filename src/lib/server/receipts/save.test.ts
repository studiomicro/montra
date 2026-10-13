import { describe, expect, it } from 'vitest';
import { createTranslator } from '#lib/shared/i18n';
import type { ReceiptFormValues } from '#lib/shared/receipts';
import {
	RECEIPT_ITEMS_REQUIRED,
	RECEIPT_SPLIT_DISCOUNT,
	RECEIPT_TOTAL_MISMATCH,
	RECEIPT_TOTAL_REQUIRED
} from './messages';
import { parseReceiptForm, plannedRows, receiptFormValues, receiptNote } from './save';

const t = createTranslator('id');
const base = (o: Partial<ReceiptFormValues> = {}): ReceiptFormValues => ({
	mode: 'single',
	shop: 'Warung Contoh Sejahtera',
	occurredOn: '2026-10-08',
	walletId: 'w1',
	categoryId: 'c-makan',
	paymentMethod: 'QRIS',
	items: [
		{ name: 'Nasi goreng', amount: '25.000', categoryId: '' },
		{ name: 'Kopi susu', amount: '18.000', categoryId: 'c-kopi' }
	],
	tax: '4.300',
	service: '',
	discount: '',
	total: '47.300',
	keepPhoto: true,
	acceptMismatch: false,
	readTicket: '',
	...o
});
const parsed = (o: Partial<ReceiptFormValues> = {}) => parseReceiptForm(base(o), t);

describe('receiptFormValues', () => {
	it('reads at most RECEIPT_ITEMS_MAX items and bounds every field', () => {
		const form = new FormData();
		form.set('count', '999');
		form.set('mode', 'split');
		form.set('shop', 'x'.repeat(10_000));
		form.set('keepPhoto', 'on');
		const v = receiptFormValues(form);
		expect(v.items).toHaveLength(80);
		expect(v.mode).toBe('split');
		expect(v.shop.length).toBeLessThanOrEqual(320);
		expect(v.keepPhoto).toBe(true);
		expect(v.acceptMismatch).toBe(false);
	});
});

describe('parseReceiptForm (the edited values, never the AI numbers)', () => {
	it('a reconciled single receipt passes', () => {
		const r = parsed();
		expect(r.ok && r.draft.totalMinor).toBe(4_730_000);
	});

	it('"Satu transaksi" needs a total', () => {
		expect(parsed({ total: '' })).toEqual({ ok: false, errors: { total: RECEIPT_TOTAL_REQUIRED } });
	});

	it('an edited figure that no longer adds up is refused until the user accepts it', () => {
		expect(parsed({ total: '47.000' })).toEqual({
			ok: false,
			errors: { form: RECEIPT_TOTAL_MISMATCH }
		});
		expect(parsed({ total: '47.000', acceptMismatch: true }).ok).toBe(true);
	});

	it('"Pisah per item": every item needs a name and an amount; blank rows are dropped', () => {
		const r = parsed({
			mode: 'split',
			items: [
				{ name: 'Nasi goreng', amount: '25.000', categoryId: '' },
				{ name: '', amount: '', categoryId: '' },
				{ name: 'Kopi susu', amount: '', categoryId: '' }
			]
		});
		expect(r).toEqual({ ok: false, errors: { 'item.2': RECEIPT_ITEMS_REQUIRED } });
	});

	it('"Pisah per item" is refused when the discount exceeds tax plus service', () => {
		expect(parsed({ mode: 'split', tax: '1.000', discount: '10.000', total: '34.000' })).toEqual({
			ok: false,
			errors: { form: RECEIPT_SPLIT_DISCOUNT }
		});
	});

	it('refuses a non-whole amount and a bad date', () => {
		const r = parsed({ tax: '4.300,50', occurredOn: '2026-02-30' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['occurredOn', 'tax']);
	});

	it('an unread shop name saves as "Struk"; the payment line is cleaned and masked', () => {
		const r = parsed({ shop: '  ', paymentMethod: 'DEBIT 1234 5678 9012 3456​' });
		if (!r.ok) throw new Error('expected ok');
		expect(r.draft.title).toBe('Struk');
		expect(r.draft.paymentMethod).not.toMatch(/9012/);
	});
});

describe('plannedRows', () => {
	it('"Satu transaksi": one row of the total at index 0, the photo on it', () => {
		const r = parsed();
		if (!r.ok) throw new Error('expected ok');
		const { rows, photoIndex } = plannedRows(r.draft, t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			index: 0,
			title: 'Warung Contoh Sejahtera',
			amountMinor: 4_730_000
		});
		expect(photoIndex).toBe(0);
	});

	it('"Pisah per item": one row per item plus "Pajak & servis"; the rows add up to the total; photo on the last', () => {
		const r = parsed({ mode: 'split', service: '2.000', discount: '1.000', total: '48.300' });
		if (!r.ok) throw new Error('expected ok');
		const { rows, photoIndex } = plannedRows(r.draft, t);
		expect(rows.map((row) => [row.index, row.title, row.amountMinor, row.categoryId])).toEqual([
			[0, 'Nasi goreng', 2_500_000, 'c-makan'],
			[1, 'Kopi susu', 1_800_000, 'c-kopi'],
			[2, 'Pajak & servis', 530_000, 'c-makan']
		]);
		expect(rows.reduce((s, row) => s + row.amountMinor, 0)).toBe(4_830_000);
		expect(photoIndex).toBe(2);
	});

	it('without tax, service or discount a split has no extra row and the photo goes on the first item', () => {
		const r = parsed({ mode: 'split', tax: '', total: '43.000' });
		if (!r.ok) throw new Error('expected ok');
		const { rows, photoIndex } = plannedRows(r.draft, t);
		expect(rows).toHaveLength(2);
		expect(photoIndex).toBe(0);
	});
});

describe('receiptNote', () => {
	it('lists every item and the figures as entered, in the user language, on one line', () => {
		const r = parsed();
		if (!r.ok) throw new Error('expected ok');
		expect(receiptNote(r.draft, t)).toBe(
			'Nasi goreng Rp 25.000 · Kopi susu Rp 18.000 · Pajak Rp 4.300 · Total Rp 47.300'
		);
		expect(receiptNote(r.draft, createTranslator('en'))).toContain('Tax Rp 4,300');
	});

	it('is cut to the note length', () => {
		const r = parsed({
			items: Array.from({ length: 60 }, (_, i) => ({
				name: `Barang nomor ${i}`,
				amount: '1.000',
				categoryId: ''
			})),
			total: '64.300'
		});
		if (!r.ok) throw new Error('expected ok');
		expect(Array.from(receiptNote(r.draft, t)).length).toBeLessThanOrEqual(500);
	});
});
