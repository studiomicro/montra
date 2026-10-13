import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_INTERVAL_MS, MIN_GAP_MS } from '#lib/shared/sw-update';
import { startAutoUpdateChecks } from './auto-check';

/** A document whose visibility the test sets; counts its live listeners. */
class FakeDoc extends EventTarget {
	visibilityState: DocumentVisibilityState = 'visible';
	listeners = 0;
	override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
		this.listeners++;
		super.addEventListener(...args);
	}
	override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
		this.listeners--;
		super.removeEventListener(...args);
	}
	set(state: DocumentVisibilityState) {
		this.visibilityState = state;
		this.dispatchEvent(new Event('visibilitychange'));
	}
}

describe('startAutoUpdateChecks (FN-42b AC9)', () => {
	let doc: FakeDoc;
	let win: FakeDoc;
	let lastCheckAt: number | null;
	let check: ReturnType<typeof vi.fn<() => void>>;
	let stop: () => void;

	beforeEach(() => {
		vi.useFakeTimers();
		doc = new FakeDoc();
		win = new FakeDoc();
		// The page load itself counts as a check (the browser compares the worker on registration).
		lastCheckAt = Date.now();
		check = vi.fn<() => void>(() => {
			lastCheckAt = Date.now();
		});
		stop = startAutoUpdateChecks({
			doc: doc as unknown as Document,
			win: win as unknown as Window,
			now: () => Date.now(),
			state: () => ({
				lastCheckAt,
				inFlight: false,
				registrationReady: true,
				updateWaiting: false
			}),
			check
		});
	});
	afterEach(() => {
		stop();
		vi.useRealTimers();
	});

	it('checks every 45 minutes while visible', () => {
		vi.advanceTimersByTime(CHECK_INTERVAL_MS - 1);
		expect(check).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(check).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(CHECK_INTERVAL_MS);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it('the timer is cleared while hidden and restarted when visible again', () => {
		doc.set('hidden');
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(3 * CHECK_INTERVAL_MS);
		expect(check).not.toHaveBeenCalled();
		doc.set('visible');
		// Becoming visible after the gap checks at once, then the interval runs again.
		expect(check).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(CHECK_INTERVAL_MS);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it('visible and online respect the 10-minute gap', () => {
		doc.set('visible');
		win.dispatchEvent(new Event('online'));
		expect(check).not.toHaveBeenCalled();
		vi.advanceTimersByTime(MIN_GAP_MS);
		doc.set('visible');
		expect(check).toHaveBeenCalledTimes(1);
		doc.set('visible');
		expect(check).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(MIN_GAP_MS);
		win.dispatchEvent(new Event('online'));
		expect(check).toHaveBeenCalledTimes(2);
	});

	it('an online event while hidden does nothing', () => {
		doc.set('hidden');
		vi.advanceTimersByTime(MIN_GAP_MS);
		win.dispatchEvent(new Event('online'));
		expect(check).not.toHaveBeenCalled();
	});

	it('cleanup removes every listener and the timer', () => {
		expect(doc.listeners + win.listeners).toBe(2);
		stop();
		expect(doc.listeners + win.listeners).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(3 * CHECK_INTERVAL_MS);
		doc.set('visible');
		win.dispatchEvent(new Event('online'));
		expect(check).not.toHaveBeenCalled();
	});

	it('starting on a hidden page creates no timer', () => {
		stop();
		doc.visibilityState = 'hidden';
		stop = startAutoUpdateChecks({
			doc: doc as unknown as Document,
			win: win as unknown as Window,
			now: () => Date.now(),
			state: () => ({
				lastCheckAt,
				inFlight: false,
				registrationReady: true,
				updateWaiting: false
			}),
			check
		});
		expect(vi.getTimerCount()).toBe(0);
	});
});
