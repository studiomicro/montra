import { describe, expect, it } from 'vitest';
import { guardAnswer } from './answer-guard';
import { FigureBook } from './figures';
import { TANYA_FIGURES_ONLY } from './messages';

// Criteria 9 and 10: only server figures reach the page; prose with an unverified number is dropped.

function book() {
	const b = new FigureBook('id');
	const ids = [
		b.money('expense', 2_500_000, 'IDR')!.id, // Rp 25.000
		b.money('refund', -2_500_000, 'IDR')!.id, // −Rp 25.000
		b.percent('change', 12)!.id // 12%
	];
	return { b, ids };
}

/** Model text with `{1}`… `{3}` standing for the book's ids, as `[[f:ID]]`. */
function guard(text: string) {
	const { b, ids } = book();
	return guardAnswer(
		text.replace(/\{(\d)\}/g, (_, n: string) => `[[f:${ids[Number(n) - 1]}]]`),
		b
	);
}

describe('guardAnswer', () => {
	it('replaces placeholders with the server-formatted figure', () => {
		const r = guard('Bulan lalu kamu habis {1} untuk kopi, naik {3}.');
		expect(r).toEqual({
			kind: 'prose',
			text: 'Bulan lalu kamu habis Rp\u00a025.000 untuk kopi, naik 12%.'
		});
		expect(guard('Refund {2}.').text).toBe('Refund −Rp\u00a025.000.');
	});

	it.each([
		['Rp', 'Kamu habis Rp 25.000 untuk kopi.'],
		['rp without a space', 'Totalnya rp25000.'],
		['four digits', 'Kamu habis 25000 untuk kopi.'],
		['grouped digits', 'Kamu habis 25.000 untuk kopi.'],
		['comma groups', 'Total 1,250 tadi.'],
		['percent', 'Naik 15% dari bulan lalu.'],
		['ribu', 'Kira-kira 25 ribu.'],
		['rb', 'Kira-kira 25rb.'],
		['jt', 'Hampir 1,5 jt.'],
		['IDR', 'Total IDR {1}.'],
		['an unknown id', 'Kamu habis [[f:99]].'],
		['an id in another case', 'Kamu habis [[f:ABC]].'],
		['only placeholders', '{1}']
	])('drops prose with %s', (_, text) => {
		expect(guard(text)).toEqual({ kind: 'figures_only', text: TANYA_FIGURES_ONLY });
	});

	it('keeps dates, years and small counts', () => {
		const r = guard('Dari 2026-10-01 sampai Oktober 2026 ada 12 transaksi, totalnya {1}.');
		expect(r.kind).toBe('prose');
	});

	it('an id from another question never resolves', () => {
		const { ids } = book();
		const other = new FigureBook('id');
		other.money('expense', 100, 'IDR');
		expect(guardAnswer(`Totalnya [[f:${ids[0]}]].`, other).kind).toBe('figures_only');
	});

	it('S3: ids are random, so a guessed small number or a stale id never resolves', () => {
		const a = book();
		const b = book();
		expect(a.ids.some((id) => b.ids.includes(id))).toBe(false);
		for (const id of a.ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
		expect(guardAnswer('Totalnya [[f:1]].', a.b).kind).toBe('figures_only');
	});

	it('strips control and invisible characters, keeps line breaks, caps the length', () => {
		const r = guard('Halo\u0000​ dunia\n\nBaris dua‮');
		expect(r).toEqual({ kind: 'prose', text: 'Halo dunia\n\nBaris dua' });
		expect(Array.from(guard('a '.repeat(5000)).text).length).toBeLessThanOrEqual(4000);
	});

	it('S1: strips invisible characters before the number checks', () => {
		expect(guard('Saldo kamu R\u200bp 1\u200b250\u200b000.')).toEqual({
			kind: 'figures_only',
			text: TANYA_FIGURES_ONLY
		});
	});

	it.each([
		['word joiners', 'Saldo R\u2060p 9\u20609\u2060999\u2060999.'],
		['soft hyphens', 'Saldo R\u00adp 1\u00ad250.'],
		['fullwidth digits', 'Saldo １２５０ hari ini.'],
		['fullwidth Rp', 'Saldo Ｒｐ ９.'],
		['superscript digits', 'Saldo ¹²⁵⁰⁰⁰⁰.'],
		['Cyrillic р in Rp', 'Saldo Rр 999.'],
		['Greek ρ in Rp', 'Saldo Rρ 999.'],
		['space groups', 'Saldo 1 250 000.'],
		['NBSP groups', 'Saldo 1\u00a0250\u00a0000.'],
		['thin-space groups', 'Saldo 1\u2009250.'],
		['apostrophe groups', "Saldo 1'250'000."],
		['a dollar sign', 'Saldo $999.'],
		['a euro sign', 'Saldo 9 €.'],
		['a currency word', 'Saldo 9 dollars.'],
		['million', 'Sekitar 1.5 million.'],
		['jutaan', 'Sekitar 3 jutaan.'],
		['ribuan', 'Sekitar 50 ribuan.'],
		['milyar', 'Sekitar 2 milyar.'],
		['miliar', 'Sekitar 2 miliar.'],
		['a decimal', 'Sekitar 1,5 dari itu.'],
		['spelled out', 'Saldo dua juta lima ratus ribu.'],
		['se- prefix', 'Saldo sejuta.'],
		['spelled-out English', 'About two thousand.'],
		['persen', 'Naik 20 persen.'],
		['a digit glued to a figure', 'Kamu habis {1}000.'],
		...[
			'Rp 1.250.000',
			'1.250.000,50',
			'Rp 28.000,00',
			'IDR 1,250,000.00',
			'25rb',
			'25k',
			'1,5 jt',
			'2 ceban',
			'goceng',
			'gopek',
			'cepek',
			'goban',
			'-25.000'
		].map((v) => [`checklist vector ${v}`, `Kira-kira ${v} saja.`] as [string, string])
	])('S2: drops prose with %s', (_, text) => {
		expect(guard(text)).toEqual({ kind: 'figures_only', text: TANYA_FIGURES_ONLY });
	});

	it('renders the normalised text, never the raw invisible or fullwidth characters', () => {
		expect(guard('Ada １２ transaksi\u200b, totalnya {1}.')).toEqual({
			kind: 'prose',
			text: 'Ada 12 transaksi, totalnya Rp\u00a025.000.'
		});
	});

	it('empty model text shows the figures only', () => {
		expect(guard('   ').kind).toBe('figures_only');
	});
});

// Red team cycle 2 (S8-S10): the guard is an allowlist now, so every vector below must drop the prose.
describe('guardAnswer allowlist (S8-S10)', () => {
	it.each([
		['S8 combining grapheme joiner', 'Saldo R͏p 1͏250͏000'],
		['S8 variation selector', 'Saldo 1️250️000'],
		['S8 supplementary variation selector', 'Saldo 1\u{e0100}250\u{e0100}000'],
		['S8 Ogham space', 'Saldo 1 250 000'],
		['S8 braille blank', 'Saldo 1⠀250⠀000'],
		['S8 Hangul filler', 'Saldo 1ㅤ250ㅤ000'],
		['S8 middle dot', 'Saldo 1·250·000'],
		['S8 Arabic thousands separator', 'Saldo 1٬250٬000'],
		['S8 Unicode hyphen', 'Saldo 1‐250‐000'],
		['S8 visible acute accent', 'Saldo 1́250́000'],
		['S8 combining low line', 'Saldo 1̲250̲000'],
		['S8 Arabic-Indic digits', 'Saldo ١٢٥'],
		['S8 Cyrillic letter', 'Saldo Rр 999'],
		['S8 letter O as zero', 'Saldo 1.OOO.OOO'],
		['S8 split groups', 'Saldo 1 250 000'],
		['S8 R p with a space', 'Saldo R p 9'],
		['S9 digits after a figure', 'Saldo {1} 000'],
		['S9 digits after a figure behind punctuation', 'Saldo {1}, 000'],
		['S9 digits before a figure', 'Saldo 9 {1}'],
		['S9 minus before a figure', 'Saldo -{1}'],
		['S9 minus and space before a figure', 'Saldo - {1}'],
		['S9 en dash before a figure', 'Saldo –{1}'],
		['S9 Unicode minus before a figure', 'Saldo −{1}'],
		['S9 plus before a figure', 'Saldo +{1}'],
		['S10 grand', 'Kira-kira 5 grand.'],
		['S10 lakh', 'Kira-kira 12 lakh.'],
		['S10 crore', 'Kira-kira 2 crore.'],
		['S10 yen', 'Kira-kira 900 yen.'],
		['S10 ringgit', 'Kira-kira 90 ringgit.'],
		['S10 won', 'Kira-kira 900 won.'],
		['S10 pounds', 'Kira-kira 9 pounds.'],
		['S10 rupees', 'Kira-kira 9 rupees.'],
		['a 4-digit non-year', 'Ada 1250 transaksi.'],
		['digit ranges', 'Ada 1-3 transaksi.'],
		['an emoji', 'Saldo aman \u{1f4b0}'],
		['a percent sign', 'Naik 5 %.']
	])('drops prose with %s', (_, text) => {
		expect(guard(text)).toEqual({ kind: 'figures_only', text: TANYA_FIGURES_ONLY });
	});

	it.each([
		'Di Oktober 2026 kamu habis {1} untuk Makan & Minum.',
		'Pukul 23:30 WIB ada 2 transaksi: {1} dan {2}.',
		'Pengeluaranmu {1} – {2} per minggu — naik {3}.',
		'“Kopi” jadi kategori terbesar (Rumah Tangga kedua).\n• Kopi: {1}\n- Bensin: {2}',
		'Café dan crème brûlée: {1}.'
	])('keeps ordinary prose %s', (text) => {
		expect(guard(text).kind).toBe('prose');
	});

	it('property: random code points inserted into "Rp 1250000" never yield a shown amount', () => {
		let seed = 0x9e3779b9;
		const rand = () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return (seed >>> 0) / 0x100000000;
		};
		// Half the draws come from ranges that look like separators, marks or digits; the rest from all of Unicode.
		const hot: [number, number][] = [
			[0x20, 0x7e],
			[0x80, 0x24f],
			[0x300, 0x36f],
			[0x600, 0x6ff],
			[0x1680, 0x1680],
			[0x2000, 0x206f],
			[0x2800, 0x2800],
			[0x3000, 0x3164],
			[0xfe00, 0xfe0f],
			[0xff00, 0xffef],
			[0xe0100, 0xe01ef]
		];
		const codePoint = () => {
			if (rand() < 0.5) {
				const [lo, hi] = hot[Math.floor(rand() * hot.length)] ?? [0, 0];
				return lo + Math.floor(rand() * (hi - lo + 1));
			}
			return Math.floor(rand() * 0x110000);
		};
		const { b } = book();
		let prose = 0;
		for (let i = 0; i < 20000; i++) {
			const chars = Array.from('Rp 1250000');
			const inserts = 1 + Math.floor(rand() * 6);
			for (let k = 0; k < inserts; k++)
				chars.splice(Math.floor(rand() * (chars.length + 1)), 0, String.fromCodePoint(codePoint()));
			const r = guardAnswer(chars.join(''), b);
			if (r.kind === 'figures_only') continue;
			prose++;
			const shown = r.text.normalize('NFKC');
			expect(shown.replace(/[^\p{L}\p{N}\n]/gu, ''), chars.join('')).not.toMatch(/\p{N}{4,}/u);
			expect(shown, chars.join('')).not.toMatch(/\p{Sc}|\br\W{0,3}p\b|\p{N}\W{0,3}\p{N}/iu);
		}
		expect(prose).toBeLessThan(20000);
	});

	it('stays linear on long adversarial input', () => {
		const { b, ids } = book();
		const mark = `[[f:${ids[0]}]]`;
		const inputs = [
			'- '.repeat(4000),
			' '.repeat(7999) + '-',
			'-' + ' '.repeat(7999),
			'1 '.repeat(4000),
			'1.'.repeat(4000),
			'a1'.repeat(4000),
			`${mark} `.repeat(500),
			`- ${mark} `.repeat(400),
			'se'.repeat(4000),
			'͏'.repeat(8000),
			'r'.repeat(8000)
		];
		for (const input of inputs) {
			const start = performance.now();
			guardAnswer(input, b);
			expect(performance.now() - start).toBeLessThan(50);
		}
	});
});

