import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	IDR_SLANG,
	MONEY_TEXT_MAX,
	cleanMoneyText,
	findMoneyMentions,
	parseMoneyAmount
} from './money-parse';

// Each row is its own test case (criterion 26): [input, expected].
type Vector = [string, ReturnType<typeof parseMoneyAmount>];

describe('parseMoneyAmount — checklist money vectors and locale formats', () => {
	it.each<Vector>([
		['Rp 1.250.000', { minor: 125_000_000 }],
		['1.250.000,50', { minor: 125_000_050 }],
		['Rp 28.000,00', { minor: 2_800_000 }],
		['IDR 1,250,000.00', { minor: 125_000_000 }],
		['Rp28.000', { minor: 2_800_000 }],
		['28000', { minor: 2_800_000 }],
		['1.250.000', { minor: 125_000_000 }],
		['rp 25.000', { minor: 2_500_000 }],
		['Rp. 25.000', { minor: 2_500_000 }],
		['idr25000', { minor: 2_500_000 }],
		['Rp 25.000,-', { minor: 2_500_000 }],
		['Rp 1.264.000', { minor: 126_400_000 }], // formatMoney output with NBSP round-trips
		['1.250.000,5', { minor: 125_000_050 }],
		['28000,50', { minor: 2_800_050 }],
		['0', { minor: 0 }],
		['Rp 90.071.992.547.409,91', { minor: Number.MAX_SAFE_INTEGER }]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});
});

describe('parseMoneyAmount — separator ambiguity (Owner decision C)', () => {
	it.each<Vector>([
		['1.250', { minor: 125_000 }], // one dot + 3 digits = thousands
		['1,250', { minor: 125_000 }], // one comma + 3 digits = thousands, same as 1.250
		['1,5', { minor: 150 }], // one separator + 1–2 digits = decimal
		['1.50', { minor: 150 }],
		['1.250.00', null], // the same separator used for grouping and decimals
		['1.250,000', null], // two kinds of grouping
		['1.2500', null], // group of 4
		['12.50.000', null], // middle group of 2
		['1234.567', null], // head group longer than 3
		['1,250.000,00', null]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});
});

describe('parseMoneyAmount — negatives and DB/CR', () => {
	it.each<Vector>([
		['-25.000', { minor: -2_500_000 }],
		['(25.000)', { minor: -2_500_000 }],
		['−Rp 25.000', { minor: -2_500_000 }], // U+2212 as printed by formatMoney
		['-Rp 25.000', { minor: -2_500_000 }],
		['Rp -25.000', { minor: -2_500_000 }],
		['( Rp 25.000 )', { minor: -2_500_000 }],
		['+Rp 25.000', { minor: 2_500_000 }],
		['50.000 DB', { minor: 5_000_000, direction: 'debit' }],
		['50.000 CR', { minor: 5_000_000, direction: 'credit' }],
		['Rp 50.000,00 db', { minor: 5_000_000, direction: 'debit' }],
		['50.000CR', { minor: 5_000_000, direction: 'credit' }],
		['-0', { minor: 0 }],
		['-50.000 DB', null], // sign and direction contradict
		['(50.000) CR', null],
		['-(25.000)', null],
		['- Rp -25.000', null],
		['(25.000', null],
		['25.000)', null]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});
});

