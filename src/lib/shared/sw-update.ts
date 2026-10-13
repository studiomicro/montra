/**
 * When a new service-worker build takes over (FN-42). Pure, so the decisions are unit-tested like sw-policy.ts.
 *
 * A first install (no active worker yet: nothing open to disrupt) activates at once, as FN-13 shipped. An update
 * (an older worker is active) waits in the standard `waiting` state until the person taps "Muat ulang sekarang",
 * which posts SKIP_WAITING; the page reloads once the new worker controls it. The worker and the page decide
 * with the same predicate — "is another worker already active" — so they never disagree.
 */

/** The message a page posts to the waiting worker to let it take over. */
export const SKIP_WAITING = 'SKIP_WAITING';

/** Worker side, on `install`: skip waiting only when no older worker is active (a first install). */
export function skipWaitingOnInstall(activeWorkerExists: boolean): boolean {
	return !activeWorkerExists;
}

/** Worker side, on `message`: true only for `{ type: 'SKIP_WAITING' }`. */
export function isSkipWaitingMessage(data: unknown): boolean {
	return (
		typeof data === 'object' && data !== null && (data as { type?: unknown }).type === SKIP_WAITING
	);
}

/**
 * Page side: offer "Versi baru tersedia" for a worker that finished installing (`installed`) and sits in this
 * registration's `waiting` slot while another worker is active. Never for a first install (no active worker:
 * it activates on its own), never while it is still installing.
 */
export function offerUpdate(input: {
	state: string;
	isWaiting: boolean;
	activeWorkerExists: boolean;
}): boolean {
	return input.state === 'installed' && input.isWaiting && input.activeWorkerExists;
}

export type UpdateCheck =
	/** A newer build was found and is downloading or waiting: the banner follows through `updatefound`. */
	| 'found'
	/** The browser compared the worker script and nothing changed: "Sudah versi terbaru". */
	| 'latest'
	/** The check itself failed (offline, server unreachable). */
	| 'failed';

/** The outcome of a manual `registration.update()` that resolved, from what the registration holds after it. */
export function updateCheckOutcome(after: { installing: boolean; waiting: boolean }): UpdateCheck {
	return after.installing || after.waiting ? 'found' : 'latest';
}

/*
 * FN-42b automatic checks while the app is open: on becoming visible, on `online`, and every CHECK_INTERVAL_MS
 * while visible (owner decision D2). A check only asks the browser to compare the worker script; a newer build
 * still waits for "Muat ulang sekarang" — nothing here ever reloads or skips waiting.
 */

/** At most one automatic `registration.update()` per 10 minutes. */
export const MIN_GAP_MS = 10 * 60_000;
/** While the page stays visible, check every 45 minutes. */
export const CHECK_INTERVAL_MS = 45 * 60_000;

export type CheckTrigger = 'visible' | 'online' | 'interval';

/** Whether an automatic trigger may start a check now. Every trigger follows the same rules. */
export function shouldCheckForUpdate(input: {
	trigger: CheckTrigger;
	now: number;
	lastCheckAt: number | null;
	/** A check (automatic or the "Periksa pembaruan" button) is already running. */
	inFlight: boolean;
	visible: boolean;
	registrationReady: boolean;
	/** A newer build is waiting or installing: nothing more to find, the banner is the next step. */
	updateWaiting: boolean;
	/** False under `vite dev` and without service-worker support. */
	enabled: boolean;
}): boolean {
	if (!input.enabled || !input.registrationReady || input.inFlight || input.updateWaiting)
		return false;
	if (!input.visible) return false;
	return input.lastCheckAt === null || input.now - input.lastCheckAt >= MIN_GAP_MS;
}

/** A failed check (offline) does not count, so the next `online` event retries it at once. */
export function advancesLastCheck(outcome: UpdateCheck): boolean {
	return outcome !== 'failed';
}
