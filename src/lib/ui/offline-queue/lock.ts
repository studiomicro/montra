/**
 * FN-02 cross-tab coordination, best effort: only the tab holding the Web Lock `financer-queue-drain` drains,
 * so two open tabs do not both send the same item. Web Locks (`navigator.locks`) is Baseline since 2022
 * (Chrome/Edge 69, Firefox 96, Safari 15.4, per MDN; not re-checked online in this pass). Without it the
 * fallback only stops a second drain within this tab; two tabs may then both send an item, and the server's
 * idempotency (the item's `clientId` as the row id, the voice dedupe key) still writes it once. The lock is an
 * efficiency measure, never the safety net.
 */
export const DRAIN_LOCK = 'financer-queue-drain';

type Locks = Pick<LockManager, 'request'>;

export function drainLock(locks: Locks | undefined): (fn: () => Promise<void>) => Promise<boolean> {
	if (locks) {
		return (fn) =>
			locks.request(DRAIN_LOCK, { ifAvailable: true }, async (lock) => {
				if (!lock) return false;
				await fn();
				return true;
			});
	}
	let held = false;
	return async (fn) => {
		if (held) return false;
		held = true;
		try {
			await fn();
			return true;
		} finally {
			held = false;
		}
	};
}