describe('parseMoneyAmount — voice slang and units', () => {
	it.each<Vector>([
		['25rb', { minor: 2_500_000 }],
		['25 ribu', { minor: 2_500_000 }],
		['25k', { minor: 2_500_000 }],
		['1,5 jt', { minor: 150_000_000 }],
		['1,5 juta', { minor: 150_000_000 }],
		['1.5jt', { minor: 150_000_000 }],
		['Rp 25rb', { minor: 2_500_000 }],
		['2,75 jt', { minor: 275_000_000 }],
		['cepek', { minor: 10_000 }],
		['gopek', { minor: 50_000 }],
		['seceng', { minor: 100_000 }],
		['noceng', { minor: 200_000 }],
		['goceng', { minor: 500_000 }],
		['ceban', { minor: 1_000_000 }],
		['goban', { minor: 5_000_000 }],
		['2 ceban', { minor: 2_000_000 }],
		['2ceban', { minor: 2_000_000 }],
		['dua ceban', { minor: 2_000_000 }],
		['3 goceng', { minor: 1_500_000 }],
		['seratus ribu', { minor: 10_000_000 }],
		['lima ribu', { minor: 500_000 }],
		['dua juta', { minor: 200_000_000 }],
		['0 ceban', null],
		['100 ceban', null], // multiplier is at most two digits
		['dua puluh ribu', { minor: 2_000_000 }], // Owner decision B changed 2026-10-08: number words supported
		['dua puluh lima ribu', { minor: 2_500_000 }], // never the partial "lima ribu"
		['2 juta 500 ribu', null], // never the partial "2 juta"
		['lima ratus ribu', { minor: 50_000_000 }],
		['25rbu', null],
		['25 ribuan', null]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});

	it('exports the seven slang values once', () => {
		expect(IDR_SLANG).toStrictEqual({
			cepek: 100,
			gopek: 500,
			seceng: 1_000,
			noceng: 2_000,
			goceng: 5_000,
			ceban: 10_000,
			goban: 50_000
		});
	});
});

describe('parseMoneyAmount — case, whitespace, robustness', () => {
	it.each<Vector>([
		['25RB', { minor: 2_500_000 }],
		['25 RB', { minor: 2_500_000 }],
		[' 25rb ', { minor: 2_500_000 }],
		['GOCENG', { minor: 500_000 }],
		['IdR 1,250,000.00', { minor: 125_000_000 }],
		['​25‌rb\u0007', { minor: 2_500_000 }],
		['Rp 1.250.000﻿', { minor: 125_000_000 }],
		['‮25.000', { minor: 2_500_000 }],
		['Rp\t25.000', { minor: 2_500_000 }]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});

	it.each<string>([
		'',
		'   ',
		'​\u0000',
		'kopi',
		'Rp',
		'besok',
		'25rb goceng', // two amounts are not one amount
		'beli 25rb',
		'Rp 1 250 000',
		'9'.repeat(31),
		'Rp 90.071.992.547.409,92', // one sen beyond Number.MAX_SAFE_INTEGER
		'99999999999999999 juta',
		'25e3',
		'0x10',
		'Infinity',
		'NaN',
		'1_000',
		'２５rb' // full-width digits are not read
	])('%j → null, never a throw', (input) => {
		expect(parseMoneyAmount(input)).toBeNull();
	});

	it('returns only safe integers, including for sen inputs', () => {
		for (const input of ['1.250.000,50', '1,5 jt', '1,55 rb', '0,01', '2,5k']) {
			const parsed = parseMoneyAmount(input);
			expect(parsed, input).not.toBeNull();
			expect(Number.isSafeInteger(parsed?.minor), input).toBe(true);
		}
		expect(parseMoneyAmount('1,55 rb')).toStrictEqual({ minor: 155_000 });
		expect(parseMoneyAmount('0,01')).toStrictEqual({ minor: 1 });
	});

	it('is deterministic across repeated calls', () => {
		const inputs = ['Rp 1.250.000', '2 ceban', 'kopi 25rb dan parkir goceng', '(25.000)'];
		const first = inputs.map((i) => [parseMoneyAmount(i), findMoneyMentions(i)]);
		for (let n = 0; n < 5; n++) {
			expect(inputs.map((i) => [parseMoneyAmount(i), findMoneyMentions(i)])).toStrictEqual(first);
		}
	});

	it('caps huge untrusted input before work and never throws', () => {
		const huge = 'kopi 25rb '.repeat(100_000);
		const started = performance.now();
		const mentions = findMoneyMentions(huge);
		expect(performance.now() - started).toBeLessThan(2000);
		// The last "kopi 25rb" touches the cut (it might have been "25rbu"), so it is dropped (cycle 2, L1).
		expect(mentions.length).toBe(MONEY_TEXT_MAX / 'kopi 25rb '.length - 1);
		expect(mentions.every((m) => m.end <= MONEY_TEXT_MAX)).toBe(true);
		expect(parseMoneyAmount('1'.repeat(1_000_000))).toBeNull();
	});
});

