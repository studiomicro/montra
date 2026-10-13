import { browser } from '$app/env';
import type { NewQueueItem } from './store.svelte';
import { QueueDb } from './db';
import { drainLock } from './lock';
import { OfflineQueue, QUEUE_CHANNEL } from './store.svelte';
import { SESSION_CHANNEL } from '#lib/ui/account-key/device';
import { Drainer, pauseOnSignOut } from './sync';

/**
 * FN-02: the one queue of this page (browser only), started by the (app) layout for the signed-in account and
 * stopped when it unmounts (sign-out, sign-in again: a fresh start re-reads IndexedDB and clears a paused
 * session). Drains on `online`, when the tab becomes visible, when another tab changed the queue, and right
 * after an enqueue while online.
 */
export const offlineState = $state<{
	queue: OfflineQueue | null;
	online: boolean;
	/** Items of another account found on this device at start and discarded (account switch). */
	discarded: number;
}>({ queue: null, online: true, discarded: 0 });

let drainer: Drainer | null = null;
let stopListening: (() => void) | null = null;
let starting: Promise<void> | null = null;
let startedFor: string | null = null;
/** Bumped by every stop: a start still opening IndexedDB when it is stopped gives up. */
let generation = 0;

export function startOfflineQueue(accountId: string): Promise<void> {
	if (!browser || typeof indexedDB === 'undefined') return Promise.resolve();
	if (startedFor === accountId && starting) return starting;
	stopOfflineQueue();
	const gen = generation;
	startedFor = accountId;
	starting = (async () => {
		let db: QueueDb;
		try {
			db = await QueueDb.open(indexedDB);
		} catch {
			// IndexedDB refused (a private window on some browsers): no queue, writes stay online-only.
			return;
		}
		const channel =
			typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(QUEUE_CHANNEL);
		const queue = new OfflineQueue(db, accountId, Date.now, channel);
		const discarded = await queue.discardOtherAccounts();
		await queue.refresh();
		if (gen !== generation) {
			queue.close();
			db.close();
			return;
		}
		offlineState.discarded = discarded;
		const d = new Drainer({
			queue,
			fetch: (input, init) => fetch(input, init),
			lock: drainLock(typeof navigator.locks === 'undefined' ? undefined : navigator.locks)
		});
		const onOnline = () => {
			offlineState.online = true;
			void d.drain(true);
		};
		const onOffline = () => (offlineState.online = false);
		const onVisible = () => {
			if (document.visibilityState === 'visible') void d.drain();
		};
		const onOtherTab = () => void d.drain();
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);
		document.addEventListener('visibilitychange', onVisible);
		channel?.addEventListener('message', onOtherTab);
		const stopSignOutWatch =
			typeof BroadcastChannel === 'undefined'
				? () => {}
				: pauseOnSignOut(new BroadcastChannel(SESSION_CHANNEL), queue);
		stopListening = () => {
			window.removeEventListener('online', onOnline);
			window.removeEventListener('offline', onOffline);
			document.removeEventListener('visibilitychange', onVisible);
			stopSignOutWatch();
			d.stop();
			queue.close();
			db.close();
		};
		offlineState.online = navigator.onLine;
		offlineState.queue = queue;
		drainer = d;
		void d.drain();
	})();
	return starting;
}

export function stopOfflineQueue(): void {
	generation++;
	startedFor = null;
	stopListening?.();
	stopListening = null;
	drainer = null;
	starting = null;
	offlineState.queue = null;
}

/** True when the browser says it has no network (then a write is queued without trying the server first). */
export function browserOffline(): boolean {
	return browser && navigator.onLine === false;
}

/**
 * Queues one write. `unavailable` when this page has no queue (no IndexedDB, not signed in): the caller then
 * shows its usual "check your connection" error and nothing is pretended to be saved.
 */
export async function enqueueOffline(
	item: NewQueueItem
): Promise<'queued' | 'full' | 'unavailable'> {
	await starting;
	const queue = offlineState.queue;
	if (!queue) return 'unavailable';
	const result = await queue.enqueue(item).catch(() => 'unavailable' as const);
	if (result === 'queued' && navigator.onLine) void drainer?.drain();
	return result;
}

/** Sends again now (the "Kirim lagi" button). */
export async function retryOffline(clientId: string): Promise<void> {
	await offlineState.queue?.retry(clientId);
	void drainer?.drain(true);
}

/** Sign-out (after the user confirmed): this account's queue goes, before Clear-Site-Data removes the rest. */
export async function clearOfflineQueue(): Promise<void> {
	await starting;
	await offlineState.queue?.clear().catch(() => {});
}
