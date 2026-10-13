/**
 * FN-51: pull-to-refresh in the installed app (Beranda and Riwayat). Pure decisions; the component owns the touch
 * listeners and the indicator.
 */

/** The pull distance (CSS px) that releases a refresh. */
export const PULL_THRESHOLD = 72;

/**
 * Whether a touch that starts now may become a pull: the installed app only, the page scrolled to the very top,
 * the tab visible, no dialog open and no refresh already running.
 */
export function pullMayStart(state: {
	standalone: boolean;
	scrollY: number;
	hidden: boolean;
	dialogOpen: boolean;
	refreshing: boolean;
}): boolean {
	return (
		state.standalone &&
		state.scrollY <= 0 &&
		!state.hidden &&
		!state.dialogOpen &&
		!state.refreshing
	);
}

/**
 * How far a pull has come, 0–1 of the threshold. A finger moving up (scrolling the list) is 0, and so is any move
 * once the page has scrolled away from the top: only a downward drag from the top counts.
 */
export function pullProgress(startY: number, y: number, scrollY: number): number {
	if (scrollY > 0) return 0;
	const dy = y - startY;
	if (dy <= 0) return 0;
	return Math.min(1, dy / PULL_THRESHOLD);
}
