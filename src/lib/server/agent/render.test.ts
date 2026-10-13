import { describe, expect, it } from 'vitest';
import type { AgentFacts } from './facts';
import { createHash } from 'node:crypto';
import { esc, renderCsv, renderHtml } from './render';

// FN-23 criteria 12, 13, 16, 18, 26: the files are pure functions of facts + narrative + locale.

const monthly: AgentFacts = {
	version: 1,
	type: 'monthly',
	period: '2026-09',
	from: '2026-09-01',
	to: '2026-09-30',
	generatedOn: '2026-10-10',
	partial: false,
	read: {
		count: 1234,
		expenseCount: 1200,
		incomeCount: 34,
		transferCount: 0,
		adjustmentCount: 0,
		currencies: ['IDR']
	},
	group: {
		categoryCount: 12,
		currencies: [
			{
				currency: 'IDR',
				categories: [
					{ name: '=HYPERLINK("x")', outMinor: 2_500_000 },
					{ name: '+1', outMinor: 1_000_000 },
					{ name: '-2', outMinor: 500_000 },
					{ name: '@SUM(A1)', outMinor: 400_000 },
					{ name: '\tTab', outMinor: 300_000 },
					{ name: '＝fullwidth', outMinor: 200_000 },
					{ name: null, outMinor: 100_000 }
				],
				otherCount: 2,
				otherMinor: 50_000,
				merchants: [
					{ title: '<script>alert(1)</script>', count: 3, amountMinor: 75_000 },
					{ title: '"><img src=x onerror=alert(1)>', count: 1, amountMinor: 25_050 },
					{ title: 'Tom & Jerry', count: 1, amountMinor: null }
				]
			}
		]
	},
	summary: {
		previousPeriod: '2026-08',
		currencies: [
			{
				currency: 'IDR',
				inMinor: 10_000_000,
				outMinor: 5_050_000,
				netMinor: 4_950_000,
				previousOutMinor: 4_000_000,
				changePercent: 26
			}
		]
	}
};

const spt: AgentFacts = {
	version: 1,
	type: 'spt_assets',
	period: '2025',
	from: '2025-01-01',
	to: '2025-12-31',
	generatedOn: '2026-10-10',
	partial: false,
	inventory: { wallets: 1, items: 2, belongings: 1, collectibles: 0 },
	balances: {
		asOf: '2025-12-31',
		wallets: [{ name: 'BCA •••• 1234', currency: 'IDR', balanceMinor: -2_500_000 }],
		totals: [{ currency: 'IDR', totalMinor: -2_500_000 }]
	},
	assets: {
		valuedOn: '2026-10-10',
		items: [
			{
				name: 'Emas',
				kind: 'investment_gold',
				currency: 'IDR',
				valueMinor: null,
				unpriced: true,
				estimated: false,
				acquiredOn: null,
				acquisitionMinor: null
			}
		],
		debts: [
			{
				name: 'KPR',
				kind: 'debt',
				currency: 'IDR',
				valueMinor: 100_000_000,
				unpriced: false,
				estimated: false,
				acquiredOn: '2020-01-01',
				acquisitionMinor: null
			}
		],
		belongings: [
			{
				name: 'Laptop',
				kind: 'belonging',
				currency: 'IDR',
				valueMinor: 8_000_000,
				unpriced: false,
				estimated: true,
				acquiredOn: '2024-05-01',
				acquisitionMinor: 15_000_000
			}
		],
		collectibles: [],
		subtotals: [
			{ group: 'debts', currency: 'IDR', totalMinor: 100_000_000 },
			{ group: 'belongings', currency: 'IDR', totalMinor: 8_000_000 }
		]
	}
};

const DISCLAIMER =
	'Informasi dari catatanmu, bukan saran keuangan atau pajak. Daftar aset adalah informasi dari catatanmu, bukan pelaporan SPT.';