describe('FN-47: TWD and HKD figures', () => {
	it('a TWD or HKD amount from the records (a placeholder) is shown, formatted by the server', () => {
		const b = new FigureBook('id');
		const twd = b.money('expense', 14_950, 'TWD')!.id;
		const hkd = b.money('expense', 123_456, 'HKD')!.id;
		expect(guardAnswer(`Langganan [[f:${twd}]] dan belanja [[f:${hkd}]].`, b)).toEqual({
			kind: 'prose',
			text: 'Langganan TWD 149,50 dan belanja HKD 1.234,56.'
		});
	});

	it.each(['Total TWD {1}.', 'Total hkd {1}.', 'Total CNY {1}.'])(
		'drops prose naming a currency code itself, like cny: %j',
		(text) => {
			expect(guard(text)).toEqual({ kind: 'figures_only', text: TANYA_FIGURES_ONLY });
		}
	);
});

describe('FN-47 red team L3: RMB, NT, HK, sen and cents', () => {
	it.each([
		'Kamu habis RMB 500 bulan ini.',
		'Kamu habis 500 RMB bulan ini.',
		'Kamu habis NTD 900 bulan ini.',
		'Kamu habis 900 NTD bulan ini.',
		'Kamu habis NT 900 bulan ini.',
		'Kamu habis 900 NT bulan ini.',
		'Kamu habis HK 900 bulan ini.',
		'Kamu habis 900 HK bulan ini.',
		'Kamu habis HK$ 900 bulan ini.',
		'Kamu habis renminbi 500 bulan ini.',
		'Kamu habis 500 sen bulan ini.',
		'You spent 900 cents this month.',
		'You spent 1 cent on it.',
		'Total {1}, sisa RMB.'
	])('drops prose with a made-up amount in that unit: %j', (text) => {
		expect(guard(text)).toEqual({ kind: 'figures_only', text: TANYA_FIGURES_ONLY });
	});

	it.each([
		'Kamu habis {1}, beberapa persen dari gajimu.',
		'Belanja kamu naik {3}, persentasenya kecil.',
		'Kamu mencatat 3 transaksi sendiri hari Senin, total {1}.',
		'Ada 2 kategori yang sensitif, total {1}.',
		'Kamu menabung sendiri {1} untuk seni.'
	])('keeps ordinary Indonesian prose with "sen" inside a word: %j', (text) => {
		expect(guard(text).kind).toBe('prose');
	});
});

