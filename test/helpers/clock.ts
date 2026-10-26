import { onTestFinished, vi } from 'vitest';
import { THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';

/**
 * Freezes `Date` (timers stay real) in the middle of the current throttle window and returns that instant. A test
 * that seeds a counter for "the current window" and then calls the code under test reads two real clocks, which
 * disagree when a window boundary falls between them; a frozen clock cannot cross it. The real clock comes back when the test ends.
 */
export function pinThrottleWindow(): number {
	const now =
		Math.floor(Date.now() / THROTTLE_WINDOW_MS) * THROTTLE_WINDOW_MS + THROTTLE_WINDOW_MS / 2;
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now);
	onTestFinished(() => {
		vi.useRealTimers();
	});
	return now;
}
