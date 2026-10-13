import { describe, expect, it } from 'vitest';
import { cleanMoneyText } from './money-parse.ts';
import {
	highlightMoney,
	parseVoiceSentence,
	walletHintFromText,
	type VoiceContext,
	type VoiceDraftCandidate
} from './voice-parse.ts';

const none: VoiceContext = { wallets: [] };
const parse = (text: string, ctx: VoiceContext = none) => parseVoiceSentence(text, ctx);
const pick = (c: VoiceDraftCandidate[]) => c.map(({ title, amountMinor }) => [title, amountMinor]);

describe('parseVoiceSentence — the acceptance journey', () => {
	it('"kopi 25rb dan parkir goceng" → two expense candidates (criterion 1)', () => {
		expect(parse('kopi 25rb dan parkir goceng')).toEqual([
			{ title: 'kopi', amountMinor: 2_500_000, type: 'expense', categoryHint: 'kopi' },
			{ title: 'parkir', amountMinor: 500_000, type: 'expense', categoryHint: 'transportasi' }
		]);
	});

	it('gives byte-identical output for the same text every time (one function, two inputs)', () => {
		const a = JSON.stringify(parse('kopi 25rb dan parkir goceng'));
		const b = JSON.stringify(parse('kopi 25rb dan parkir goceng'));
		expect(a).toBe(b);
	});
});

describe('segmentation', () => {
	it.each(['dan', 'terus', 'lalu', 'plus', 'DAN'])(
		'separator "%s" splits and is stripped',
		(sep) => {
			expect(pick(parse(`kopi 25rb ${sep} parkir goceng`))).toEqual([
				['kopi', 2_500_000],
				['parkir', 500_000]
			]);
		}
	);

	it('a comma splits and is stripped', () => {
		expect(pick(parse('kopi 25rb, parkir goceng'))).toEqual([
			['kopi', 2_500_000],
			['parkir', 500_000]
		]);
		expect(pick(parse('kopi 25rb ,parkir goceng'))).toEqual([
			['kopi', 2_500_000],
			['parkir', 500_000]
		]);
	});

	it('two amounts with no separator still split on the mention boundaries (criterion 4)', () => {
		expect(pick(parse('kopi 25rb parkir goceng'))).toEqual([
			['kopi', 2_500_000],
			['parkir', 500_000]
		]);
	});

	it('words before the first separator of a gap stay with the earlier item', () => {
		expect(pick(parse('kopi 25rb di kantor, parkir goceng'))).toEqual([
			['kopi di kantor', 2_500_000],
			['parkir', 500_000]
		]);
	});

	it('words after the last amount join it, up to a separator', () => {
		expect(pick(parse('beli 2 ceban kopi'))).toEqual([['beli kopi', 2_000_000]]);
		expect(pick(parse('kopi 25rb dan roti'))).toEqual([['kopi', 2_500_000]]);
	});

	it('three items, mixed slang and units', () => {
		expect(pick(parse('makan 1,5 jt terus bensin 50.000 lalu parkir gopek'))).toEqual([
			['makan', 150_000_000],
			['bensin', 5_000_000],
			['parkir', 50_000]
		]);
	});

	it('an item may have no words at all', () => {
		expect(pick(parse('25rb dan goceng'))).toEqual([
			['', 2_500_000],
			['', 500_000]
		]);
	});
});

describe('quantities (criterion 5)', () => {
	it('"beli 2 kopi 50rb" → one candidate, the quantity stays in the title', () => {
		expect(pick(parse('beli 2 kopi 50rb'))).toEqual([['beli 2 kopi', 5_000_000]]);
	});
	it('"beli 2 ceban kopi" → the multiplier attaches to the slang word', () => {
		expect(parse('beli 2 ceban kopi')[0]?.amountMinor).toBe(2_000_000);
	});
});

