/**
 * Gmail's documented retry wait (Gmail API › Usage limits, "exponential backoff"): `min(2^n + random, max)`, the
 * random part below one second, the maximum 64 s. `attempt` counts from 0 (the first retry waits 1–2 s);
 * `random` is in [0, 1). Whole seconds rounded up, as Queues `retry({ delaySeconds })` takes them.
 */
export const GMAIL_BACKOFF_MAX_S = 64;

export function gmailBackoffSeconds(attempt: number, random: number): number {
	const n = Number.isFinite(attempt) ? Math.max(0, Math.min(Math.floor(attempt), 16)) : 0;
	const jitter = Number.isFinite(random) ? Math.min(Math.max(random, 0), 0.999) : 0;
	return Math.ceil(Math.min(2 ** n + jitter, GMAIL_BACKOFF_MAX_S));
}
