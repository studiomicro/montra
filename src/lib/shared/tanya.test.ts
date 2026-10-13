import { describe, expect, it } from 'vitest';
import { cleanQuestion, parseCards, TANYA_QUESTION_MAX, type TanyaCard } from './tanya';

describe('cleanQuestion (criterion 13)', () => {
	it('strips control and zero-width characters, collapses whitespace and normalises', () => {
		expect(cleanQuestion('  Bulan​ lalu\u0000 habis\n\tberapa? ')).toBe('Bulan lalu habis berapa?');
		expect(cleanQuestion('Café')).toBe('Café');
	});

	it('caps at 500 characters, a huge input included', () => {
		expect(Array.from(cleanQuestion('a'.repeat(10_000))).length).toBe(TANYA_QUESTION_MAX);
		expect(cleanQuestion('​​')).toBe('');
	});
});

describe('parseCards', () => {
	const card: TanyaCard = {
		title: 'Ringkasan',
		period: { from: '2026-10-01', to: '2026-10-31' },
		rows: [{ label: 'Pengeluaran', value: 'Rp 25.000' }],
		chart: { type: 'bars', currency: 'IDR', bars: [{ label: 'Okt', minor: 2_500_000 }] }
	};

	it('reads stored cards back', () => {
		expect(parseCards(JSON.stringify([card]))).toEqual([card]);
	});

	it('shows no card rather than an invalid one', () => {
		expect(parseCards(null)).toEqual([]);
		expect(parseCards('{')).toEqual([]);
		expect(parseCards(JSON.stringify([{ ...card, extra: 1 }]))).toEqual([]);
		expect(
			parseCards(JSON.stringify([{ ...card, rows: [{ label: 'x', value: 'y', html: '<b>' }] }]))
		).toEqual([]);
		expect(
			parseCards(
				JSON.stringify([
					{ ...card, chart: { type: 'bars', currency: 'IDR', bars: [{ label: 'a', minor: 1.5 }] } }
				])
			)
		).toEqual([]);
	});
});