describe('wallet words (criterion 6)', () => {
	const ctx: VoiceContext = {
		wallets: [
			{ id: 'w1', name: 'GoPay', type: 'e_wallet' },
			{ id: 'w2', name: 'Dompet', type: 'tunai' },
			{ id: 'w3', name: 'BCA Kartu', type: 'kartu_kredit' },
			{ id: 'w4', name: 'BCA', type: 'bank' }
		]
	};

	it('an own wallet name attaches its id and leaves the title', () => {
		const [c] = parse('bayar kopi pakai gopay 25rb', ctx);
		expect(c?.walletHint).toBe('w1');
		expect(c?.title).toBe('bayar kopi');
	});

	it('an item with no wallet word has no hint', () => {
		const out = parse('kopi 25rb pakai gopay dan parkir goceng', ctx);
		expect(out[0]?.walletHint).toBe('w1');
		expect(out[1]?.walletHint).toBeUndefined();
		expect(out[1]).not.toHaveProperty('walletHint');
	});

	it('the longest matching name wins', () => {
		expect(parse('bensin 50rb bca kartu', ctx)[0]?.walletHint).toBe('w3');
		expect(parse('bensin 50rb bca', ctx)[0]?.walletHint).toBe('w4');
	});

	it('"tunai" and "kartu kredit" name the first wallet of that type', () => {
		expect(parse('parkir goceng tunai', ctx)[0]?.walletHint).toBe('w2');
		expect(parse('bensin 50rb pakai kartu kredit', ctx)[0]?.walletHint).toBe('w3');
		expect(parse('bensin 50rb pakai kartu kredit', ctx)[0]?.title).toBe('bensin');
	});

	it('a fixed word with no wallet of its type gives no hint and stays in the title', () => {
		const [c] = parse('parkir goceng tunai', none);
		expect(c?.walletHint).toBeUndefined();
		expect(c?.title).toBe('parkir tunai');
	});

	it('a name only matches whole words', () => {
		const [c] = parse('makan bcanya 25rb', ctx);
		expect(c?.walletHint).toBeUndefined();
	});

	it('a hostile wallet name is matched as plain text, never as a pattern', () => {
		const odd: VoiceContext = { wallets: [{ id: 'x', name: '.*(a+)+$', type: 'lainnya' }] };
		expect(parse('kopi 25rb', odd)[0]?.walletHint).toBeUndefined();
		expect(parse('kopi 25rb .*(a+)+$', odd)[0]?.walletHint).toBe('x');
	});
});

describe('income words (criterion 7)', () => {
	it('"dapat gaji 5 jt" → income of Rp 5.000.000', () => {
		expect(parse('dapat gaji 5 jt')).toEqual([
			{ title: 'dapat gaji', amountMinor: 500_000_000, type: 'income' }
		]);
	});
	it.each(['bonus', 'THR', 'refund', 'cashback', 'jual'])('"%s" makes its own item income', (w) => {
		const out = parse(`${w} 100rb dan kopi 25rb`);
		expect(out.map((c) => c.type)).toEqual(['income', 'expense']);
	});
	it('a word merely containing an income word does not count', () => {
		expect(parse('penjualan kopi 25rb')[0]?.type).toBe('expense');
	});
});

describe('category hints (criterion 8)', () => {
	it('maps the fixed keywords', () => {
		expect(parse('kopi 25rb')[0]?.categoryHint).toBe('kopi');
		expect(parse('makan siang 30rb')[0]?.categoryHint).toBe('makan');
		expect(parse('parkir 5rb')[0]?.categoryHint).toBe('transportasi');
		expect(parse('bensin 50rb')[0]?.categoryHint).toBe('transportasi');
	});
	it('no keyword → no hint; an income item never gets an expense hint', () => {
		expect(parse('pulsa 50rb')[0]).not.toHaveProperty('categoryHint');
		expect(parse('jual kopi 25rb')[0]).not.toHaveProperty('categoryHint');
	});
	// FN-39: the shared keyword table widened with ride-hailing and food-delivery service words.
	it.each(['gojek', 'goride', 'gocar', 'grabbike', 'grabcar', 'maxim', 'ojol', 'grab'])(
		'"%s ke kantor 15rb" → Ojek Online',
		(w) => {
			const [c] = parse(`${w} ke kantor 15rb`);
			expect(c).toMatchObject({ amountMinor: 1_500_000, categoryHint: 'ojek-online' });
		}
	);
	it.each(['gofood', 'grabfood', 'shopeefood'])(
		'"laper nih %s 45rb" → Pesan Antar Makanan',
		(w) => {
			const [c] = parse(`laper nih ${w} 45rb`);
			expect(c).toMatchObject({ amountMinor: 4_500_000, categoryHint: 'pesan-antar-makanan' });
		}
	);
	it('an item naming both a ride and a food service is food; separate items keep their own', () => {
		expect(parse('gofood pakai grab 50rb')[0]?.categoryHint).toBe('pesan-antar-makanan');
		expect(parse('GoJek, 20rb')[0]?.categoryHint).toBe('ojek-online');
		expect(parse('grab 20rb terus gofood 50rb').map((c) => c.categoryHint)).toEqual([
			'ojek-online',
			'pesan-antar-makanan'
		]);
	});
	it('a ride-hailing refund is income and gets no expense hint', () => {
		expect(parse('refund gojek 15rb')[0]).toMatchObject({ type: 'income' });
		expect(parse('refund gojek 15rb')[0]).not.toHaveProperty('categoryHint');
	});
});