// Red team cycle 3 (S11, S12) and FN-47 red team L4: resolved 2026-10-13.
describe('guardAnswer lookalikes, re-signed figures and spaced codes (S11, S12, FN-47 L4)', () => {
	it.each([
		['S11 letters after a figure', 'Saldo kamu {1}.OOO'],
		['S11 slashed zeros after a figure', 'Saldo kamu {1}.ØØØ'],
		['S11 spaced letters after a figure', 'Saldo kamu {1} OOO'],
		['S11 slashed zeros and l', 'Saldo kamu lØ.ØØØ.ØØØ'],
		['S11 S and O groups', 'Saldo kamu SOO.OOO'],
		['S11 perak', 'Saldo kamu l.OOO.OOO perak'],
		['S11 rupiyah', 'Saldo kamu l.OOO.OOO rupiyah'],
		['S11 rb', 'Saldo kamu SOO rb'],
		['S11 rbu', 'Sisa SOO rbu'],
		['S11 jt', 'Sisa lO jt'],
		['S11 noceng', 'Sisa noceng'],
		['S11 mil', 'Sisa SOO mil'],
		['S11 digit then letter groups', 'Saldo kamu 1 OOO OOO'],
		['S11 digits then a letter group', 'Saldo kamu 250. OOO'],
		['S11 R-p', 'Saldo kamu R-p 999'],
		['S11 R with cedilla', 'Saldo kamu Ŗp l.OOO.OOO'],
		['S11 thorn', 'Saldo kamu Rþ 999'],
		['S12 minus word', 'Pemasukan minus {1}'],
		['S12 kurang', 'Saldo kurang {1}'],
		['S12 negatif', 'Saldo negatif {1}'],
		['S12 letter then dash', 'Pemasukan a-{1}'],
		['S12 glued figures', 'Selisih {1}{2}'],
		['S12 figures glued by a space', 'Selisih {1} {2}'],
		['S12 times', 'Total {1} x 10'],
		['S12 times in words', 'Total {1} x dua'],
		['S12 kali', 'Total {1} kali 3'],
		['FN-47 L4 R M B', 'Kamu habis R M B 500.'],
		['FN-47 L4 C N Y', 'Kamu habis C N Y 500.'],
		['FN-47 L4 U S D', 'Kamu habis U S D 50.']
	])('drops prose with %s', (_, text) => {
		expect(guard(text)).toEqual({ kind: 'figures_only', text: TANYA_FIGURES_ONLY });
	});

	it.each([
		'Bos, totalnya {1} untuk Sosis dan Bakso.',
		'Pengeluaranmu {1} – {2} per minggu.',
		'Kategori terbesar: Makan ({3} dari bulan lalu naik).',
		'Ada 2 transaksi di Toko OOO, totalnya {1}.',
		'Belanja di IKEA dan H&M: {1}.',
		'Di Oktober 2026 kamu habis {1} untuk kopi.'
	])('keeps ordinary prose %s', (text) => {
		expect(guard(text).kind).toBe('prose');
	});
});

