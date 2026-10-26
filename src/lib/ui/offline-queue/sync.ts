import {
	isStaleItem,
	pushBody,
	QUEUE_FAILED_GENERIC,
	queueTarget,
	type QueueItem
} from '#lib/shared/offline-queue';
import type { OfflineQueue } from './store.svelte';

/**
 * FN-02 drain loop: sends this account's queued items to `/api/v1/sync/push`, one request per item. Success is
 * only ever the server's `ok`; an item leaves the queue then and not before.
 *
 * - Items with the same target (queueTarget) go strictly in the order they were made; up to DRAIN_CONCURRENCY
 *   different targets at once.
 * - A network failure (fetch rejects, a non-JSON answer such as a captive portal, 0/408/429/502/503/504) keeps the
 *   item pending and retries it after an exponential, fully jittered backoff (BACKOFF_STEPS_MS).
 * - 401: the session ended (or the item was queued for another account than the session's). Nothing more is
 *   sent until the page is loaded signed in again; items stay queued, never sent under another account.
 * - 429: the per-user limit; retried no sooner than the answer's Retry-After.
 * - Any other answer (400, 403, 404, 409, 413, 415, 500): failed with the server's reason, never retried on its
 *   own (the user retries or discards it).
 * - Items not kept for QUEUE_STALE_MS wait for the user (stale), never retried forever.
 */
export const PUSH_URL = '/api/v1/sync/push';
const DRAIN_CONCURRENCY = 4;
const BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
const TRANSIENT = new Set([0, 408, 429, 502, 503, 504]);
const MESSAGE_MAX = 300;

/** Upper bound of the wait before attempt `attempts + 1` (attempts ≥ 1 failures so far). */
export function backoffCeiling(attempts: number): number {
	const step = Math.min(Math.max(attempts, 1), BACKOFF_STEPS_MS.length) - 1;
	return BACKOFF_STEPS_MS[step] as number;
}

/** Full jitter: a uniform wait in [0, ceiling]. */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
	return Math.floor(random() * backoffCeiling(attempts));
}

export type Outcome =
	{ kind: 'ok' } | { kind: 'retry' } | { kind: 'session' } | { kind: 'failed'; reason: string };

/** One answer of the push endpoint (`status` null when fetch itself failed). */
export function classify(status: number | null, body: unknown): Outcome {
	if (status === null || TRANSIENT.has(status)) return { kind: 'retry' };
	if (status === 401) return { kind: 'session' };
	const parsed = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
	if (status === 200) return parsed?.result === 'ok' ? { kind: 'ok' } : { kind: 'retry' };
	const message = parsed?.message;
	return {
		kind: 'failed',
		reason:
			typeof message === 'string' && message.length > 0 && message.length <= MESSAGE_MAX
				? message
				: QUEUE_FAILED_GENERIC
	};
}

export interface DrainDeps {
	queue: OfflineQueue;
	fetch: typeof fetch;
	/** Runs `fn` only if no other tab is draining (lock.ts); false when skipped. */
	lock: (fn: () => Promise<void>) => Promise<boolean>;
	now?: () => number;
	random?: () => number;
	/** Schedules the next automatic retry; returns its cancel. */
	schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number) => {
	const t = setTimeout(fn, ms);
	return () => clearTimeout(t);
};

export class Drainer {
	private running = false;
	private again = false;
	private stopped = false;
	private cancelTimer: (() => void) | null = null;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly schedule: (fn: () => void, ms: number) => () => void;

	constructor(private readonly deps: DrainDeps) {
		this.now = deps.now ?? Date.now;
		this.random = deps.random ?? Math.random;
		this.schedule = deps.schedule ?? defaultSchedule;
	}

	/**
	 * Sends what is due. `force` (the `online` event, a manual retry) ignores the backoff wait. A call while a
	 * drain runs makes that drain go round once more instead of starting a second one.
	 */
	async drain(force = false): Promise<void> {
		if (this.stopped || this.deps.queue.sessionEnded) return;
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		try {
			await this.deps.lock(async () => {
				let first = true;
				do {
					this.again = false;
					await this.round(force && first);
					first = false;
				} while (this.again && !this.stopped && !this.deps.queue.sessionEnded);
			});
		} finally {
			this.running = false;
		}
	}

