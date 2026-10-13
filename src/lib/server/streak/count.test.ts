import { describe, expect, it } from 'vitest';
import { addDays } from '#lib/shared/dates';
import { countStreak, longestStreak, streakHistory } from './count';

describe('countStreak', () => {
	it('is 0 with no closures at all', () => {
		expect(countStreak([], '2026-10-08')).toEqual({ current: 0, closedToday: false });
	});

	it('counts today alone as 1', () => {
		expect(countStreak(['2026-10-08'], '2026-10-08')).toEqual({ current: 1, closedToday: true });
	});

	it('keeps yesterday’s streak while today is still open', () => {
		expect(countStreak(['2026-10-07', '2026-10-06'], '2026-10-08')).toEqual({
			current: 2,
			closedToday: false
		});
	});

	it('grows by exactly one per unbroken day, in any order', () => {
		const days = ['2026-10-08', '2026-10-06', '2026-10-07'];
		expect(countStreak(days, '2026-10-08').current).toBe(3);
		expect(countStreak([...days, '2026-10-05'], '2026-10-08').current).toBe(4);
	});

	it('is 0 when the last close was three days ago (a gap resets)', () => {
		expect(countStreak(['2026-10-05', '2026-10-04'], '2026-10-08')).toEqual({
			current: 0,
			closedToday: false
		});
	});

	it('stops at the first missing day', () => {
		expect(countStreak(['2026-10-08', '2026-10-07', '2026-10-05'], '2026-10-08').current).toBe(2);
	});

	it('runs across month and year boundaries', () => {
		expect(countStreak(['2026-11-01', '2026-10-31', '2026-10-30'], '2026-11-01').current).toBe(3);
		expect(countStreak(['2027-01-01', '2026-12-31'], '2027-01-01').current).toBe(2);
		expect(countStreak(['2028-03-01', '2028-02-29', '2028-02-28'], '2028-03-01').current).toBe(3);
	});

	it('ignores duplicates and dates after today', () => {
		expect(
			countStreak(['2026-10-09', '2026-10-08', '2026-10-08', '2026-10-07'], '2026-10-08')
		).toEqual({ current: 2, closedToday: true });
	});
});

/** `n` consecutive WIB dates starting at `from`. */
const run = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i));

describe('streakHistory: freezes (FN-34b owner decision B)', () => {
	it('7 closed days earn a freeze that bridges one missed day; the run goes on and the day is frozen', () => {
		// 1–7 Oct closed, 8 Oct missed, 9 Oct closed; today 9 Oct.
		const closed = [...run('2026-10-01', 7), '2026-10-09'];
		const h = streakHistory(closed, '2026-10-09');
		expect(h.current).toBe(8);
		expect(h.frozen).toEqual(['2026-10-08']);
		expect(h.bank).toBe(0);
		expect(countStreak(closed, '2026-10-09')).toEqual({ current: 8, closedToday: true });
	});

	it('without 7 days in a row no freeze is ever earned: one missed day breaks the run (FN-34 unchanged)', () => {
		const closed = ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05', '2026-10-06'];
		const h = streakHistory(closed, '2026-10-06');
		expect(h.current).toBe(3);
		expect(h.frozen).toEqual([]);
		expect(h.longest).toBe(3);
		// 6 in a row, then a gap: still nothing banked.
		expect(streakHistory([...run('2026-10-01', 6), '2026-10-08'], '2026-10-08').current).toBe(1);
	});

	it('two banked freezes bridge two missed days in a row; a third missed day breaks the run on that day', () => {
		const closed = run('2026-10-01', 14); // 1–14 Oct: two freezes earned
		expect(streakHistory(closed, '2026-10-14').bank).toBe(2);
		// 15 and 16 missed, today 17 open: both bridged, the run still stands at 14.
		const kept = streakHistory(closed, '2026-10-17');
		expect(kept).toMatchObject({ current: 14, frozen: ['2026-10-15', '2026-10-16'], bank: 0 });
		// 17 missed too, today 18: no freeze left, the run ends on the 17th.
		const broken = streakHistory(closed, '2026-10-18');
		expect(broken.current).toBe(0);
		expect(broken.longest).toBe(14);
		expect(broken.frozen).toEqual(['2026-10-15', '2026-10-16']);
	});

	it('the bank never holds more than 2, however long the run', () => {
		expect(streakHistory(run('2026-01-01', 70), '2026-03-11').bank).toBe(2);
	});

	it('after a bridge the earn count starts again from the next actual close (a frozen day never counts)', () => {
		// 1–7 closed (1 freeze), 8 bridged, 9–14 closed (6 closes): bank still 0; 15 closed (7th): bank 1.
		const closed = [...run('2026-10-01', 7), ...run('2026-10-09', 6)];
		expect(streakHistory(closed, '2026-10-14').bank).toBe(0);
		expect(streakHistory([...closed, '2026-10-15'], '2026-10-15').bank).toBe(1);
		// Without the 15th, a miss on the 15th breaks the run (no freeze banked).
		expect(streakHistory(closed, '2026-10-16').current).toBe(0);
	});

	it('today is never bridged: an open today keeps yesterday’s run and spends nothing', () => {
		const h = streakHistory(run('2026-10-01', 7), '2026-10-08');
		expect(h).toMatchObject({ current: 7, closedToday: false, frozen: [], bank: 1 });
	});

	it('bridges across a WIB month boundary', () => {
		const closed = [...run('2026-10-24', 7), '2026-11-01'];
		const h = streakHistory(closed, '2026-11-01');
		expect(h.frozen).toEqual(['2026-10-31']);
		expect(h.current).toBe(8);
	});
});

describe('longestStreak (FN-34b)', () => {
	it('is the longest run anywhere, not the run ending today', () => {
		// A 10-day run two months ago, a 3-day run now.
		const closed = [...run('2026-08-01', 10), ...run('2026-10-06', 3)];
		expect(longestStreak(closed, '2026-10-08')).toBe(10);
		expect(countStreak(closed, '2026-10-08').current).toBe(3);
	});

	it('is 0 without closures and equals current for a single run', () => {
		expect(longestStreak([], '2026-10-08')).toBe(0);
		expect(longestStreak(run('2026-10-04', 5), '2026-10-08')).toBe(5);
	});
});
