import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { wibDateString } from './dates';
import { en } from './i18n-en';
import { greetingPeriod, GREETINGS, wibHour } from './greeting';

const at = (iso: string) => Date.parse(iso);

describe('greetingPeriod and the WIB date (FN-54 criterion 1)', () => {
	it.each([
		['2026-10-12T20:59:59Z', 'malam', '2026-10-13'],
		['2026-10-12T21:00:00Z', 'pagi', '2026-10-13'],
		['2026-10-13T03:59:59Z', 'pagi', '2026-10-13'],
		['2026-10-13T04:00:00Z', 'siang', '2026-10-13'],
		['2026-10-13T07:59:59Z', 'siang', '2026-10-13'],
		['2026-10-13T08:00:00Z', 'sore', '2026-10-13'],
		['2026-10-13T10:59:59Z', 'sore', '2026-10-13'],
		['2026-10-13T11:00:00Z', 'malam', '2026-10-13'],
		['2026-10-13T16:59:59Z', 'malam', '2026-10-13'],
		['2026-10-13T17:00:00Z', 'malam', '2026-10-14']
	])('%s → %s on %s', (iso, period, date) => {
		expect(greetingPeriod(at(iso))).toBe(period);
		expect(wibDateString(at(iso))).toBe(date);
	});

	it('from 17:00Z to 23:59Z the UTC date differs from the WIB date', () => {
		for (const iso of ['2026-10-13T17:00:00Z', '2026-10-13T23:59:59Z']) {
			expect(new Date(at(iso)).toISOString().slice(0, 10)).toBe('2026-10-13');
			expect(wibDateString(at(iso))).toBe('2026-10-14');
		}
	});

	it('every WIB hour of a day maps to exactly the owner’s boundaries', () => {
		const base = at('2026-10-12T17:00:00Z'); // 00:00 WIB on 13 Oct
		const periods = Array.from({ length: 24 }, (_, h) => greetingPeriod(base + h * 3_600_000));
		expect(periods.map((p, h) => `${h}:${p}`).join(' ')).toBe(
			[
				...Array.from({ length: 4 }, (_, h) => `${h}:malam`),
				...Array.from({ length: 7 }, (_, h) => `${h + 4}:pagi`),
				...Array.from({ length: 4 }, (_, h) => `${h + 11}:siang`),
				...Array.from({ length: 3 }, (_, h) => `${h + 15}:sore`),
				...Array.from({ length: 6 }, (_, h) => `${h + 18}:malam`)
			].join(' ')
		);
		expect(wibHour(base)).toBe(0);
	});

	it('never reads the device clock or its zone', () => {
		const source = String(greetingPeriod) + String(wibHour);
		expect(source).not.toMatch(/getHours|new Date|Date\.now/);
	});

	it('greets in Indonesian and English (morning, afternoon, afternoon, evening)', () => {
		expect(Object.values(GREETINGS)).toEqual([
			'Selamat pagi.',
			'Selamat siang.',
			'Selamat sore.',
			'Selamat malam.'
		]);
		expect(Object.values(GREETINGS).map((p) => en[p])).toEqual([
			'Good morning.',
			'Good afternoon.',
			'Good afternoon.',
			'Good evening.'
		]);
	});
});

describe('FN-54 files never read the device clock’s zone or the UTC date (criterion 40)', () => {
	const FILES = [
		'src/lib/shared/greeting.ts',
		'src/lib/shared/calendar.ts',
		'src/lib/shared/daily-story.ts',
		'src/lib/shared/on-this-day.ts',
		'src/lib/server/calendar/month.ts',
		'src/routes/(app)/kalender/+page.server.ts',
		'src/routes/(app)/kalender/+page.svelte',
		'src/lib/ui/home/GreetingHero.svelte',
		'src/lib/ui/home/HeroScene.svelte',
		'src/lib/ui/home/BudgetChip.svelte',
		'src/lib/ui/home/DailyStory.svelte',
		'src/lib/ui/kit/CalendarBadge.svelte'
	];
	it.each(FILES)('%s', (file) => {
		const source = readFileSync(file, 'utf8');
		expect(source).not.toMatch(/\.get(?:Hours|Date|Day|Month|FullYear)\(/);
		expect(source).not.toMatch(/toISOString\(\)\.slice\(0, ?10\)/);
		expect(source).not.toMatch(/parseFloat|toFixed\(/);
	});
});