// fix-lows-services red team N2 (cycle 2): spelled-out codes and units, lookalike digit runs and more sign or scale
// words are folded before the checks, so variants fail like the originals.
describe('guardAnswer cycle 2 (red team N2)', () => {
	it.each([
		'Kamu habis R–p 500.',
		'Kamu habis R—p 500.',
		'Saldo I.D.R 500.',
		'Saldo U.S.D. 50.',
		'Saldo 50 r b.',
		'Saldo 50 j t.',
		'Saldo 50 r.b.',
		'Saldo l OOO OOO.',
		'Saldo SOO OOO.',
		'Saldo lOOOOOO.',
		'Saldo (-) {1}.',
		'Saldo (+) {1}.',
		'Gajimu min {1}',
		'Saldo defisit {1}.',
		'Gajimu {1} dikali 12.',
		'Saldo kurang {1}.'
	])('drops prose with %s', (text) => {
		expect(guard(text)).toEqual({ kind: 'figures_only', text: TANYA_FIGURES_ONLY });
	});

	it.each([
		'Kamu kurang {1} lagi dari anggaran.',
		'Kategori A, B dan C naik bulan ini, totalnya {1}.',
		'Kebun Binatang Zoo dan Toko OOO Jaya: {1}.',
		'Ada 3 transaksi di Indomaret, totalnya {1}.'
	])('keeps %s', (text) => {
		expect(guard(text).kind).toBe('prose');
	});
});
