import { motionAllowed } from '#lib/ui/motion';

/**
 * FN-56 playback of the auth ASCII field: requestAnimationFrame, drawn at most once per FRAME_MS (about 15 fps),
 * advanced by played time (never wall time) so a resume continues where it stopped, and frozen for good after
 * PLAY_CAP_MS of play. It runs only while motion is allowed (`motionAllowed`: no reduced motion, tab visible) and
 * the grid is on screen. The browser calls are passed in, so the rules are tested without a DOM.
 */
export const FRAME_MS = 66;
export const PLAY_CAP_MS = 60_000;
/** A longer gap between two frames (a stalled tab) counts as this much play, so a resume never jumps. */
const MAX_STEP_MS = 4 * FRAME_MS;

export interface PlaybackState {
	reducedMotion: boolean;
	hidden: boolean;
	onScreen: boolean;
	playedMs: number;
}

export function playbackAllowed(state: PlaybackState): boolean {
	return (
		motionAllowed({ reducedMotion: state.reducedMotion, hidden: state.hidden }) &&
		state.onScreen &&
		state.playedMs < PLAY_CAP_MS
	);
}

/**
 * `draw(playedMs)` paints the frame at that much play; draw(0) is the still frame. A draw that throws stops the
 * player for good and leaves whatever is on screen: the field is decoration and never breaks the page.
 * Starts paused under reduced motion until told otherwise.
 */
export function createAsciiPlayer(deps: {
	requestFrame: (callback: (now: number) => void) => number;
	cancelFrame: (handle: number) => void;
	draw: (playedMs: number) => void;
	onScreen: boolean;
	hidden: boolean;
}) {
	const state: PlaybackState = {
		reducedMotion: true,
		hidden: deps.hidden,
		onScreen: deps.onScreen,
		playedMs: 0
	};
	let handle: number | null = null;
	let lastNow: number | null = null;
	let drawnAt = 0;
	let broken = false;

	function paint(playedMs: number): void {
		try {
			deps.draw(playedMs);
		} catch {
			broken = true;
			stop();
		}
	}

	function stop(): void {
		if (handle !== null) deps.cancelFrame(handle);
		handle = null;
		lastNow = null;
	}

	function tick(now: number): void {
		handle = null;
		if (lastNow !== null) {
			state.playedMs = Math.min(
				PLAY_CAP_MS,
				state.playedMs + Math.min(MAX_STEP_MS, Math.max(0, now - lastNow))
			);
		}
		lastNow = now;
		if (state.playedMs - drawnAt >= FRAME_MS || state.playedMs >= PLAY_CAP_MS) {
			drawnAt = state.playedMs;
			paint(state.playedMs);
		}
		sync();
	}

	function sync(): void {
		if (broken || !playbackAllowed(state)) {
			stop();
			return;
		}
		if (handle === null) handle = deps.requestFrame(tick);
	}

	return {
		setReducedMotion(on: boolean) {
			const was = state.reducedMotion;
			state.reducedMotion = on;
			// Switched on while playing: back to the still frame at once.
			if (on && !was && state.playedMs > 0 && !broken) {
				stop();
				drawnAt = 0;
				paint(0);
			}
			sync();
		},
		setHidden(hidden: boolean) {
			state.hidden = hidden;
			sync();
		},
		setOnScreen(onScreen: boolean) {
			state.onScreen = onScreen;
			sync();
		},
		destroy() {
			broken = true;
			stop();
		},
		get playedMs() {
			return state.playedMs;
		},
		get running() {
			return handle !== null;
		}
	};
}