describe('findMoneyMentions', () => {
	it('splits the acceptance journey fixture into two mentions in order', () => {
		const text = 'kopi 25rb dan parkir goceng';
		const mentions = findMoneyMentions(text);
		expect(mentions).toStrictEqual([
			{ minor: 2_500_000, start: 5, end: 9, raw: '25rb' },
			{ minor: 500_000, start: 21, end: 27, raw: 'goceng' }
		]);
		expect(mentions[0]!.end).toBeLessThanOrEqual(mentions[1]!.start);
		for (const m of mentions) expect(text.slice(m.start, m.end)).toBe(m.raw);
	});

	it('does not take a quantity before a later amount as a multiplier', () => {
		expect(findMoneyMentions('beli 2 kopi 50rb')).toStrictEqual([
			{ minor: 5_000_000, start: 12, end: 16, raw: '50rb' }
		]);
	});

	it('finds exactly one mention for one amount and none without an amount', () => {
		expect(findMoneyMentions('bayar listrik Rp 350.000 tadi')).toHaveLength(1);
		expect(findMoneyMentions('makan siang bareng kantor')).toHaveLength(0);
		expect(findMoneyMentions('')).toStrictEqual([]);
	});

	it.each<string>([
		'tahun 2026',
		'telepon 081234567890',
		'jam 14.30',
		'tanggal 08.10.2026',
		'beli 2 kopi',
		'meja nomor 12',
		'0812-3456-7890',
		'versi 1,5',
		'dua puluh lima',
		'2 juta 500 ribu'
	])('%j has no mention', (text) => {
		expect(findMoneyMentions(text)).toStrictEqual([]);
	});

	it('reads markers: currency, unit, slang, DB/CR and thousands grouping', () => {
		expect(findMoneyMentions('transfer 50.000 DB saldo 1.250.000,00')).toStrictEqual([
			{ minor: 5_000_000, direction: 'debit', start: 9, end: 18, raw: '50.000 DB' },
			{ minor: 125_000_000, start: 25, end: 37, raw: '1.250.000,00' }
		]);
		expect(findMoneyMentions('makan 25.000, parkir Rp5000.').map((m) => m.minor)).toStrictEqual([
			2_500_000, 500_000
		]);
		expect(findMoneyMentions('pulsa 2 ceban, bensin seratus ribu').map((m) => m.raw)).toStrictEqual(
			['2 ceban', 'seratus ribu']
		);
	});

	it('treats brackets in free text as punctuation, not a negative', () => {
		expect(findMoneyMentions('kopi (25rb)')).toStrictEqual([
			{ minor: 2_500_000, start: 6, end: 10, raw: '25rb' }
		]);
		expect(findMoneyMentions('refund -25.000')).toStrictEqual([
			{ minor: -2_500_000, start: 7, end: 14, raw: '-25.000' }
		]);
	});

	it('reads a price range as two positive amounts, not a negative', () => {
		expect(findMoneyMentions('Rp25.000-30.000').map((m) => m.minor)).toStrictEqual([
			2_500_000, 3_000_000
		]);
	});

	it('drops an amount glued to another spoken number rather than reading part of it', () => {
		expect(findMoneyMentions('kopi 25rb lima')).toStrictEqual([]);
		expect(findMoneyMentions('Rp 1 250 000 kopi')).toStrictEqual([]);
	});

	it('strips invisible characters; offsets index cleanMoneyText(input)', () => {
		const input = 'kopi​ 25​rb\u0000 dan\tparkir goceng';
		const clean = cleanMoneyText(input);
		expect(clean).toBe('kopi 25rb dan parkir goceng');
		const mentions = findMoneyMentions(input);
		expect(mentions.map((m) => m.minor)).toStrictEqual([2_500_000, 500_000]);
		for (const m of mentions) expect(clean.slice(m.start, m.end)).toBe(m.raw);
		expect(cleanMoneyText(clean)).toBe(clean);
	});
});

describe('module boundary', () => {
	it('imports nothing server-side, Cloudflare, SvelteKit or DOM-specific', () => {
		const source = readFileSync(new URL('./money-parse.ts', import.meta.url), 'utf8');
		const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
		// Explicit .ts extensions: the compatibility harness (FN-16a) loads it under plain Node.
		expect(imports).toStrictEqual(['./money-format.ts', './text.ts']);
		expect(source).not.toMatch(/Date\.now|Math\.random|new Date|Intl\.|document|window/);
	});
});