describe('renderCsv', () => {
	it('is byte-identical for the same facts, narrative and locale (criterion 12)', () => {
		expect(renderCsv(monthly, 'Ringkas.', 'id')).toBe(renderCsv(monthly, 'Ringkas.', 'id'));
		expect(renderHtml(monthly, 'Ringkas.', 'id')).toBe(renderHtml(monthly, 'Ringkas.', 'id'));
		expect(renderCsv(spt, null, 'en')).toBe(renderCsv(spt, null, 'en'));
	});

	it('guards every formula-looking cell, fullwidth included, and writes amounts exactly (criterion 13)', () => {
		const csv = renderCsv(monthly, null, 'id');
		expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
		expect(csv).toContain(",'+1,");
		expect(csv).toContain(",'-2,");
		expect(csv).toContain(",'@SUM(A1),");
		expect(csv).toContain(",'\tTab,");
		// Fullwidth forms are folded (NFKC) before the guard, so `＝` leaves as a guarded `=`.
		expect(csv).toContain(",'=fullwidth,");
		expect(csv).toContain('Kategori,Tanpa kategori,IDR,1000,');
		expect(csv).toContain('Ringkasan,Pemasukan,IDR,100000,');
		expect(csv).toContain(
			'Tempat belanja,"""><img src=x onerror=alert(1)>",IDR,250.50,1 transaksi'
		);
		expect(csv).toContain('Tom & Jerry,IDR,terlalu besar');
		expect(csv).toContain('Ringkasan,Jumlah transaksi,,1234,');
		expect(csv).toContain(DISCLAIMER);
		expect(csv).not.toMatch(/\d\.\d{3,}e/);
		// A negative amount is guarded like the FN-18 export does.
		expect(renderCsv(spt, null, 'id')).toContain(",'-25000,");
	});

	it('the asset list says what each value is and never claims a 31 December value (criterion 18)', () => {
		const csv = renderCsv(spt, null, 'id');
		expect(csv).toContain(
			'Aset,Emas,Emas,IDR,,2026-10-10,,,"Belum ada harga; tanggal perolehan tidak dicatat"'
		);
		expect(csv).toContain('nilai terakhir per 10 Okt 2026; Estimasi');
		expect(csv).toContain('Barang,Laptop,Barang,IDR,80000,2026-10-10,2024-05-01,150000');
		expect(csv).toContain('Subtotal Utang,,,IDR,1000000,');
		expect(csv).toContain('Saldo akhir tahun');
		expect(csv).toContain(DISCLAIMER);
	});

	it('writes the run locale (criterion 26)', () => {
		const csv = renderCsv(monthly, null, 'en');
		expect(csv).toContain('Montra — Monthly report,September 2026');
		expect(csv).toContain('Overview,Income,IDR,100000,');
		expect(csv).toContain('not financial or tax advice');
	});
});

describe('renderHtml', () => {
	it('escapes every name and carries no script, handler or external resource (criterion 13)', () => {
		const html = renderHtml(monthly, 'Belanja naik <b>tajam</b> & "cepat".', 'id');
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<[^>]*\son\w+=/i);
		expect(html).not.toMatch(/https?:\/\//);
		expect(html).not.toMatch(/<img/i);
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
		expect(html).toContain('Tom &amp; Jerry');
		expect(html).toContain('Belanja naik &lt;b&gt;tajam&lt;/b&gt; &amp; &quot;cepat&quot;.');
		expect(html).toContain('@media print');
		expect(html).toContain(DISCLAIMER);
	});

	it('formats money with the shared formatter, U+2212 for a negative, "terlalu besar" past the safe range', () => {
		const html = renderHtml(spt, null, 'id');
		expect(html).toContain('−Rp 25.000');
		expect(renderHtml(monthly, null, 'id')).toContain('Rp 100.000');
		expect(renderHtml(monthly, null, 'id')).toContain('terlalu besar');
	});

	it('truncates a 10 KB name and masks account-number-like digits', () => {
		const long = { ...monthly };
		long.group = {
			categoryCount: 1,
			currencies: [
				{
					currency: 'IDR',
					categories: [{ name: 'x'.repeat(10_240), outMinor: 1 }],
					otherCount: 0,
					otherMinor: 0,
					merchants: [{ title: 'Transfer 1234567890123', count: 1, amountMinor: 1 }]
				}
			]
		};
		const html = renderHtml(long, null, 'id');
		expect(html).not.toContain('x'.repeat(201));
		expect(html).toContain('x'.repeat(200));
		expect(html).not.toContain('1234567890123');
		expect(renderCsv(long, null, 'id')).not.toContain('1234567890123');
	});

	it('esc escapes the five HTML characters', () => {
		expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe(
			'&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
		);
	});
});

// Red team S5: a saved file opened from disk (no HTTP header) still carries its own CSP: no script, only its style.
describe('renderHtml CSP meta (S5)', () => {
	it('carries default-src none and the hash of its one style block, never unsafe-inline', () => {
		const html = renderHtml(monthly, 'Ringkas.', 'id');
		const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
		const hash = createHash('sha256').update(style, 'utf8').digest('base64');
		expect(html).toContain(
			`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-${hash}'">`
		);
		expect(html).not.toContain('unsafe-inline');
		expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<title>'));
	});
});
