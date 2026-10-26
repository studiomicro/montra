import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { createRawSnippet, type Component } from 'svelte';
import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMoneyCompact } from '#lib/shared/money-format';
import type { GreetingPeriod } from '#lib/shared/greeting';
import I18nHarness from '../../../../test/helpers/I18nHarness.svelte';
import HeatCalendar from '../charts/HeatCalendar.svelte';
import { HIDDEN_AMOUNT } from '../kit/amount-visibility';
import { amounts } from '../kit/amounts.svelte';
import CalendarBadge from '../kit/CalendarBadge.svelte';
import BudgetChip from './BudgetChip.svelte';
import DailyStory from './DailyStory.svelte';
import FeatureTiles from './FeatureTiles.svelte';
import GreetingHero from './GreetingHero.svelte';
import HeroScene from './HeroScene.svelte';
import { stripComments } from '../../../../test/helpers/html';

// SvelteKit-only imports are stubbed for a plain server render (the story's "Matikan" form).
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const strip = stripComments;
const html = (component: unknown, props: Record<string, unknown>, locale: 'id' | 'en' = 'id') =>
	strip(
		render(I18nHarness, {
			props: { component: component as Component<Record<string, unknown>>, props, locale }
		}).body
	);

afterEach(() => {
	amounts.hidden = false;
});

const figure = createRawSnippet(() => ({ render: () => '<div class="hero">FIGURE</div>' }));
const hero = (over: Record<string, unknown> = {}, locale: 'id' | 'en' = 'id') =>
	html(
		GreetingHero,
		{
			today: '2026-10-13',
			period: 'pagi',
			stateLine: 'Belum ada catatan hari ini.',
			askReady: true,
			children: figure,
			...over
		},
		locale
	);

