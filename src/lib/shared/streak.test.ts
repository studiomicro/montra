import { describe, expect, it } from 'vitest';
import { budgetCalendar, closureCalendar, STREAK_MILESTONES } from './streak';

describe('streak calendars (FN-34b)', () => {
	it('the closure calendar marks closed, frozen, missed, today and future days of one WIB month', () => {
		const days = closureCalendar(
			'2026-10',
			'2026-10-05',
			new Set(['2026-10-01', '2026-10-02', '2026-10-04']),
			new Set(['2026-10-03'])
		);
		expect(days).toHaveLength(31);
		expect(days.slice(0, 6)).toEqual([
			{ date: '2026-10-01', state: 'closed' },
			{ date: '2026-10-02', state: 'closed' },
			{ date: '2026-10-03', state: 'frozen' },
			{ date: '2026-10-04', state: 'closed' },
			{ date: '2026-10-05', state: 'today' },
			{ date: '2026-10-06', state: 'future' }
		]);
		expect(closureCalendar('2026-10', '2026-10-05', new Set(['2026-10-05']), new Set())[4]).toEqual(
			{ date: '2026-10-05', state: 'closed' }
		);
		expect(closureCalendar('2026-09', '2026-10-05', new Set(), new Set())[29]).toEqual({
			date: '2026-09-30',
			state: 'missed'
		});
	});

	it('the budget calendar shows stored verdicts, no_budget for past days without one, and never judges today', () => {
		const days = budgetCalendar(
			'2026-02',
			'2026-02-03',
			new Map([
				['2026-02-01', 'within' as const],
				['2026-02-03', 'over' as const]
			])
		);
		expect(days).toHaveLength(28);
		expect(days.slice(0, 4).map((d) => d.state)).toEqual([
			'within',
			'no_budget',
			'today',
			'future'
		]);
	});

	it('milestones are the fixed 7, 30 and 100 days', () => {
		expect(STREAK_MILESTONES).toEqual([7, 30, 100]);
	});
});
