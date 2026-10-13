import { describe, expect, it } from 'vitest';
import { formPayload, transactionSummary, voiceSummary } from './form-item';

const wallets = [
	{ id: 'w-idr', currency: 'IDR' },
	{ id: 'w-usd', currency: 'USD' }
];

const form = (pairs: [string, string][]) => {
	const f = new FormData();
	for (const [k, v] of pairs) f.append(k, v);
	return f;
};

describe('formPayload', () => {
	it('keeps every text field in order and leaves out the clientId and files', () => {
		const f = form([
			['type', 'expense'],
			['clientId', 'x'],
			['amount', '25.000']
		]);
		f.append('photo', new Blob(['x']), 'a.jpg');
		expect(formPayload(f)).toEqual([
			['type', 'expense'],
			['amount', '25.000']
		]);
	});
});

describe('transactionSummary (integer minor units, never floats)', () => {
	it('reads the grouped amount in the wallet currency', () => {
		expect(
			transactionSummary(
				form([
					['walletId', 'w-idr'],
					['amount', '1.250.000'],
					['title', ' Kopi ']
				]),
				wallets,
				'id'
			)
		).toEqual({ title: 'Kopi', amountMinor: 125_000_000, currency: 'IDR', count: 1 });
	});
	it('FN-47: reads cents of a USD wallet with the UI language’s separators', () => {
		const usd = (amount: string, locale: 'id' | 'en') =>
			transactionSummary(
				form([
					['walletId', 'w-usd'],
					['amount', amount]
				]),
				wallets,
				locale
			).amountMinor;
		expect(usd('12,50', 'id')).toBe(1250);
		expect(usd('1,250.50', 'en')).toBe(125_050);
	});
	it('an empty amount is null, not 0', () => {
		expect(transactionSummary(form([['walletId', 'w-usd']]), wallets, 'id')).toMatchObject({
			amountMinor: null,
			currency: 'USD'
		});
	});
});

describe('voiceSummary', () => {
	const rows = (second: string): [string, string][] => [
		['count', '2'],
		['amount.0', '25.000'],
		['walletId.0', 'w-idr'],
		['title.0', 'kopi'],
		['amount.1', '5.000'],
		['walletId.1', second],
		['title.1', 'parkir']
	];
	it('sums rows of one currency', () => {
		expect(voiceSummary(form(rows('w-idr')), wallets, 'id')).toEqual({
			title: 'kopi',
			amountMinor: 3_000_000,
			currency: 'IDR',
			count: 2
		});
	});
	it('never sums across currencies', () => {
		expect(voiceSummary(form(rows('w-usd')), wallets, 'id')).toMatchObject({
			amountMinor: null,
			count: 2
		});
	});
});