	stop(): void {
		this.stopped = true;
		this.cancelTimer?.();
		this.cancelTimer = null;
	}

	private async round(force: boolean): Promise<void> {
		const { queue } = this.deps;
		const items = await queue.list();
		const now = this.now();
		const groups = new Map<string, QueueItem[]>();
		for (const item of items) {
			if (item.status === 'failed') continue;
			const key = queueTarget(item);
			const group = groups.get(key);
			if (group) group.push(item);
			else groups.set(key, [item]);
		}
		const work = [...groups.values()];
		const runGroup = async (group: QueueItem[]) => {
			for (const item of group) {
				// Order within a target: a waiting or stale head holds back the items after it.
				if (this.stopped || queue.sessionEnded) return;
				if (isStaleItem(item, now)) return;
				if (!force && item.nextAttemptAt > now) return;
				const outcome = await this.send(item);
				if (outcome === 'retry' || outcome === 'session') return;
			}
		};
		const workers = Array.from({ length: Math.min(DRAIN_CONCURRENCY, work.length) }, async () => {
			for (let group = work.shift(); group; group = work.shift()) await runGroup(group);
		});
		await Promise.all(workers);
		await this.scheduleNext();
	}

	private async send(item: QueueItem): Promise<Outcome['kind']> {
		const { queue } = this.deps;
		await queue.markSending(item.clientId);
		let status: number | null = null;
		let body: unknown = null;
		let retryAfterMs = 0;
		try {
			const response = await this.deps.fetch(PUSH_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(pushBody(item)),
				credentials: 'same-origin',
				cache: 'no-store'
			});
			status = response.status;
			// 429 (per-user limit): the server says how long to wait; never sooner than that.
			const after = Number(response.headers.get('retry-after'));
			if (Number.isFinite(after) && after > 0) retryAfterMs = Math.min(after, 3600) * 1000;
			body = await response.json().catch(() => null);
		} catch {
			// fetch itself failed (offline, DNS, reset): `status` stays null, a network error.
		}
		const outcome = classify(status, body);
		if (outcome.kind === 'ok') await queue.confirm(item.clientId);
		else if (outcome.kind === 'failed') await queue.markFailed(item.clientId, outcome.reason);
		else if (outcome.kind === 'session') {
			queue.sessionEnded = true;
			await queue.markPending(item.clientId, 0);
		} else {
			const attempts = item.attempts + 1;
			const wait = Math.max(backoffDelay(attempts, this.random), retryAfterMs);
			await queue.markPending(item.clientId, this.now() + wait);
		}
		return outcome.kind;
	}

	/** One timer for the earliest backoff still waiting. */
	private async scheduleNext(): Promise<void> {
		this.cancelTimer?.();
		this.cancelTimer = null;
		if (this.stopped || this.deps.queue.sessionEnded) return;
		const now = this.now();
		const waits = (await this.deps.queue.list())
			.filter((i) => i.status !== 'failed' && !isStaleItem(i, now) && i.nextAttemptAt > now)
			.map((i) => i.nextAttemptAt - now);
		if (waits.length === 0) return;
		this.cancelTimer = this.schedule(() => void this.drain(), Math.min(...waits));
	}
}

/**
 * Red team L1: another tab of this browser signed out (`announceSignOut` broadcasts `signed-out` on the session
 * channel). This tab's queue pauses at once, as on a 401: nothing more is sent with whatever cookie the browser
 * holds next. Returns the cleanup.
 */
export function pauseOnSignOut(
	channel: Pick<BroadcastChannel, 'addEventListener' | 'removeEventListener' | 'close'>,
	queue: OfflineQueue
): () => void {
	const onMessage = (e: MessageEvent) => {
		if (e.data === 'signed-out') queue.sessionEnded = true;
	};
	channel.addEventListener('message', onMessage);
	return () => {
		channel.removeEventListener('message', onMessage);
		channel.close();
	};
}
