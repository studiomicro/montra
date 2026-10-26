import { describe, expect, it } from 'vitest';
import { wibDateString } from './dates';
import {
	STORY_OFF_COOKIE,
	STORY_SEEN_COOKIE,
	storyCards,
	storyDue,
	storyMayOpen,
	storySeenCookie
} from './daily-story';
import type { OnThisDayEntry } from './on-this-day';

describe('storyDue (FN-54 criteria 32–33)', () => {
	const today = '2026-10-13';
	it.each([
		[{ seen: undefined, off: undefined }, true],
		[{ seen: '2026-10-12', off: undefined }, true],
		[{ seen: '2026-10-13', off: undefined }, false],
		[{ seen: undefined, off: '1' }, false],
		[{ seen: '2026-10-12', off: '1' }, false],
		// A cookie is untrusted: anything but a real date is "not seen"; only exactly `1` is off.
		[{ seen: '2026-10-13 ', off: undefined }, true],
		[{ seen: 'x'.repeat(4000), off: undefined }, true],
		[{ seen: undefined, off: 'true' }, true],
		[{ seen: undefined, off: '' }, true]
	])('%o → %s', (cookies, due) => {
		expect(storyDue(cookies, today)).toBe(due);
	});

	it('a dismissal at 23:59:59 WIB is not "seen" at 00:00:00 WIB the next day', () => {
		const dismissedAt = Date.parse('2026-10-13T16:59:59Z'); // 23:59:59 WIB, 13 Oct
		const reloadAt = Date.parse('2026-10-13T17:00:00Z'); // 00:00:00 WIB, 14 Oct
		const seen = wibDateString(dismissedAt);
		expect(seen).toBe('2026-10-13');
		expect(storyDue({ seen, off: undefined }, wibDateString(dismissedAt))).toBe(false);
		expect(storyDue({ seen, off: undefined }, wibDateString(reloadAt))).toBe(true);
	});

	it('the seen cookie: the WIB date, a year, Lax, Secure only on https', () => {
		expect(STORY_SEEN_COOKIE).toBe('montra-sapaan-seen');
		expect(STORY_OFF_COOKIE).toBe('montra-sapaan-off');
		expect(storySeenCookie('2026-10-13', true)).toBe(
			'montra-sapaan-seen=2026-10-13; Path=/; SameSite=Lax; Secure; Max-Age=31536000'
		);
		expect(storySeenCookie('2026-10-13', false)).not.toContain('Secure');
	});
});

describe('storyMayOpen (criterion 34)', () => {
	it.each([
		[{ cards: 2, hidden: false, dialogOpen: false }, true],
		[{ cards: 0, hidden: false, dialogOpen: false }, false],
		[{ cards: 2, hidden: true, dialogOpen: false }, false],
		[{ cards: 2, hidden: false, dialogOpen: true }, false]
	])('%o → %s', (state, open) => {
		expect(storyMayOpen(state)).toBe(open);
	});
});

const bars = [
	{ date: '2026-10-12', minor: 54_000 },
	{ date: '2026-10-13', minor: 0 }
];
const base = {
	today: '2026-10-13',
	walletCount: 1,
	currency: 'IDR',
	bars,
	upcoming: [],
	safeToSpend: null,
	budgetCurrency: 'IDR',
	entry: null
};
const entry: OnThisDayEntry = {
	date: '10-13',
	year: 1999,
	headline: { id: 'Judul', en: 'Title' },
	body: { id: 'Isi.', en: 'Body.' },
	sources: [
		{ label: 'A', url: 'https://a.example' },
		{ label: 'B', url: 'https://b.example' }
	],
	reviewedOn: '2026-10-13',
	reviewedBy: 'Pemilik'
};

describe('storyCards (criteria 31, 34, 35)', () => {
	it('yesterday is the bar Beranda shows for that date (not recomputed)', () => {
		expect(storyCards(base)).toEqual([
			{ kind: 'kemarin', date: '2026-10-12', minor: 54_000, currency: 'IDR' }
		]);
		expect(storyCards({ ...base, bars: [{ date: '2026-10-12', minor: null }] })[0]).toMatchObject({
			minor: null
		});
	});

	it('no wallet: no cards at all, so the sheet never opens (even with an entry)', () => {
		expect(storyCards({ ...base, walletCount: 0, entry })).toEqual([]);
	});

	it('"Hari ini": due bills or a budget with money left (its per-day figure, the budget currency); skipped without', () => {
		const bill = {
			id: 'b',
			name: 'Listrik',
			amountMinor: 250_000,
			currency: 'IDR',
			nextChargeOn: '2026-10-15',
			inDays: 2,
			isDemo: false
		};
		expect(storyCards({ ...base, upcoming: [bill] })[1]).toEqual({
			kind: 'hari-ini',
			bills: [bill],
			perDay: null
		});
		expect(
			storyCards({
				...base,
				safeToSpend: { kind: 'left', perDayMinor: 70_000, days: 19 },
				budgetCurrency: 'USD'
			})[1]
		).toEqual({
			kind: 'hari-ini',
			bills: [],
			perDay: { perDayMinor: 70_000, days: 19, currency: 'USD' }
		});
		expect(storyCards({ ...base, safeToSpend: { kind: 'spent' } })).toHaveLength(1);
		expect(storyCards({ ...base, safeToSpend: { kind: 'over' }, upcoming: null })).toHaveLength(1);
	});

	it('"Pada hari ini" only with a reviewed entry; never a filler card', () => {
		expect(storyCards({ ...base, entry }).map((c) => c.kind)).toEqual(['kemarin', 'pada-hari-ini']);
		expect(storyCards(base).map((c) => c.kind)).toEqual(['kemarin']);
	});
});