describe('cycle 2 — M1: case-folding characters never throw', () => {
	it.each<string>(['ſeceng', 'ſatu ribu', 'ſeratus rb', 'bayar ſeceng tadi', 'ſejuta', 'ſeribu'])(
		'%j does not throw and reads no amount',
		(input) => {
			expect(() => parseMoneyAmount(input)).not.toThrow();
			expect(() => findMoneyMentions(input)).not.toThrow();
			expect(parseMoneyAmount(input)).toBeNull();
			expect(findMoneyMentions(input)).toStrictEqual([]);
		}
	);

	it('Kelvin sign (U+212A) is NFC-normalised to K and reads as the unit k', () => {
		expect(parseMoneyAmount('25K')).toStrictEqual({ minor: 2_500_000 });
	});

	it('no input from a fuzz list ever throws', () => {
		// Every character up to U+1FFFF whose case mapping changes length or lands in ASCII letters,
		// plus deterministic pseudo-random strings built from parser-relevant fragments.
		const specials: string[] = [];
		for (let cp = 0x80; cp <= 0x1ffff; cp++) {
			const ch = String.fromCodePoint(cp);
			const lo = ch.toLowerCase();
			const up = ch.toUpperCase();
			if (
				lo.length !== ch.length ||
				up.length !== ch.length ||
				/[a-z]/.test(lo) ||
				/[A-Z]/.test(up)
			) {
				specials.push(ch);
			}
		}
		expect(specials.length).toBeGreaterThan(50);
		const fragments = [
			...Object.keys(IDR_SLANG),
			...['satu', 'dua', 'puluh', 'ratus', 'belas', 'ribu', 'juta', 'seribu', 'sejuta', 'rb', 'jt'],
			...['k', 'Rp', 'IDR', 'DB', 'CR', '(', ')', '-', '−', '+', '.', ',', ' ', '0', '1', '25'],
			...['000', ',-', '__proto__', 'constructor', 'koma', 'setengah']
		];
		let seed = 42;
		const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
		const inputs: string[] = [];
		for (const ch of specials) {
			inputs.push(ch, `${ch}eceng`, `25${ch}`, `${ch} 25rb`, `ſ${ch}atu ribu`);
		}
		for (let i = 0; i < 3000; i++) {
			let s = '';
			const n = 1 + (next() % 8);
			for (let j = 0; j < n; j++) {
				s +=
					next() % 5 === 0
						? specials[next() % specials.length]
						: fragments[next() % fragments.length];
				if (next() % 2 === 0) s += ' ';
			}
			inputs.push(s);
		}
		for (const input of inputs) {
			const parsed = parseMoneyAmount(input);
			const mentions = findMoneyMentions(input);
			if (parsed) expect(Number.isSafeInteger(parsed.minor), input).toBe(true);
			for (const m of mentions) expect(Number.isSafeInteger(m.minor), input).toBe(true);
		}
	});

	it('IDR_SLANG cannot be changed at runtime', () => {
		expect(Object.isFrozen(IDR_SLANG)).toBe(true);
	});
});

