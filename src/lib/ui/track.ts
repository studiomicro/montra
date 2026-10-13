import type { StatAction, StatScreen } from '#lib/shared/privacy';

/**
 * Sends one usage-statistics event (FN-31) to /api/v1/track: a screen and an action from the fixed
 * vocabulary, nothing else. Fire-and-forget — the server decides whether anything is counted (signed in,
 * statistics on); a failed or skipped call is never shown and never blocks navigation.
 */
export function track(screen: StatScreen, action: StatAction): void {
	try {
		const body = new URLSearchParams({ screen, action });
		if (navigator.sendBeacon?.('/api/v1/track', body)) return;
		fetch('/api/v1/track', { method: 'POST', body, keepalive: true }).catch(() => {});
	} catch {
		// Statistics are never worth an error.
	}
}
