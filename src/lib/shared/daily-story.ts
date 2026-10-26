import { addDays, isDateString } from './dates.ts';
import type { OnThisDayEntry } from './on-this-day.ts';

/**
 * FN-54 Part D: the once-a-day greeting sheet. Its cards come only from figures Beranda's load already holds (no
 * extra query) plus an owner-reviewed "on this day" entry. Device-only by design (owner decision 3): two display
 * cookies, set and read like the hidden-amounts cookie, never a D1 row.
 */

/** The WIB date (`YYYY-MM-DD`) on which this device last dismissed or finished the sheet. */
export const STORY_SEEN_COOKIE = 'montra-sapaan-seen';
/** `1` when the user switched the sheet off (Pengaturan › Tampilan or "Matikan sapaan harian"). */
export const STORY_OFF_COOKIE = 'montra-sapaan-off';
/** A year, like the theme and hidden-amounts cookies. */
export const STORY_COOKIE_MAX_AGE = 31_536_000;

/** True when the sheet is due on the WIB date `today`: not switched off and not yet seen today. */
export function storyDue(
	cookies: { seen: string | undefined; off: string | undefined },
	today: string
): boolean {
	if (storyOff(cookies.off)) return false;
	const seen = cookies.seen;
	// A cookie is a wish, not a fact: anything but a real date reads as "not seen" (length-capped before parsing).
	return !(typeof seen === 'string' && seen.length === 10 && isDateString(seen) && seen === today);
}

/** True when the off cookie says the sheet is switched off. */
export function storyOff(off: string | undefined): boolean {
	return off === '1';
}

/** The `document.cookie` assignment that marks `today` (the server's WIB date) as seen on this device. */
export function storySeenCookie(today: string, secure: boolean): string {
	return `${STORY_SEEN_COOKIE}=${today}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${STORY_COOKIE_MAX_AGE}`;
}

export interface StoryBill {
	id: string;
	name: string;
	amountMinor: number;
	currency: string;
	nextChargeOn: string;
	inDays: number;
	isDemo: boolean;
}

export type StoryCard =
	/** Yesterday's spending: the bar Beranda's 14-day chart shows for that date (null: too large to show). */
	| { kind: 'kemarin'; date: string; minor: number | null; currency: string }
	/** Bills due in the next 7 days and, with a budget that has money left, the per-day figure. */
	| {
			kind: 'hari-ini';
			bills: StoryBill[];
			perDay: { perDayMinor: number; days: number; currency: string } | null;
	  }
	/** The owner-reviewed history card for today's MM-DD. */
	| { kind: 'pada-hari-ini'; entry: OnThisDayEntry };

/**
 * The sheet's cards on the WIB date `today`, from what Beranda already loaded. None for an account without a wallet
 * (nothing to greet with yet); "Hari ini" only with bills or a budget that has money left; "Pada hari ini" only with a
 * reviewed entry. An empty list means the sheet never opens.
 */
export function storyCards(input: {
	today: string;
	walletCount: number;
	currency: string;
	bars: readonly { date: string; minor: number | null }[];
	upcoming: readonly StoryBill[] | null;
	safeToSpend:
		| { kind: 'left'; perDayMinor: number; days: number }
		| { kind: 'spent' }
		| { kind: 'over' }
		| null;
	budgetCurrency: string;
	entry: OnThisDayEntry | null;
}): StoryCard[] {
	if (input.walletCount === 0) return [];
	const cards: StoryCard[] = [];
	const yesterday = addDays(input.today, -1);
	const bar = input.bars.find((b) => b.date === yesterday);
	if (bar)
		cards.push({ kind: 'kemarin', date: yesterday, minor: bar.minor, currency: input.currency });
	const bills = input.upcoming ?? [];
	const s = input.safeToSpend;
	const perDay =
		s?.kind === 'left'
			? { perDayMinor: s.perDayMinor, days: s.days, currency: input.budgetCurrency }
			: null;
	if (bills.length > 0 || perDay) cards.push({ kind: 'hari-ini', bills: [...bills], perDay });
	if (input.entry) cards.push({ kind: 'pada-hari-ini', entry: input.entry });
	return cards;
}

/**
 * Whether the sheet may open now, in the browser after hydration: it has cards, the tab is visible and no other
 * dialog (the budget sheet, "Baru di Montra", Tambah) is open. Never on first paint and never without JavaScript,
 * because only the mounted page calls this.
 */
export function storyMayOpen(state: {
	cards: number;
	hidden: boolean;
	dialogOpen: boolean;
}): boolean {
	return state.cards > 0 && !state.hidden && !state.dialogOpen;
}
