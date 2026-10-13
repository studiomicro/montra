import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_GAP_MS } from '#lib/shared/sw-update';

/** Counts live listeners on a stand-in for `document`, `window` or the service-worker container. */
class Target extends EventTarget {
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
}

/** A registration whose `update()` the test resolves by hand. */
function fakeRegistration() {
	const reg = new Target() as Target & {
		waiting: null;
		installing: null;
		active: null;
		update: ReturnType<typeof vi.fn>;
		finish: (ok: boolean) => void;
	};
	let settle: ((ok: boolean) => void) | null = null;
	Object.assign(reg, { waiting: null, installing: null, active: null });
	reg.update = vi.fn(
		() =>
			new Promise<void>((resolve, reject) => {
				settle = (ok) => (ok ? resolve() : reject(new Error('offline')));
			})
	);
	reg.finish = (ok) => settle?.(ok);
	return reg;
}

const load = async () => {
	vi.resetModules();
	return import('./update.svelte');
};

let doc: Target;
let win: Target;
beforeEach(() => {
	vi.useFakeTimers();
	doc = new Target();
	win = new Target();
	vi.stubGlobal('document', doc);
	vi.stubGlobal('window', win);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('startServiceWorker without a worker (FN-42b AC13)', () => {
	it('under vite dev (disabled): unavailable, no listener, no timer', async () => {
		const container = new Target();
		vi.stubGlobal('navigator', { serviceWorker: container });
		const { pwaUpdate, startServiceWorker } = await load();
		const stop = startServiceWorker(false);
		expect(pwaUpdate.registration).toBe('unavailable');
		expect(doc.listeners + win.listeners + container.listeners).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		stop();
	});

	it('a browser without serviceWorker: nothing throws, unavailable, nothing attached', async () => {
		vi.stubGlobal('navigator', {});
		const { pwaUpdate, startServiceWorker, checkForUpdate } = await load();
		expect(() => startServiceWorker(true)()).not.toThrow();
		expect(pwaUpdate.registration).toBe('unavailable');
		expect(doc.listeners + win.listeners).toBe(0);
		expect(await checkForUpdate()).toBe('failed');
	});

	it('a failed registration attaches no automatic checks', async () => {
		const container = Object.assign(new Target(), {
			register: vi.fn(() => Promise.reject(new Error('blocked')))
		});
		vi.stubGlobal('navigator', { serviceWorker: container });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { pwaUpdate, startServiceWorker } = await load();
		const stop = startServiceWorker(true);
		await vi.waitFor(() => expect(pwaUpdate.registration).toBe('unavailable'));
		expect(doc.listeners + win.listeners).toBe(0);
		stop();
		warn.mockRestore();
	});
});

describe('automatic checks and the button share one check (FN-42b AC9, AC12)', () => {
	async function started() {
		const reg = fakeRegistration();
		const container = Object.assign(new Target(), { register: vi.fn(async () => reg) });
		vi.stubGlobal('navigator', { serviceWorker: container });
		const mod = await load();
		const stop = mod.startServiceWorker(true);
		await vi.waitFor(() => expect(mod.pwaUpdate.registration).toBe('ready'));
		return { ...mod, reg, container, stop };
	}

	it('a visible event after the gap checks once; the button during it gets the same check', async () => {
		const { reg, checkForUpdate, stop } = await started();
		doc.dispatchEvent(new Event('visibilitychange'));
		expect(reg.update).not.toHaveBeenCalled(); // registration counts as a check: inside the gap
		vi.advanceTimersByTime(MIN_GAP_MS);
		doc.dispatchEvent(new Event('visibilitychange'));
		expect(reg.update).toHaveBeenCalledTimes(1);
		const manual = checkForUpdate();
		win.dispatchEvent(new Event('online'));
		expect(reg.update).toHaveBeenCalledTimes(1);
		reg.finish(true);
		expect(await manual).toBe('latest');
		// The check counted: another trigger right after is inside the gap.
		doc.dispatchEvent(new Event('visibilitychange'));
		expect(reg.update).toHaveBeenCalledTimes(1);
		stop();
	});

	it('a failed check does not count: the next online event retries at once', async () => {
		const { reg, stop } = await started();
		vi.advanceTimersByTime(MIN_GAP_MS);
		win.dispatchEvent(new Event('online'));
		expect(reg.update).toHaveBeenCalledTimes(1);
		reg.finish(false);
		await vi.advanceTimersByTimeAsync(0); // let the failed check settle
		win.dispatchEvent(new Event('online'));
		expect(reg.update).toHaveBeenCalledTimes(2);
		stop();
	});

	it('a hidden page past 45 minutes makes no check (AC14); cleanup removes everything', async () => {
		const { reg, container, stop } = await started();
		doc.visibilityState = 'hidden';
		doc.dispatchEvent(new Event('visibilitychange'));
		vi.advanceTimersByTime(46 * 60_000);
		expect(reg.update).not.toHaveBeenCalled();
		stop();
		expect(doc.listeners + win.listeners + container.listeners + reg.listeners).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