describe('GreetingHero (FN-54 B2, criteria 3, 8, 11)', () => {
	it('date, greeting (a paragraph, never a heading), state line, the figure, the ask form and the scene, in order', () => {
		const body = hero();
		const order = [
			'Selasa, 13 Okt',
			'Selamat pagi.',
			'Belum ada catatan hari ini.',
			'FIGURE',
			'name="q"',
			'<svg'
		];
		const at = order.map((s) => body.indexOf(s));
		expect(at.every((i) => i >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		expect(body).not.toMatch(/<h[1-6]/);
		expect(body).toMatch(/<p class="hello[^"]*"[^>]*>Selamat pagi\.<\/p>/);
	});

	it('English: the greeting, the date and the field are English', () => {
		const body = hero({ period: 'malam' }, 'en');
		expect(body).toContain('Good evening.');
		expect(body).toContain('Tuesday 13 Oct');
		expect(body).toContain('Ask anything about your money');
	});

	it.each<[GreetingPeriod, string]>([
		['pagi', 'Selamat pagi.'],
		['siang', 'Selamat siang.'],
		['sore', 'Selamat sore.'],
		['malam', 'Selamat malam.']
	])('%s greets “%s”', (period, line) => {
		expect(hero({ period })).toContain(line);
	});

	it('the ask field is a GET form to /tanya named q, capped at the question limit; it sends nothing itself', () => {
		const body = hero();
		expect(body).toMatch(/<form[^>]*method="GET"[^>]*action="\/tanya"/);
		expect(body).toMatch(/<input[^>]*name="q"[^>]*maxlength="500"/);
		expect(body).not.toMatch(/method="POST"/);
		expect(body).not.toContain('Asisten AI belum dikonfigurasi.');
	});

	it('without the AI Gateway the field and its button are disabled and the reason is visible and linked', () => {
		const body = hero({ askReady: false });
		expect(body.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
		const id = /<p class="why[^"]*" id="([^"]+)"/.exec(body)?.[1];
		expect(id).toBeTruthy();
		expect(body).toContain(`aria-describedby="${id}"`);
		expect(body).toContain('Asisten AI belum dikonfigurasi.');
	});

	it('the Pro frame is the card’s, once; a Gratis card has none', () => {
		expect(hero({ pro: true })).toMatch(/<section class="greeting[^"]* pro/);
		expect(hero({ pro: false })).not.toMatch(/<section class="greeting[^"]* pro/);
	});
});

describe('BudgetChip (B3, criteria 6–7)', () => {
	const chip = (safeToSpend: unknown, currency = 'IDR') =>
		html(BudgetChip, { safeToSpend, currency });

	it('money left: the compact remaining figure, the same text the budget line prints', () => {
		const body = chip({ kind: 'left', remainingMinor: 123_456_700, perDayMinor: 1, days: 19 });
		expect(body).toContain(`${formatMoneyCompact(123_456_700, 'IDR', 'id')} masih bisa dipakai`);
		expect(body).toMatch(/<a[^>]*href="\/anggaran"/);
	});

	it.each([
		[{ kind: 'spent' }, 'Anggaran bulan ini sudah habis.'],
		[{ kind: 'over', overMinor: null }, 'Sudah melebihi anggaran.'],
		[null, 'Atur anggaran']
	])('%o → %s', (state, text) => {
		expect(chip(state)).toContain(text);
	});

	it('over by an amount, in words and the up colour (colour is not the only signal)', () => {
		const body = chip({ kind: 'over', overMinor: 5_000_000 });
		expect(body).toContain(
			`Sudah melebihi anggaran sebesar ${formatMoneyCompact(5_000_000, 'IDR', 'id')}`
		);
		expect(body).toMatch(/class="chip-budget[^"]*over/);
	});

	it('hidden amounts mask the figure from the server render; the words stay', () => {
		amounts.hidden = true;
		const body = chip({ kind: 'left', remainingMinor: 123_456_700, perDayMinor: 1, days: 19 });
		expect(body).toContain(`${HIDDEN_AMOUNT} masih bisa dipakai`);
		expect(body).not.toContain(formatMoneyCompact(123_456_700, 'IDR', 'id'));
	});
});

describe('HeroScene (B5, criterion 12)', () => {
	const scenes = (['pagi', 'siang', 'sore', 'malam'] as const).map((period) =>
		strip(render(HeroScene, { props: { period } }).body)
	);
	const city = (svg: string) => svg.replace(/^[\s\S]*?(<g transform)/, '$1');

	it('the four periods differ only in the sky; the city is the same', () => {
		expect(new Set(scenes.map(city)).size).toBe(1);
		expect(new Set(scenes).size).toBe(4);
	});

	it.each(scenes.map((svg, i) => [['pagi', 'siang', 'sore', 'malam'][i], svg]))(
		'%s: inline, decorative, no style, image, filter, gradient or external reference; ≤ 40 shapes, ≤ 8 KB',
		(_period, svg) => {
			expect(svg).toMatch(/<svg[^>]*aria-hidden="true"/);
			expect(svg).toMatch(/focusable="false"/);
			expect(svg).not.toMatch(/\sstyle=/);
			expect(svg).not.toMatch(
				/<(image|filter|linearGradient|radialGradient|use|foreignObject|a)\b/
			);
			expect(svg).not.toMatch(/href=|url\(/);
			expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
			expect(
				(svg.match(/<(path|circle|ellipse|rect|polygon|line)\b/g) ?? []).length
			).toBeLessThanOrEqual(40);
			expect(new TextEncoder().encode(svg).length).toBeLessThanOrEqual(8 * 1024);
		}
	);
});

describe('CalendarBadge (B7, criterion 17)', () => {
	it('the server date as a page: month band and day, named in words, linking to /kalender', () => {
		const body = html(CalendarBadge, { today: '2026-10-13' });
		expect(body).toMatch(/<a[^>]*href="\/kalender"/);
		expect(body).toContain('aria-label="Kalender, Selasa, 13 Oktober 2026"');
		expect(body).toMatch(/class="month[^"]*"[^>]*>Okt</);
		expect(body).toMatch(/>13</);
	});

	it('English and a month boundary (criterion 2: 1 Nov after 00:00 WIB)', () => {
		const body = html(CalendarBadge, { today: '2026-11-01' }, 'en');
		expect(body).toMatch(/>Nov</);
		expect(body).toMatch(/>1</);
		expect(body).toContain('aria-label="Calendar, Sunday, 1 November 2026"');
	});
});

describe('HeatCalendar marks (C2, criterion 23)', () => {
	const days = ['2026-10-12', '2026-10-13', '2026-10-14'].map((date, i) => ({
		date,
		minor: i === 0 ? 900_000 : 0,
		level: i === 0 ? (4 as const) : (0 as const),
		future: date > '2026-10-13'
	}));
	const body = html(HeatCalendar, {
		days,
		today: '2026-10-13',
		label: 'Pengeluaran per hari',
		hrefFor: (d: string) => `/kalender?hari=${d}`,
		marks: { '2026-10-12': { closed: true }, '2026-10-14': { due: true } },
		selected: '2026-10-12'
	});

	it('a closed, heavy day keeps its shade and gains the ring, named for assistive tech', () => {
		expect(body).toMatch(
			/<a class="cell l4[^"]*selected[^"]*"[^>]*aria-label="12 Okt: Rp\s?9\.000, Hari ditutup"/
		);
		expect(body).toMatch(/class="mark ring/);
	});

	it('a future day with something due is a link to its detail with the square mark', () => {
		expect(body).toMatch(
			/<a class="cell future[^"]*"[^>]*href="\/kalender\?hari=2026-10-14"[^>]*aria-label="14 Okt: Ada tagihan atau transaksi berulang"/
		);
		expect(body).toMatch(/class="mark square/);
	});

	it('the legend names both marks; without marks Laporan’s calendar is unchanged', () => {
		expect(body).toContain('Hari ditutup');
		const plain = html(HeatCalendar, {
			days,
			today: '2026-10-13',
			label: 'x',
			hrefFor: (d: string) => d
		});
		expect(plain).not.toContain('mark');
		expect(plain).not.toContain('selected');
	});
});

describe('FeatureTiles (A4, criterion 28)', () => {
	it('every tile is a link to its page with chip, name and hint; Kelola fitur falls back to /pengaturan/fitur', () => {
		const body = html(FeatureTiles, {
			hidden: ['kekayaan', 'langganan', 'barang', 'koleksi', 'ruang', 'patungan']
		});
		expect([...body.matchAll(/<a class="tile[^"]*" href="([^"]+)"/g)].map((m) => m[1])).toEqual([
			'/alur-uang',
			'/agen'
		]);
		expect(body).toMatch(/<a class="manage[^"]*" href="\/pengaturan\/fitur"/);
		expect(body).toContain('Minta laporan, Agen yang menyiapkannya.');
	});
});

describe('DailyStory first paint (D2, criterion 34)', () => {
	it('server-renders closed: no card text, no open dialog', () => {
		const body = html(DailyStory, {
			cards: [{ kind: 'kemarin', date: '2026-10-12', minor: 54_000, currency: 'IDR' }],
			today: '2026-10-13',
			onoff: () => {}
		});
		expect(body).not.toContain('Kemarin');
		expect(body).not.toMatch(/<dialog[^>]*\sopen/);
	});
});

describe('FN-54 QA cycle 2', () => {
	it('#2: the scene is never cropped: `meet`, and every sun, moon and star lies inside the viewBox', () => {
		for (const period of ['pagi', 'siang', 'sore', 'malam'] as const) {
			const svg = strip(render(HeroScene, { props: { period } }).body);
			expect(svg).toMatch(/preserveAspectRatio="xMidYMax meet"/);
			expect(svg).not.toMatch(/slice/);
			for (const m of svg.matchAll(/<circle[^>]*cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
				const [cx, cy, r] = [Number(m[1]), Number(m[2]), Number(m[3])];
				expect(cy - r).toBeGreaterThanOrEqual(0);
				expect(cx - r).toBeGreaterThanOrEqual(0);
				expect(cx + r).toBeLessThanOrEqual(320);
			}
		}
	});

	it('#3: the ask field draws no box of its own inside the pill', () => {
		const file = 'src/lib/ui/home/GreetingHero.svelte';
		const css =
			compile(readFileSync(file, 'utf8'), { filename: file, css: 'external' }).css?.code ?? '';
		const input = /\binput\.svelte-[\w-]+ \{([^}]*)\}/.exec(css)?.[1] ?? '';
		expect(input).toMatch(/box-shadow:\s*none/);
		expect(input).toMatch(/border-radius:\s*0/);
	});

	it('#4: the sheet prints the per-day figure with Beranda’s compact formatter (no sen)', () => {
		const source = readFileSync('src/lib/ui/home/DailyStory.svelte', 'utf8');
		expect(source).toMatch(/formatMoneyCompact\(card\.perDay\.perDayMinor/);
		expect(source).not.toMatch(/formatMoney\(card\.perDay/);
	});
});
