import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	BODY_MAX,
	entryProblems,
	fileProblems,
	isMonthDay,
	onThisDay,
	validEntries,
	type OnThisDayEntry
} from './on-this-day';

const ENTRIES_FILE = 'src/lib/content/on-this-day/entries.json';
const REVIEW_LOG = 'docs/features/fn-54-greeting-calendar/ON_THIS_DAY_REVIEW.md';

const good = (): OnThisDayEntry => ({
	date: '10-13',
	year: 1999,
	headline: { id: 'Judul singkat', en: 'Short title' },
	body: { id: 'Kalimat pertama. Kalimat kedua.', en: 'First sentence. Second sentence.' },
	sources: [
		{ label: 'Sumber A', url: 'https://a.example/page' },
		{ label: 'Sumber B', url: 'https://b.example/page' }
	],
	reviewedOn: '2026-10-13',
	reviewedBy: 'Pemilik'
});

describe('on-this-day validator (FN-54 criterion 36)', () => {
	it('a complete entry passes', () => {
		expect(entryProblems(good())).toEqual([]);
		expect(fileProblems([good()])).toEqual([]);
	});

	it.each([
		['one source', { sources: [{ label: 'A', url: 'https://a.example' }] }],
		[
			'a non-https URL',
			{
				sources: [
					{ label: 'A', url: 'http://a.example' },
					{ label: 'B', url: 'https://b.example' }
				]
			}
		],
		[
			'a javascript: URL',
			{
				sources: [
					{ label: 'A', url: 'javascript:alert(1)' },
					{ label: 'B', url: 'https://b.example' }
				]
			}
		],
		['a missing English headline', { headline: { id: 'Judul', en: '' } }],
		['a missing English body', { body: { id: 'Isi.' } }],
		['a 200-character body', { body: { id: 'a'.repeat(200), en: 'b' } }],
		['three sentences', { body: { id: 'Satu. Dua. Tiga.', en: 'One. Two.' } }],
		['a 61-character headline', { headline: { id: 'a'.repeat(61), en: 'b' } }],
		['13-40', { date: '13-40' }],
		['02-30', { date: '02-30' }],
		['a missing reviewedOn', { reviewedOn: undefined }],
		['a missing reviewer', { reviewedBy: ' ' }],
		['a non-integer year', { year: 1999.5 }]
	])('fails on %s', (_name, change) => {
		expect(entryProblems({ ...good(), ...change }).length).toBeGreaterThan(0);
		expect(validEntries([{ ...good(), ...change }])).toEqual([]);
	});

	it('fails on a duplicate date and year; 02-29 is a valid day', () => {
		expect(fileProblems([good(), good()])).toEqual(['#1 duplicate date and year 10-13/1999']);
		expect(fileProblems([good(), { ...good(), year: 2000 }])).toEqual([]);
		expect(isMonthDay('02-29')).toBe(true);
		expect(isMonthDay('2-29')).toBe(false);
		expect(BODY_MAX).toBe(180);
	});

	it('looks up today’s MM-DD only (the oldest event first), else null', () => {
		const entries = [good(), { ...good(), year: 1980 }];
		expect(onThisDay(entries, '2026-10-13')?.year).toBe(1980);
		expect(onThisDay(entries, '2026-10-14')).toBeNull();
		expect(onThisDay([], '2026-10-13')).toBeNull();
	});
});

describe('the shipped content (criteria 36–37)', () => {
	const file: unknown = JSON.parse(readFileSync(ENTRIES_FILE, 'utf8'));
	const log = readFileSync(REVIEW_LOG, 'utf8');

	it('entries.json passes the validator (it may be empty until the owner approves entries)', () => {
		expect(fileProblems(file)).toEqual([]);
	});

	it('every entry has a review-log line naming its date, year and both opened pages', () => {
		const missing = validEntries(file).filter((e) => {
			const line = log
				.split('\n')
				.find((l) => l.includes(`| ${e.date} |`) && l.includes(`| ${e.year} |`));
			return !line || !e.sources.every((s) => line.includes(s.url));
		});
		expect(missing).toEqual([]);
	});

	it('the cross-check catches an entry without a log line', () => {
		const line = (e: OnThisDayEntry) =>
			log.split('\n').find((l) => l.includes(`| ${e.date} |`) && l.includes(`| ${e.year} |`));
		expect(line({ ...good(), date: '01-01', year: 1 })).toBeUndefined();
	});
});