describe('cycle 2 — L1: truncation never shrinks an amount', () => {
	// Filler of exactly n characters ending in a space, so the amount after it starts a new word.
	const pad = (n: number) => (n % 2 ? 'x' : '') + 'x '.repeat(Math.floor(n / 2));

	it.each<[string, string]>([
		['cut after "Rp 1.250"', 'Rp 1.250'],
		['cut after "Rp 1.250.00"', 'Rp 1.250.00'],
		['cut after "Rp 1"', 'Rp 1']
	])('Rp 1.250.000 straddling the cap, %s', (_label, visible) => {
		const text = pad(MONEY_TEXT_MAX - visible.length) + 'Rp 1.250.000 kopi';
		expect(findMoneyMentions(text)).toStrictEqual([]);
	});

	it('keeps an amount that ends at the cap only when nothing followed it', () => {
		const amount = 'Rp 1.250.000';
		const text = pad(MONEY_TEXT_MAX - amount.length) + amount;
		expect(findMoneyMentions(text).map((m) => m.minor)).toStrictEqual([125_000_000]);
		expect(findMoneyMentions(text + ' DB')).toStrictEqual([]); // the DB/CR suffix was cut off
	});

	it('drops a partial trailing word and any amount touching the cut', () => {
		const text = pad(MONEY_TEXT_MAX - 'seribu li'.length) + 'seribu lima ratus';
		expect(cleanMoneyText(text).endsWith('seribu')).toBe(true);
		expect(findMoneyMentions(text)).toStrictEqual([]);
		expect(parseMoneyAmount('1'.repeat(3000))).toBeNull();
	});

	it('keeps earlier amounts when the text is cut later', () => {
		expect(findMoneyMentions('kopi 25rb ' + 'x '.repeat(1500))).toStrictEqual([
			{ minor: 2_500_000, start: 5, end: 9, raw: '25rb' }
		]);
	});
});

describe('cycle 2 — L2: leading-zero groups and bidi controls', () => {
	it.each<Vector>([
		['Rp 000.001', null],
		['Rp 000.999', null],
		['0.250', null],
		['01.250', null],
		['Rp 1.025.000', { minor: 102_500_000 }],
		['Rp 1.000.001', { minor: 100_000_100 }],
		['0,50', { minor: 50 }],
		['Rp ‮000.999‬', null],
		['Rp ⁧999.000⁩', { minor: 99_900_000 }],
		['Rp ‏25.000‎', { minor: 2_500_000 }]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});

	it('strips bidi controls before parsing', () => {
		expect(cleanMoneyText('Rp ‮⁦‏25.000‬⁩')).toBe('Rp 25.000');
	});
});

describe('cycle 2 — L3: a dash is a sign only when attached', () => {
	it.each<Vector>([
		['-Rp25.000', { minor: -2_500_000 }],
		['-25.000', { minor: -2_500_000 }],
		['Rp -25.000', { minor: -2_500_000 }],
		['- 25.000', null],
		['Rp - 25.000', null]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});

	it('spaced dash punctuation in free text keeps the amount positive', () => {
		expect(findMoneyMentions('Belanja - Rp 25.000')).toStrictEqual([
			{ minor: 2_500_000, start: 10, end: 19, raw: 'Rp 25.000' }
		]);
		expect(findMoneyMentions('Total − Rp 1.250.000').map((m) => m.minor)).toStrictEqual([
			125_000_000
		]);
		expect(findMoneyMentions('Refund -Rp 25.000').map((m) => m.minor)).toStrictEqual([-2_500_000]);
	});
});

describe('cycle 2 — spoken number words (Owner decision B changed 2026-10-08)', () => {
	it.each<Vector>([
		['dua puluh lima ribu', { minor: 2_500_000 }],
		['lima belas ribu', { minor: 1_500_000 }],
		['dua ratus ribu', { minor: 20_000_000 }],
		['satu juta lima ratus ribu', { minor: 150_000_000 }],
		['seribu', { minor: 100_000 }],
		['sejuta', { minor: 100_000_000 }],
		['sepuluh ribu', { minor: 1_000_000 }],
		['sebelas ribu', { minor: 1_100_000 }],
		['seratus ribu', { minor: 10_000_000 }],
		['seribu lima ratus', { minor: 150_000 }],
		['sejuta dua ratus lima puluh ribu', { minor: 125_000_000 }],
		['tiga ratus lima puluh ribu', { minor: 35_000_000 }],
		['dua juta tiga ratus ribu', { minor: 230_000_000 }],
		[
			'sembilan ratus sembilan puluh sembilan juta sembilan ratus sembilan puluh sembilan ribu ' +
				'sembilan ratus sembilan puluh sembilan',
			{ minor: 99_999_999_900 }
		],
		['dua puluh rb', { minor: 2_000_000 }],
		['lima jt', { minor: 500_000_000 }],
		['Dua Puluh Lima Ribu', { minor: 2_500_000 }],
		['dua ribu lima', { minor: 200_500 }],
		['seratus dua puluh ribu', { minor: 12_000_000 }]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});

	it.each<string>([
		'dua puluh lima', // no ribu/juta: a quantity, not money
		'lima ratus',
		'seratus',
		'satu ratus ribu', // non-standard forms are refused, not guessed
		'satu belas ribu',
		'satu puluh ribu',
		'ribu',
		'juta ribu',
		'seribu juta', // scales out of order
		'dua ribu tiga ribu',
		'dua dua ribu',
		'satu koma lima juta', // decimals in words are not read; never the partial "lima juta"
		'setengah juta',
		'2 juta lima ratus ribu', // digits glued to words stay ambiguous
		'25 ribu lima ratus',
		'dua puluh lima ribu 500',
		'satu '.repeat(25) + 'ribu' // word cap
	])('%j → null', (input) => {
		expect(parseMoneyAmount(input)).toBeNull();
	});

	it('finds spoken amounts inside a sentence', () => {
		const mentions = findMoneyMentions('beli dua kopi dua puluh lima ribu dan parkir seribu');
		expect(mentions.map((m) => [m.raw, m.minor])).toStrictEqual([
			['dua puluh lima ribu', 2_500_000],
			['seribu', 100_000]
		]);
	});

	it('runs in linear time on a long run of number words', () => {
		const worst = 'sembilan ratus sembilan puluh sembilan '.repeat(60);
		const started = performance.now();
		for (let i = 0; i < 20; i++) findMoneyMentions(worst);
		expect((performance.now() - started) / 20).toBeLessThan(50);
	});
});

