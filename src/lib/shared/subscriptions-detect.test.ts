import { describe, expect, it } from 'vitest';
import { addDays } from './dates.ts';
import {
	buildCandidates,
	CANDIDATES_MAX,
	candidateFormValues,
	catalogueMatch,
	exclusionKeys,
	groupByMerchantKey,
	guessCadence,
	SOURCE_ROWS_MAX,
	type ExpenseRow
} from './subscriptions-detect.ts';

let n = 0;
const row = (title: string | null, occurredOn: string, amountMinor = 5_000_000, currency = 'IDR') =>
	({ id: `t${++n}`, title, amountMinor, currency, occurredOn }) satisfies ExpenseRow;
/** Rows of one merchant on `start` plus each offset (days), newest first like the server reads them. */
const series = (title: string, start: string, offsets: number[], amountMinor = 5_000_000) =>
	[0, ...offsets]
		.reduce<string[]>((dates, gap) => [...dates, addDays(dates.at(-1) ?? start, gap)], [])
		.map((d) => row(title, d, amountMinor))
		.reverse();
const none = new Set<string>();

describe('guessCadence', () => {
	it('weekly 6–8, monthly 27–32, yearly 358–372 days; every gap must fit one cadence', () => {
		expect(guessCadence(['2026-01-01', '2026-01-07'])).toBe('weekly');
		expect(guessCadence(['2026-01-01', '2026-01-09'])).toBe('weekly');
		expect(guessCadence(['2026-01-01', '2026-01-10'])).toBeNull();
		// 28 February → 31 March is 31 days; 31 January → 28 February is 28.
		expect(guessCadence(['2026-01-31', '2026-02-28', '2026-03-31'])).toBe('monthly');
		expect(guessCadence(['2026-01-01', '2026-01-28'])).toBe('monthly');
		expect(guessCadence(['2026-01-01', '2026-01-27'])).toBeNull();
		expect(guessCadence(['2026-01-01', '2026-02-02'])).toBe('monthly');
		expect(guessCadence(['2026-01-01', '2026-02-03'])).toBeNull();
		expect(guessCadence(['2025-01-10', '2026-01-03'])).toBe('yearly');
		expect(guessCadence(['2025-01-10', '2026-01-02'])).toBeNull();
		expect(guessCadence(['2025-01-10', '2026-01-17'])).toBe('yearly');
		expect(guessCadence(['2025-01-10', '2026-01-18'])).toBeNull();
	});

	it('one date, a same-day repeat and mixed gaps fit nothing', () => {
		expect(guessCadence([])).toBeNull();
		expect(guessCadence(['2026-01-01'])).toBeNull();
		expect(guessCadence(['2026-01-01', '2026-01-01'])).toBeNull();
		expect(guessCadence(['2026-01-01', '2026-01-11', '2026-02-20'])).toBeNull();
		expect(guessCadence(['2026-01-01', '2026-01-08', '2026-02-07'])).toBeNull();
	});
});

describe('catalogueMatch (known names)', () => {
	it('finds a bill-shaped service as whole words anywhere in the key', () => {
		expect(catalogueMatch('netflix')?.id).toBe('netflix');
		expect(catalogueMatch('bayar netflix com')?.id).toBe('netflix');
		expect(catalogueMatch('langganan spotify premium')?.id).toBe('spotify');
		expect(catalogueMatch('disney hotstar')?.id).toBe('disney-hotstar');
		expect(catalogueMatch('token pln')?.id).toBe('pln');
		expect(catalogueMatch('tagihan pdam tirta')?.id).toBe('pdam');
	});

	it('never a substring, a membership in Lainnya, or a short everyday word inside a longer title', () => {
		expect(catalogueMatch('netflixer')).toBeNull();
		expect(catalogueMatch('gopay plus')).toBeNull();
		expect(catalogueMatch('grabunlimited')).toBeNull();
		expect(catalogueMatch('kaos xl hitam')).toBeNull();
		expect(catalogueMatch('tri wahyuni')).toBeNull();
		expect(catalogueMatch('xl')?.id).toBe('xl');
		expect(catalogueMatch('tri')?.id).toBe('tri');
		expect(catalogueMatch('')).toBeNull();
	});
});

