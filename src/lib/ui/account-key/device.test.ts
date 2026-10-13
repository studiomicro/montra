import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCRYPT_PARAMS } from '#lib/shared/account-key';

vi.mock('$app/env', () => ({ browser: true }));
vi.mock('$app/forms', () => ({ deserialize: vi.fn() }));

const {
	announceSignOut,
	deriveWrapKeyOffThread,
	deviceKey,
	dropDeviceKey,
	holdDeviceKey,
	KeyDerivationTimeout,
	watchSessionEnd
} = await import('./device');

const fakeKey = { privateKey: {} as CryptoKey, publicKey: 'pk' };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A document stand-in: visibilityState plus real event dispatch. */
function fakeDocument(state: DocumentVisibilityState = 'visible') {
	const target = new EventTarget();
	return Object.assign(target, { visibilityState: state }) as unknown as Document & EventTarget;
}

afterEach(() => {
	dropDeviceKey();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('deriveWrapKeyOffThread timeout (QA note)', () => {
	it('rejects with KeyDerivationTimeout and terminates a worker that never answers', async () => {
		vi.useFakeTimers();
		const terminate = vi.fn();
		class SilentWorker extends EventTarget {
			postMessage() {}
			terminate = terminate;
		}
		vi.stubGlobal('Worker', SilentWorker);
		const result = deriveWrapKeyOffThread('pw', new Uint8Array(16), SCRYPT_PARAMS, 30_000);
		const settled = expect(result).rejects.toBeInstanceOf(KeyDerivationTimeout);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(terminate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await settled;
		expect(terminate).toHaveBeenCalledTimes(1);
	});

	it('resolves with the worker answer before the timeout and clears it', async () => {
		vi.useFakeTimers();
		const key = { type: 'secret' } as CryptoKey;
		class AnsweringWorker extends EventTarget {
			postMessage() {
				queueMicrotask(() =>
					this.dispatchEvent(new MessageEvent('message', { data: { ok: true, key } }))
				);
			}
			terminate = vi.fn();
		}
		vi.stubGlobal('Worker', AnsweringWorker);
		await expect(deriveWrapKeyOffThread('pw', new Uint8Array(16), SCRYPT_PARAMS)).resolves.toBe(
			key
		);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('the opened key goes when the session ends elsewhere (red team L2)', () => {
	it('another tab signing out (broadcast) drops it', async () => {
		const stop = watchSessionEnd(fakeDocument(), async () => true);
		holdDeviceKey(fakeKey);
		const otherTab = new BroadcastChannel('financer-session');
		otherTab.postMessage('signed-out');
		otherTab.close();
		await tick();
		expect(deviceKey()).toBeNull();
		stop();
	});

	it('announceSignOut drops it here and tells the other tabs', async () => {
		const heard: unknown[] = [];
		const otherTab = new BroadcastChannel('financer-session');
		otherTab.onmessage = (e) => heard.push(e.data);
		holdDeviceKey(fakeKey);
		announceSignOut();
		expect(deviceKey()).toBeNull();
		await tick();
		expect(heard).toEqual(['signed-out']);
		otherTab.close();
	});

	it('coming back into view with the session gone drops it; a live session or a network error keeps it', async () => {
		const doc = fakeDocument();
		let answer: () => Promise<boolean> = async () => true;
		const stop = watchSessionEnd(doc, () => answer());
		holdDeviceKey(fakeKey);
		doc.dispatchEvent(new Event('visibilitychange'));
		await tick();
		expect(deviceKey()).toBe(fakeKey);
		answer = async () => {
			throw new TypeError('offline');
		};
		doc.dispatchEvent(new Event('visibilitychange'));
		await tick();
		expect(deviceKey()).toBe(fakeKey);
		answer = async () => false;
		doc.dispatchEvent(new Event('visibilitychange'));
		await tick();
		expect(deviceKey()).toBeNull();
		stop();
	});

	it('does not ask the server while hidden or when no key is held', async () => {
		const check = vi.fn(async () => false);
		const hidden = fakeDocument('hidden');
		const stop = watchSessionEnd(hidden, check);
		holdDeviceKey(fakeKey);
		hidden.dispatchEvent(new Event('visibilitychange'));
		dropDeviceKey();
		const visible = fakeDocument();
		const stop2 = watchSessionEnd(visible, check);
		visible.dispatchEvent(new Event('visibilitychange'));
		await tick();
		expect(check).not.toHaveBeenCalled();
		stop();
		stop2();
	});
});