describe('cycle 2 — DB/CR before the amount', () => {
	it.each<Vector>([
		['DB 25.000', { minor: 2_500_000, direction: 'debit' }],
		['CR Rp 25.000', { minor: 2_500_000, direction: 'credit' }],
		['cr 1.250.000,00', { minor: 125_000_000, direction: 'credit' }],
		['DB 25.000 CR', null],
		['DB -25.000', null],
		['DB (25.000)', null]
	])('%j', (input, expected) => {
		expect(parseMoneyAmount(input)).toStrictEqual(expected);
	});

	it('reads a mutasi line with the marker before the amount', () => {
		expect(findMoneyMentions('TRSFR E-BANKING DB 25.000 08/10')).toStrictEqual([
			{ minor: 2_500_000, direction: 'debit', start: 16, end: 25, raw: 'DB 25.000' }
		]);
	});

	it('N1: a leading DB/CR in free text needs a currency, unit or grouping on the figure', () => {
		expect(findMoneyMentions('Kode DB 123456')).toStrictEqual([]);
		expect(findMoneyMentions('ref CR 2026')).toStrictEqual([]);
		expect(findMoneyMentions('DB 25.000').map((m) => [m.minor, m.direction])).toStrictEqual([
			[2_500_000, 'debit']
		]);
		expect(findMoneyMentions('CR Rp 25.000').map((m) => [m.minor, m.direction])).toStrictEqual([
			[2_500_000, 'credit']
		]);
		expect(findMoneyMentions('DB 25rb').map((m) => [m.minor, m.direction])).toStrictEqual([
			[2_500_000, 'debit']
		]);
		// A whole amount cell still reads it.
		expect(parseMoneyAmount('DB 123456')).toStrictEqual({ minor: 12_345_600, direction: 'debit' });
	});
});

describe('cycle 3 — L1 residual: invisible padding cannot bypass truncation', () => {
	it('zero-width padding before an amount never shrinks it', () => {
		const mentions = findMoneyMentions('​'.repeat(8000) + 'Rp 1.250.000');
		expect(mentions.every((m) => m.minor === 125_000_000)).toBe(true);
		expect(parseMoneyAmount('​'.repeat(8000) + 'Rp 1.250.000')).toBeNull();
	});

	it('zero-width padding never strips a DB/CR suffix silently', () => {
		const mentions = findMoneyMentions('​'.repeat(7998) + 'Rp 25.000 CR');
		expect(mentions.every((m) => m.direction === 'credit')).toBe(true);
	});

	it('short padded input below the raw cap still parses', () => {
		expect(parseMoneyAmount('​'.repeat(100) + 'Rp 25.000 CR')).toStrictEqual({
			minor: 2_500_000,
			direction: 'credit'
		});
	});
});
