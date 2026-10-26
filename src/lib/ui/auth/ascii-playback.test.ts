import { describe, expect, it } from 'vitest';
import { createAsciiPlayer, FRAME_MS, PLAY_CAP_MS, playbackAllowed } from './ascii-playback';

/** FN-56 AC 9-11: the playback rules, with a fake requestAnimationFrame. */

function harness(options: { onScreen?: boolean; hidden?: boolean; throwAt?: number } = {}) {
	const queue = new Map<number, (now: number) => void>();
	let next = 1;
	let requested = 0;
	const drawn: number[] = [];
	let now = 1000;
	const player = createAsciiPlayer({
		requestFrame: (callback) => {
			requested += 1;
			queue.set(next, callback);
			return next++;
		},
		cancelFrame: (handle) => {
			queue.delete(handle);
		},
		draw: (playedMs) => {
			if (options.throwAt !== undefined && drawn.length >= options.throwAt) throw new Error('boom');
			drawn.push(playedMs);
		},
		onScreen: options.onScreen ?? true,
		hidden: options.hidden ?? false
	});
	/** Fires the pending frames `count` times, `step` ms apart (a 60 Hz display by default). */
	const run = (count: number, step = 16) => {
		for (let i = 0; i < count; i++) {
			now += step;
			const pending = [...queue.entries()];
			queue.clear();
			for (const [, callback] of pending) callback(now);
		}
	};
	return {
		player,
		run,
		drawn,
		pending: () => queue.size,
		requested: () => requested,
		advance: (ms: number) => (now += ms)
	};
}

describe('playbackAllowed', () => {
	const base = { reducedMotion: false, hidden: false, onScreen: true, playedMs: 0 };
	it('needs motion, a visible tab, the grid on screen and time left', () => {
		expect(playbackAllowed(base)).toBe(true);
		expect(playbackAllowed({ ...base, reducedMotion: true })).toBe(false);
		expect(playbackAllowed({ ...base, hidden: true })).toBe(false);
		expect(playbackAllowed({ ...base, onScreen: false })).toBe(false);
		expect(playbackAllowed({ ...base, playedMs: PLAY_CAP_MS })).toBe(false);
	});
});

describe('createAsciiPlayer', () => {
	it('requests no frame under reduced motion and draws nothing (AC 9)', () => {
		const h = harness();
		h.player.setReducedMotion(true);
		h.run(30);
		expect(h.requested()).toBe(0);
		expect(h.drawn).toEqual([]);
	});

	it('draws at most once per 66 ms however fast frames come, one handle at a time (AC 9, 10)', () => {
		const h = harness();
		h.player.setReducedMotion(false);
		h.run(120, 4); // a 250 Hz display for 480 ms
		expect(h.pending()).toBe(1);
		expect(h.drawn.length).toBeGreaterThan(3);
		for (let i = 1; i < h.drawn.length; i++)
			expect(h.drawn[i]! - h.drawn[i - 1]!).toBeGreaterThanOrEqual(FRAME_MS);
		expect(h.drawn.length).toBeLessThanOrEqual(Math.floor(480 / FRAME_MS));
	});

	it('pauses in a hidden tab and resumes from the same played time (AC 9)', () => {
		const h = harness();
		h.player.setReducedMotion(false);
		h.run(30);
		const played = h.player.playedMs;
		const count = h.drawn.length;
		h.player.setHidden(true);
		expect(h.pending()).toBe(0);
		h.advance(30_000);
		h.run(10);
		expect(h.drawn.length).toBe(count);
		h.player.setHidden(false);
		h.run(1);
		// The first frame after the return only sets the clock: the hidden 30 s are not played.
		expect(h.player.playedMs).toBe(played);
		h.run(10);
		expect(h.player.playedMs).toBeGreaterThan(played);
		expect(h.player.playedMs).toBeLessThan(played + 200);
	});

	it('pauses off screen the same way (AC 9)', () => {
		const h = harness();
		h.player.setReducedMotion(false);
		h.run(10);
		h.player.setOnScreen(false);
		expect(h.player.running).toBe(false);
		const played = h.player.playedMs;
		h.advance(5_000);
		h.player.setOnScreen(true);
		h.run(2);
		expect(h.player.playedMs - played).toBeLessThanOrEqual(16);
	});

	it('starts paused when the grid is off screen or the tab hidden', () => {
		for (const options of [{ onScreen: false }, { hidden: true }]) {
			const h = harness(options);
			h.player.setReducedMotion(false);
			expect(h.requested()).toBe(0);
		}
	});

	it('back to the still frame at once when reduced motion turns on while playing (AC 9)', () => {
		const h = harness();
		h.player.setReducedMotion(false);
		h.run(20);
		h.player.setReducedMotion(true);
		expect(h.drawn.at(-1)).toBe(0);
		expect(h.pending()).toBe(0);
		const count = h.drawn.length;
		h.run(10);
		expect(h.drawn.length).toBe(count);
	});

	it('freezes after a minute of play and requests nothing more (AC 10)', () => {
		const h = harness();
		h.player.setReducedMotion(false);
		h.run(4000, 16); // 64 s at 60 Hz
		expect(h.player.playedMs).toBe(PLAY_CAP_MS);
		expect(h.drawn.at(-1)).toBe(PLAY_CAP_MS);
		expect(h.pending()).toBe(0);
		const requested = h.requested();
		h.player.setHidden(true);
		h.player.setHidden(false);
		h.run(10);
		expect(h.requested()).toBe(requested);
	});

	it('a long stall counts as a few frames of play, never a jump', () => {
		const h = harness();
		h.player.setReducedMotion(false);
		h.run(2);
		const played = h.player.playedMs;
		h.run(1, 10_000);
		expect(h.player.playedMs - played).toBeLessThanOrEqual(4 * FRAME_MS);
	});

	it('leaves no frame behind after destroy (AC 10)', () => {
		const h = harness();
		h.player.setReducedMotion(false);
		h.run(5);
		h.player.destroy();
		expect(h.pending()).toBe(0);
		h.player.setHidden(false);
		h.player.setOnScreen(true);
		h.player.setReducedMotion(false);
		expect(h.pending()).toBe(0);
	});

	it('a draw that throws stops the player and is not rethrown (AC 11)', () => {
		const h = harness({ throwAt: 1 });
		h.player.setReducedMotion(false);
		expect(() => h.run(30)).not.toThrow();
		expect(h.drawn.length).toBe(1);
		expect(h.pending()).toBe(0);
		h.player.setHidden(true);
		h.player.setHidden(false);
		expect(h.pending()).toBe(0);
	});
});
