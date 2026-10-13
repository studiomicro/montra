/**
 * Motion (FN-40 Part 2, FN-51). The durations mirror the `--duration-*` tokens in docs/design/tokens.css (a test
 * keeps them equal); every motion is off under `prefers-reduced-motion: reduce` and in a hidden tab.
 */
export const DURATION_MS = { fast: 150, base: 200, slow: 300, loop: 1200 } as const;

/** `--ease` as the Web Animations API takes it (a test keeps it equal to the token). */
export const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/** Loading skeletons draw at most this many bars, whatever the caller asks for. */
export const SKELETON_MAX_ROWS = 8;
export function skeletonRows(rows: number): number {
	return Math.min(SKELETON_MAX_ROWS, Math.max(0, Math.floor(rows)));
}

/**
 * Whether script-driven motion may run at all (FN-51 I): never under reduced motion, never in a hidden tab (a
 * navigation or save that finishes in the background plays nothing; the end state is there when the tab returns).
 */
export function motionAllowed(state: { reducedMotion: boolean; hidden: boolean }): boolean {
	return !state.reducedMotion && !state.hidden;
}

/**
 * The hero number's interpolator: whole minor units at every step and exactly `to` at the end, so the figure
 * on screen is always a real amount and settles on the server's figure, never a rounded or fractional one.
 */
export function interpolateMinor(from: number, to: number): (t: number) => number {
	return (t) => (t >= 1 ? to : Math.round(from + (to - from) * t));
}

/**
 * How long the hero number counts from `from` to `to`: no animation when nothing changes, when the currency
 * changed (a count between two currencies would show amounts that never existed), under reduced motion or in a
 * hidden tab.
 */
export function countUpDuration(change: {
	from: number;
	to: number;
	sameCurrency: boolean;
	reducedMotion: boolean;
	hidden?: boolean;
}): number {
	if (!motionAllowed({ reducedMotion: change.reducedMotion, hidden: change.hidden ?? false }))
		return 0;
	if (!change.sameCurrency || change.from === change.to) return 0;
	return DURATION_MS.slow;
}

/**
 * Whether a client-side navigation plays the page-enter animation: only where Web Animations exist, never under
 * reduced motion or in a hidden tab, and only when the page changes — a filter or query change on the same page
 * swaps its list in place.
 */
export function pageFadeAllowed(nav: {
	supported: boolean;
	reducedMotion: boolean;
	hidden?: boolean;
	from: string | undefined;
	to: string | undefined;
}): boolean {
	return (
		nav.supported &&
		motionAllowed({ reducedMotion: nav.reducedMotion, hidden: nav.hidden ?? false }) &&
		!!nav.from &&
		!!nav.to &&
		nav.from !== nav.to
	);
}

/**
 * FN-51 A: the new page fades in and rises 8 px on `<main>` (transform and opacity only; fill mode `none`, so no
 * transform is left behind and `position: fixed` descendants sit where they belong once it is over).
 */
export function pageEnterKeyframes(): Keyframe[] {
	return [
		{ opacity: 0, transform: 'translateY(8px)' },
		{ opacity: 1, transform: 'translateY(0)' }
	];
}
export const PAGE_ENTER_OPTIONS: KeyframeAnimationOptions = {
	duration: DURATION_MS.base,
	easing: EASE,
	fill: 'none'
};

/**
 * FN-51 B3: a row removed in place fades and shrinks a little (Svelte runs this through the Web Animations API:
 * no inline style, no injected stylesheet). Under reduced motion the row is removed at once.
 */
export function rowOut(
	_node: Element,
	state: { reducedMotion: boolean }
): { duration: number; css: (t: number) => string } {
	return {
		duration: state.reducedMotion ? 0 : DURATION_MS.fast,
		css: (t) => `opacity: ${t}; transform: scale(${0.98 + 0.02 * t})`
	};
}

/**
 * FN-51 G: the streak chip hops once when the count grows while Beranda stays mounted — never on first paint (the
 * caller compares with the value it had), on a decrease, under reduced motion or in a hidden tab.
 */
export function streakHop(
	prev: number | null | undefined,
	next: number | null | undefined,
	reducedMotion: boolean,
	hidden: boolean
): boolean {
	if (typeof prev !== 'number' || typeof next !== 'number') return false;
	return next > prev && motionAllowed({ reducedMotion, hidden });
}

/**
 * FN-51 B2: the import batch an action result names (a new import, an undo or a move) — that row alone replays
 * its enter animation. A page without an action result, or a result without an id, marks no row.
 */
export function highlightedBatchId(form: unknown): string | null {
	if (!form || typeof form !== 'object' || !('batchId' in form)) return null;
	const id = (form as { batchId: unknown }).batchId;
	return typeof id === 'string' && id.length > 0 ? id : null;
}

/** localStorage key (FN-51): the WIB date on which the installed app last greeted with Koko's wave. */
export const WELCOME_WAVE_KEY = 'montra-welcome-wib-date';

/**
 * FN-51 Koko "welcome back": once per WIB calendar date per device, in the installed (standalone) app only, with
 * motion allowed and the tab visible. `today` is the WIB date (`wibTodayString`), never the UTC date.
 */
export function welcomeWaveDue(state: {
	standalone: boolean;
	reducedMotion: boolean;
	hidden: boolean;
	lastShown: string | null;
	today: string;
}): boolean {
	if (!state.standalone) return false;
	if (!motionAllowed({ reducedMotion: state.reducedMotion, hidden: state.hidden })) return false;
	return state.lastShown !== state.today;
}
