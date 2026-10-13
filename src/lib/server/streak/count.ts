import { addDays, daysBetween } from '#lib/shared/dates';
import { FREEZE_BANK_MAX, FREEZE_EARN_EVERY } from '#lib/shared/streak';

export interface Streak {
	/**
	 * Actually-closed WIB days of the unbroken run ending today or (while today is still open) yesterday. A day
	 * bridged by a freeze keeps the run going but is not counted. 0 after a gap no freeze covered.
	 */
	current: number;
	closedToday: boolean;
}

export interface StreakHistory extends Streak {
	/** The longest run (closed days) anywhere in the dates given, the current run included. */
	longest: number;
	/** Past WIB dates a freeze bridged (never closed, never a `day_closures` row), oldest first. */
	frozen: string[];
	/** Freezes banked after the walk (0–FREEZE_BANK_MAX), ready for the next missed day. */
	bank: number;
}

/**
 * Walks the closed WIB dates (`YYYY-MM-DD`, any order, duplicates allowed) forward one calendar day at a time,
 * from the oldest given date through `today` (FN-34b owner decision B):
 * - a closed day extends the run; every FREEZE_EARN_EVERY-th actually-closed day since the run began (or since
 *   the last bridge) earns one freeze, banked up to FREEZE_BANK_MAX (an earn past the cap is not kept);
 * - a past day that is not closed is bridged by one banked freeze (the run goes on, the day is `frozen`, not
 *   counted, and the earn count starts again), or, with none banked, ends the run;
 * - today is never bridged: it is either closed or still open.
 * Dates after `today` are ignored. Pure; the caller bounds the window (STREAK_LOOKBACK_DAYS).
 */
export function streakHistory(closedOn: readonly string[], today: string): StreakHistory {
	const days = new Set(closedOn.filter((d) => d <= today));
	const closedToday = days.has(today);
	const oldest = [...days].sort()[0];
	let run = 0;
	let longest = 0;
	let bank = 0;
	let sinceEarn = 0;
	const frozen: string[] = [];
	const span = oldest === undefined ? -1 : daysBetween(oldest, today);
	for (let i = 0; i <= span; i++) {
		const day = addDays(oldest as string, i);
		if (days.has(day)) {
			run++;
			longest = Math.max(longest, run);
			sinceEarn++;
			if (sinceEarn === FREEZE_EARN_EVERY) {
				sinceEarn = 0;
				bank = Math.min(bank + 1, FREEZE_BANK_MAX);
			}
		} else if (day === today) {
			// Still open: neither a break nor a bridge.
		} else if (bank > 0) {
			bank--;
			sinceEarn = 0;
			frozen.push(day);
		} else {
			run = 0;
			sinceEarn = 0;
		}
	}
	return { current: run, closedToday, longest, frozen, bank };
}

/**
 * The streak from closed WIB dates (`YYYY-MM-DD`, any order, duplicates allowed): the run ending today, or
 * yesterday while today is not closed yet, with earned freezes bridging missed days (streakHistory). Dates after
 * `today` are ignored.
 */
export function countStreak(closedOn: readonly string[], today: string): Streak {
	const { current, closedToday } = streakHistory(closedOn, today);
	return { current, closedToday };
}

/** The longest run of closed WIB days in the dates given (the caller's bounded window), freezes applied. */
export function longestStreak(closedOn: readonly string[], today: string): number {
	return streakHistory(closedOn, today).longest;
}
