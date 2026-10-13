import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRANDS, brandById, institutionOption, matchBrand, walletSeries } from './brands';
import { SUBSCRIPTION_CATALOGUE } from './subscriptions-catalogue';
import { WALLET_QUICK_PICKS } from './wallets';

const id = (name: string) => matchBrand(name)?.id ?? null;

describe('matchBrand (FN-43)', () => {
	it.each(['BCA', 'bca', ' BCA ', 'Bank Central Asia', 'bank  central\tasia', 'Tabungan BCA'])(
		'%j → bca',
		(name) => expect(id(name)).toBe('bca')
	);

	it('GoPay, Gojek and GoFood are three entries, none cross-matches', () => {
		expect(id('GoPay')).toBe('gopay');
		expect(id('Gojek')).toBe('gojek');
		expect(id('GoFood')).toBe('gofood');
		expect(id('gopayx')).toBeNull();
		expect(id('Grab')).toBe('grab');
		expect(id('ShopeeFood')).toBe('shopeefood');
		expect(id('ShopeePay')).toBe('shopeepay');
	});

	it.each([
		['Tabungan BCA', 'bca'],
		['Dompet Gopay saya', 'gopay'],
		['GoPay Plus', 'gopay'],
		['GoFood Plus', 'gofood'],
		['GrabUnlimited', 'grab'],
		['Rekening Bank Rakyat Indonesia', 'bri'],
		['blu BCA', 'blu'],
		['Tabungan blu by BCA Digital', 'blu'],
		['i.saku', 'isaku'],
		['Bank Mandiri', 'mandiri'],
		['DANA', 'dana'],
		['DANA e-wallet', 'dana'],
		['Bank Jago', 'jago'],
		['BCA kartu kredit', 'bca']
	])('whole-word match inside a longer name: %j → %s', (name, expected) => {
		expect(id(name)).toBe(expected);
	});

	it.each([
		'Dompet harian',
		'Tabungan masa depan',
		'Dana darurat',
		'Dana pensiun',
		'Kebun jago',
		'Netflix',
		'',
		'+++',
		'abca'
	])('%j → no badge', (name) => {
		expect(matchBrand(name)).toBeNull();
	});

	// FN-43 L2: a brand word that only mentions a service mid-name ("pay to BCA") is not the account's own name.
	it.each([
		'Bayar ke BCA teman',
		'Transfer ke OVO',
		'Kiriman dari Mandiri kantor',
		'Cicilan via GoPay',
		'Patungan kado BRI teman',
		'Uang untuk Bank Central Asia'
	])('incidental mention %j → no badge', (name) => {
		expect(matchBrand(name)).toBeNull();
	});

	it.each([
		['Rekening BCA utama', 'bca'],
		['Dompet OVO harian', 'ovo'],
		['Kartu Kredit BNI Platinum', 'bni'],
		['Langganan GoPay Plus', 'gopay']
	])('an account word before the brand still names it: %j → %s', (name, expected) => {
		expect(id(name)).toBe(expected);
	});

	it('every catalogue entry outside the registry keeps its generic tile', () => {
		const matched = SUBSCRIPTION_CATALOGUE.filter((e) => matchBrand(e.name)).map((e) => e.id);
		expect(matched.sort()).toEqual(['gofood-plus', 'gopay-plus', 'grabunlimited']);
	});

	it('every e-wallet quick pick resolves to its own registry entry', () => {
		for (const pick of WALLET_QUICK_PICKS) {
			expect(id(pick.name)).toBe(pick.id);
			expect(brandById(pick.id)?.id).toBe(pick.id);
		}
	});

	it('a 10,000-character name is cut before any work', () => {
		const long = `BCA ${'x '.repeat(5_000)}`;
		expect(id(long)).toBe('bca');
		expect(id(`${'x'.repeat(10_000)} BCA`)).toBeNull();
		const start = performance.now();
		for (let i = 0; i < 200; i++) matchBrand(long);
		expect(performance.now() - start).toBeLessThan(500);
	});
});

describe('the registry', () => {
	it('has the 15 banks, 7 e-wallets and 6 ride/food services', () => {
		expect(BRANDS).toHaveLength(28);
		expect(new Set(BRANDS.map((b) => b.id)).size).toBe(BRANDS.length);
	});

	it('no two entries share an alias or whole name', () => {
		const seen = new Map<string, string>();
		for (const entry of BRANDS)
			for (const alias of [...entry.aliases, ...(entry.wholeNames ?? [])]) {
				expect(seen.get(alias), `${alias}: ${entry.id}`).toBeUndefined();
				seen.set(alias, entry.id);
			}
	});

	it('aliases are lower-case words with single spaces, and every entry matches its own aliases', () => {
		for (const entry of BRANDS) {
			expect(entry.badgeText.length, entry.id).toBeGreaterThanOrEqual(2);
			expect(entry.badgeText.length, entry.id).toBeLessThanOrEqual(5);
			for (const alias of [...entry.aliases, ...(entry.wholeNames ?? [])]) {
				expect(alias).toMatch(/^[a-z0-9]+(?: [a-z0-9]+)*$/);
				expect(id(alias), alias).toBe(entry.id);
			}
		}
	});

	it('brandById finds a known id and nothing else', () => {
		expect(brandById('bca')?.name).toBe('BCA');
		expect(brandById('unknown-id')).toBeNull();
		expect(brandById('Bank Central Asia')).toBeNull();
	});

	it('every entry has a token, a mono grey, a badge class and a chart series', () => {
		const tokens = readFileSync('docs/design/tokens.css', 'utf8');
		const root = tokens.slice(0, tokens.indexOf('}'));
		const monoStart = tokens.indexOf(":root[data-theme='mono'] {");
		const mono = tokens.slice(monoStart, tokens.indexOf('}', monoStart));
		const badge = readFileSync('src/lib/ui/kit/BrandBadgeById.svelte', 'utf8');
		const series = readFileSync('src/lib/ui/charts/series.css', 'utf8');
		for (const { id: key } of BRANDS) {
			expect(root, key).toMatch(new RegExp(`--badge-${key}: #[0-9a-f]{6};`));
			expect(mono, key).toMatch(new RegExp(`--badge-${key}: #[0-9a-f]{6};`));
			expect(badge, key).toContain(`.b-${key} {\n\t\t--c: var(--badge-${key});`);
			expect(series, key).toContain(`.series-brand-${key} {\n\t--c: var(--badge-${key});`);
		}
	});
});

describe('institutionOption (Impor picker)', () => {
	it('a parser id in the registry carries its badge, so a new parser needs no change', () => {
		const parsers = [
			{ id: 'bca', label: 'BCA' },
			{ id: 'bni', label: 'BNI' },
			{ id: 'bank-x', label: 'Bank X' }
		];
		expect(parsers.map(institutionOption)).toEqual([
			{ value: 'bca', label: 'BCA', brand: 'bca' },
			{ value: 'bni', label: 'BNI', brand: 'bni' },
			{ value: 'bank-x', label: 'Bank X' }
		]);
	});
});

describe('walletSeries (Alur uang)', () => {
	it('a named wallet takes its brand hue, any other wallet the flat accent', () => {
		expect(walletSeries('BCA')).toBe('brand-bca');
		expect(walletSeries('Dompet GoPay')).toBe('brand-gopay');
		expect(walletSeries('Dompet harian')).toBe('accent');
	});
});