describe('untrusted input (criterion 9)', () => {
	it('zero mentions → []', () => {
		expect(parse('beli kopi')).toEqual([]);
		expect(parse('')).toEqual([]);
		expect(parse('beli 2 kopi')).toEqual([]);
		expect(parse('kopi 0rb')).toEqual([]);
	});

	it('never throws on punctuation, emoji, invisible characters or odd types', () => {
		const inputs = [
			'☕☕ kopi 25rb!!! 🚗 parkir goceng???',
			'\u200bkopi\u200b 25\u200brb\u202e dan\u0000 parkir\u2028goceng',
			'<script>alert(1)</script> 25rb',
			',,,, dan dan dan 25rb ,,,',
			'(((25rb)))',
			'Rp',
			'\ufeff'.repeat(50_000),
			'kopi 25rb '.repeat(5_000)
		];
		for (const s of inputs) expect(() => parse(s)).not.toThrow();
		expect(parse(null as unknown as string)).toEqual([]);
		expect(parse(42 as unknown as string)).toEqual([]);
	});

	it('strips invisible characters before reading', () => {
		expect(pick(parse('kopi\u200b 25\u200brb'))).toEqual([['kopi', 2_500_000]]);
	});

	it('keeps markup as plain title text, capped at 80 characters', () => {
		const [c] = parse('<b>kopi</b> 25rb');
		expect(c?.title).toBe('<b>kopi</b>');
		const long = parse(`${'a'.repeat(300)} 25rb`)[0];
		expect(Array.from(long?.title ?? '').length).toBeLessThanOrEqual(80);
	});

	it('a very long sentence is capped before parsing (bounded candidates)', () => {
		const out = parse('kopi 25rb '.repeat(5_000));
		expect(out.length).toBeLessThanOrEqual(400);
		expect(out.length).toBeGreaterThan(20);
	});
});

describe('slang vectors through the sentence path', () => {
	it.each([
		['cepek', 10_000],
		['gopek', 50_000],
		['seceng', 100_000],
		['noceng', 200_000],
		['goceng', 500_000],
		['ceban', 1_000_000],
		['goban', 5_000_000],
		['2 ceban', 2_000_000],
		['dua goban', 10_000_000],
		['25k', 2_500_000],
		['25 ribu', 2_500_000],
		['1,5 juta', 150_000_000],
		['Rp 1.250.000', 125_000_000],
		['dua puluh lima ribu', 2_500_000]
	])('"parkir %s"', (amount, minor) => {
		expect(parse(`parkir ${amount}`)).toEqual([
			{ title: 'parkir', amountMinor: minor, type: 'expense', categoryHint: 'transportasi' }
		]);
	});

	it('a negative amount is read as its magnitude', () => {
		expect(parse('refund -25rb')[0]).toEqual({
			title: 'refund',
			amountMinor: 2_500_000,
			type: 'income'
		});
	});
});

describe('highlightMoney', () => {
	it('marks exactly the amounts and joins back to the cleaned text', () => {
		const parts = highlightMoney('kopi 25rb dan parkir goceng');
		expect(parts).toEqual([
			{ text: 'kopi ', mark: false },
			{ text: '25rb', mark: true },
			{ text: ' dan parkir ', mark: false },
			{ text: 'goceng', mark: true }
		]);
		const hostile = 'a\u200b<img src=x> 25rb\u0007';
		expect(
			highlightMoney(hostile)
				.map((p) => p.text)
				.join('')
		).toBe(cleanMoneyText(hostile));
	});
	it('no amount → one plain part; empty → none', () => {
		expect(highlightMoney('beli kopi')).toEqual([{ text: 'beli kopi', mark: false }]);
		expect(highlightMoney('')).toEqual([]);
	});
});

describe("walletHintFromText (FN-15: a receipt's printed payment line)", () => {
	const wallets: VoiceContext['wallets'] = [
		{ id: 'w-bca', name: 'BCA', type: 'bank' },
		{ id: 'w-gopay', name: 'GoPay', type: 'e_wallet' },
		{ id: 'w-cash', name: 'Dompet saku', type: 'tunai' },
		{ id: 'w-cc', name: 'Visa', type: 'kartu_kredit' }
	];
	it.each([
		['DEBIT BCA ****1234', 'w-bca'],
		['GOPAY', 'w-gopay'],
		['TUNAI', 'w-cash'],
		['Cash', 'w-cash'],
		['KARTU KREDIT', 'w-cc']
	])('"%s" names %s', (text, id) => {
		expect(walletHintFromText(text, wallets)).toBe(id);
	});
	it('names nothing for QRIS, an empty line or a non-string', () => {
		expect(walletHintFromText('QRIS', wallets)).toBeUndefined();
		expect(walletHintFromText('', wallets)).toBeUndefined();
		expect(walletHintFromText(null as unknown as string, wallets)).toBeUndefined();
	});
});