describe('groupByMerchantKey', () => {
	it('groups by the FN-20 cleaned key; known names under one catalogue key; keyless rows dropped', () => {
		const groups = groupByMerchantKey([
			row('NETFLIX.COM', '2026-03-01'),
			row('Bayar Netflix', '2026-02-01'),
			row('QRIS*KOPI KENANGAN JKT 0812 3456 7890', '2026-03-02'),
			row('Kopi Kenangan', '2026-03-03'),
			row(null, '2026-03-04'),
			row('0812 3456', '2026-03-05')
		]);
		expect([...groups.keys()].sort()).toEqual(['cat:netflix', 'kopi kenangan']);
		expect(groups.get('cat:netflix')!.rows.map((r) => r.occurredOn)).toEqual([
			'2026-03-01',
			'2026-02-01'
		]);
		expect(groups.get('kopi kenangan')!.name).toBe('Kopi Kenangan');
	});
});

describe('buildCandidates', () => {
	it('a known name counts after one charge, with that row’s own amount and a monthly guess', () => {
		const r = row('Netflix', '2026-03-05', 18_600_000);
		expect(buildCandidates([r], none)).toEqual([
			{
				matchKey: 'cat:netflix',
				name: 'Netflix',
				catalogueId: 'netflix',
				category: 'streaming',
				amountMinor: 18_600_000,
				currency: 'IDR',
				cadence: 'monthly',
				lastOccurredOn: '2026-03-05',
				sourceRows: [
					{
						id: r.id,
						occurredOn: '2026-03-05',
						amountMinor: 18_600_000,
						currency: 'IDR',
						title: 'Netflix'
					}
				]
			}
		]);
	});

	it('an unknown merchant with the same amount about a month apart is a monthly candidate', () => {
		const rows = series('Kos Bu Ani', '2026-01-03', [31, 28]);
		const [c] = buildCandidates(rows, none);
		expect(c).toMatchObject({
			matchKey: 'kos bu ani',
			name: 'Kos Bu Ani',
			catalogueId: null,
			category: null,
			cadence: 'monthly',
			amountMinor: 5_000_000,
			lastOccurredOn: '2026-03-03'
		});
		expect(c!.sourceRows.map((s) => s.id)).toEqual(rows.map((r) => r.id));
	});

	it('weekly payments to one merchant are a weekly candidate', () => {
		expect(buildCandidates(series('Laundry Bersih', '2026-03-01', [7, 7, 8]), none)).toMatchObject([
			{ matchKey: 'laundry bersih', cadence: 'weekly' }
		]);
	});

	it('gaps of 10 and 40 days, a one-off and a drifting amount are never candidates', () => {
		expect(buildCandidates(series('Toko Maju', '2026-01-01', [10, 40]), none)).toEqual([]);
		expect(buildCandidates([row('Toko Maju', '2026-03-01')], none)).toEqual([]);
		expect(
			buildCandidates(
				[
					row('Warung Sate', '2026-03-01', 5_000_000),
					row('Warung Sate', '2026-01-30', 5_100_000),
					row('Warung Sate', '2025-12-30', 4_900_000)
				],
				none
			)
		).toEqual([]);
		// The same amount in another currency is another amount.
		expect(
			buildCandidates(
				[row('Hosting Kecil', '2026-03-01', 500, 'USD'), row('Hosting Kecil', '2026-01-30', 500)],
				none
			)
		).toEqual([]);
	});

	it('the run with the newest charge wins when a merchant has several amounts', () => {
		const rows = [
			row('Gym Sehat', '2026-03-10', 30_000_000),
			row('Gym Sehat', '2026-03-05', 1_500_000),
			row('Gym Sehat', '2026-02-08', 30_000_000),
			row('Gym Sehat', '2026-01-09', 30_000_000)
		];
		const [c] = buildCandidates(rows, none);
		expect(c).toMatchObject({ amountMinor: 30_000_000, cadence: 'monthly' });
		expect(c!.sourceRows.map((s) => s.occurredOn)).toEqual([
			'2026-03-10',
			'2026-02-08',
			'2026-01-09'
		]);
	});

	it('a known name keeps its pattern cadence and shows its newest amount', () => {
		const rows = series('Spotify', '2026-03-01', [7, 7], 5_499_000);
		expect(buildCandidates(rows, none)).toMatchObject([
			{ matchKey: 'cat:spotify', cadence: 'weekly', category: 'musik' }
		]);
	});

	it('excluded keys (live subscriptions, dismissals) never come back', () => {
		const rows = [row('Netflix', '2026-03-05'), ...series('Kos Bu Ani', '2026-01-03', [31, 28])];
		expect(buildCandidates(rows, new Set(['cat:netflix', 'kos bu ani']))).toEqual([]);
	});

	it(`caps at ${SOURCE_ROWS_MAX} source rows (newest first) and ${CANDIDATES_MAX} candidates`, () => {
		const weekly = series('Cuci Mobil', '2026-01-01', [7, 7, 7, 7, 7, 7, 7, 7]);
		const [c] = buildCandidates(weekly, none);
		expect(c!.sourceRows).toHaveLength(SOURCE_ROWS_MAX);
		expect(c!.sourceRows.map((s) => s.id)).toEqual(
			weekly.slice(0, SOURCE_ROWS_MAX).map((r) => r.id)
		);
		const many = Array.from({ length: 30 }, (_, i) =>
			series(
				`Toko ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
				addDays('2026-01-01', i),
				[30]
			)
		).flat();
		const out = buildCandidates(many, none);
		expect(out).toHaveLength(CANDIDATES_MAX);
		// Newest last charge first.
		expect(out[0]!.lastOccurredOn >= out.at(-1)!.lastOccurredOn).toBe(true);
	});
});

describe('exclusionKeys', () => {
	it('a live subscription excludes its cleaned name and the catalogue entry it is or names', () => {
		expect(
			[
				...exclusionKeys([
					{ name: 'Netflix Keluarga', catalogueId: null },
					{ name: 'Spotify', catalogueId: 'spotify' },
					{ name: 'Kos Bu Ani', catalogueId: null }
				])
			].sort()
		).toEqual(['cat:netflix', 'cat:spotify', 'kos bu ani', 'netflix keluarga', 'spotify']);
	});
});

describe('candidateFormValues (add prefill)', () => {
	it('copies name, category, the latest amount and currency, cadence and the billing day of the last date', () => {
		const [netflix] = buildCandidates([row('Netflix', '2026-03-05', 18_600_000)], none);
		expect(candidateFormValues(netflix!, 'id')).toEqual({
			catalogueId: 'netflix',
			name: 'Netflix',
			category: 'streaming',
			amount: '186.000',
			currency: 'IDR',
			cycle: 'monthly',
			day: '5',
			// 2026-03-05 is a Thursday.
			weekday: '4',
			month: '3',
			walletId: '',
			reminderDays: '2'
		});
	});

	it('a pattern-only candidate goes to Lainnya with no catalogue id; cents and long names follow the form', () => {
		const long = `Langganan ${'Sangat Panjang '.repeat(6)}Sekali`;
		const [c] = buildCandidates(
			[row(long, '2026-03-31', 1_250, 'USD'), row(long, '2026-02-28', 1_250, 'USD')],
			none
		);
		const values = candidateFormValues(c!, 'en');
		expect(values).toMatchObject({
			catalogueId: '',
			category: 'lainnya',
			amount: '12.50',
			currency: 'USD',
			cycle: 'monthly',
			day: '31',
			month: '3'
		});
		expect(Array.from(values.name).length).toBeLessThanOrEqual(60);
	});
});
