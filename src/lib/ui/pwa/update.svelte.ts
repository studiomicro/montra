import {
	advancesLastCheck,
	offerUpdate,
	SKIP_WAITING,
	updateCheckOutcome,
	type UpdateCheck
} from '#lib/shared/sw-update';
import { startAutoUpdateChecks } from './auto-check';

/**
 * The service worker's registration and the "new version" banner state (FN-13, FN-42). Browser only: the root
 * layout calls `startServiceWorker()` on mount (bundled code, never an inline script, so the CSP needs no change;
 * never under `vite dev`). An update waits until the person taps "Muat ulang sekarang" (`applyUpdate`): the
 * waiting worker is told to take over and the page reloads once it controls the page. Unsent offline-queue
 * items (FN-02) live in IndexedDB and leave it only after the server confirmed them, so the reload loses none.
 * FN-42b: while the page is open it also checks for a newer build on its own (`auto-check.ts`), silently.
 */
export const pwaUpdate = $state<{
	/** `ready` once the worker is registered; `unavailable` without support, under `vite dev`, or on failure. */
	registration: 'pending' | 'ready' | 'unavailable';
	/** A newer build finished installing and waits: show "Versi baru tersedia". */
	available: boolean;
	/** Hidden by the person for this page load only; the banner is back on the next load. */
	dismissed: boolean;
	/** "Muat ulang sekarang" was tapped: waiting for the new worker to take control. */
	applying: boolean;
}>({ registration: 'pending', available: false, dismissed: false, applying: false });

let registration: ServiceWorkerRegistration | null = null;
let reloading = false;
/** The running check, shared by the button and the automatic triggers: never two `update()` calls at once. */
let inFlight: Promise<UpdateCheck> | null = null;
/** When the last check that reached the server ended (or the worker registered: the browser checks then). */
let lastCheckAt: number | null = null;

function watch(reg: ServiceWorkerRegistration, worker: ServiceWorker): void {
	const decide = () => {
		if (
			offerUpdate({
				state: worker.state,
				isWaiting: reg.waiting === worker,
				activeWorkerExists: reg.active !== null && reg.active !== worker
			})
		)
			pwaUpdate.available = true;
	};
	decide();
	worker.addEventListener('statechange', decide);
}

/** Registers the worker (when `enabled`: never under `vite dev`) and watches for updates; returns the cleanup. */
export function startServiceWorker(enabled: boolean): () => void {
	if (!enabled || !('serviceWorker' in navigator)) {
		pwaUpdate.registration = 'unavailable';
		return () => {};
	}
	const container = navigator.serviceWorker;
	let stopped = false;
	let reg: ServiceWorkerRegistration | null = null;
	let stopChecks = () => {};
	const onUpdateFound = () => {
		if (reg?.installing) watch(reg, reg.installing);
	};
	// Reload only for the takeover this page asked for: a first install's `clients.claim()` changes the
	// controller too, and must not reload anything.
	const onControllerChange = () => {
		if (!pwaUpdate.applying || reloading) return;
		reloading = true;
		location.reload();
	};
	container.addEventListener('controllerchange', onControllerChange);
	container
		.register('/service-worker.js', { type: 'module' })
		.then((r) => {
			if (stopped) return;
			reg = r;
			registration = r;
			pwaUpdate.registration = 'ready';
			// An update that finished installing before this page loaded is still waiting: offer it again.
			if (r.waiting) watch(r, r.waiting);
			if (r.installing) watch(r, r.installing);
			r.addEventListener('updatefound', onUpdateFound);
			lastCheckAt = Date.now();
			stopChecks = startAutoUpdateChecks({
				doc: document,
				win: window,
				now: () => Date.now(),
				state: () => ({
					lastCheckAt,
					inFlight: inFlight !== null,
					registrationReady: pwaUpdate.registration === 'ready',
					updateWaiting: r.waiting !== null || r.installing !== null
				}),
				check: () => void checkForUpdate()
			});
		})
		.catch((e) => {
			if (!stopped) pwaUpdate.registration = 'unavailable';
			console.warn('service worker registration failed', e);
		});
	return () => {
		stopped = true;
		stopChecks();
		container.removeEventListener('controllerchange', onControllerChange);
		reg?.removeEventListener('updatefound', onUpdateFound);
	};
}

/** "Muat ulang sekarang": lets the waiting worker take over; the page reloads once it controls the page. */
export function applyUpdate(): void {
	const waiting = registration?.waiting;
	if (!waiting) {
		// Nothing waits any more (another tab applied it meanwhile): a plain reload shows the current build.
		location.reload();
		return;
	}
	pwaUpdate.applying = true;
	waiting.postMessage({ type: SKIP_WAITING });
}

/**
 * "Periksa pembaruan" and the automatic checks: asks the browser to compare the worker script now. Never reloads
 * by itself. A call while a check runs gets that same check (one `update()`); the button ignores the minimum gap
 * but its check counts towards it.
 */
export function checkForUpdate(): Promise<UpdateCheck> {
	if (inFlight) return inFlight;
	const reg = registration;
	if (!reg) return Promise.resolve('failed');
	const run = async (): Promise<UpdateCheck> => {
		try {
			await reg.update();
		} catch {
			return 'failed';
		}
		return updateCheckOutcome({
			installing: reg.installing !== null,
			waiting: reg.waiting !== null
		});
	};
	const check = run().then((outcome) => {
		if (advancesLastCheck(outcome)) lastCheckAt = Date.now();
		inFlight = null;
		return outcome;
	});
	inFlight = check;
	return check;
}
