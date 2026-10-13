import { CHECK_INTERVAL_MS, shouldCheckForUpdate, type CheckTrigger } from '#lib/shared/sw-update';

/**
 * FN-42b: quiet update checks while the app is open — when the page becomes visible, when the device comes back
 * online, and every CHECK_INTERVAL_MS while the page stays visible (the timer is cleared while hidden). Each
 * trigger goes through `shouldCheckForUpdate`, then `check` (the same `checkForUpdate` the Tentang button uses).
 * The result is silent: a newer build surfaces only through the "Versi baru tersedia" banner. Nothing here
 * reloads. Returns the cleanup, which removes every listener and the timer.
 */
export function startAutoUpdateChecks(deps: {
	doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
	win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
	now: () => number;
	/** The registration's current state, read at each trigger. */
	state: () => {
		lastCheckAt: number | null;
		inFlight: boolean;
		registrationReady: boolean;
		updateWaiting: boolean;
	};
	check: () => void;
}): () => void {
	const { doc, win } = deps;
	let timer: ReturnType<typeof setInterval> | null = null;

	const run = (trigger: CheckTrigger) => {
		const visible = doc.visibilityState === 'visible';
		if (shouldCheckForUpdate({ trigger, now: deps.now(), visible, enabled: true, ...deps.state() }))
			deps.check();
	};
	const startTimer = () => {
		timer ??= setInterval(() => run('interval'), CHECK_INTERVAL_MS);
	};
	const stopTimer = () => {
		if (timer !== null) clearInterval(timer);
		timer = null;
	};
	const onVisibility = () => {
		if (doc.visibilityState === 'visible') {
			startTimer();
			run('visible');
		} else stopTimer();
	};
	const onOnline = () => run('online');

	doc.addEventListener('visibilitychange', onVisibility);
	win.addEventListener('online', onOnline);
	if (doc.visibilityState === 'visible') startTimer();
	return () => {
		doc.removeEventListener('visibilitychange', onVisibility);
		win.removeEventListener('online', onOnline);
		stopTimer();
	};
}
