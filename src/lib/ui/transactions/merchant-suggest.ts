import { isMerchantReason, type MerchantReason } from '#lib/shared/merchants/resolve';
import type { CategoryKind } from '#lib/shared/transactions';

/**
 * FN-20's suggestion chip on the manual form: as a title is typed, at most one request per SUGGEST_DEBOUNCE_MS
 * pause, only from SUGGEST_MIN_CHARS characters, and never two at once (a newer title waits for the running
 * request, then only the latest is sent). A stale answer (the title changed meanwhile) is dropped. Without
 * JavaScript none of this runs and the form posts as before.
 */

export const SUGGEST_DEBOUNCE_MS = 400;
export const SUGGEST_MIN_CHARS = 3;
/** The app route that answers (deterministic only, session-scoped). */
export const SUGGEST_URL = '/riwayat/saran';

export interface MerchantSuggestion {
	merchant: string;
	categoryId: string | null;
	reason: MerchantReason;
}

interface Query {
	title: string;
	type: CategoryKind;
}

const isSuggestion = (v: unknown): v is MerchantSuggestion => {
	if (typeof v !== 'object' || v === null) return false;
	const { merchant, categoryId, reason } = v as Record<string, unknown>;
	return (
		typeof merchant === 'string' &&
		(categoryId === null || typeof categoryId === 'string') &&
		isMerchantReason(reason)
	);
};

/** One request for `queries`; null on any failure (the chip just does not appear). */
export async function fetchSuggestions(
	queries: readonly Query[],
	fetchFn: typeof fetch = fetch
): Promise<MerchantSuggestion[] | null> {
	const body = new URLSearchParams();
	for (const q of queries) {
		body.append('title', q.title);
		body.append('type', q.type);
	}
	try {
		const response = await fetchFn(SUGGEST_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body
		});
		if (!response.ok) return null;
		const parsed = (await response.json()) as { items?: unknown };
		if (!Array.isArray(parsed.items) || !parsed.items.every(isSuggestion)) return null;
		return parsed.items;
	} catch {
		return null;
	}
}

export interface SuggesterOptions {
	request: (q: Query) => Promise<MerchantSuggestion | null>;
	onResult: (s: MerchantSuggestion | null) => void;
	delayMs?: number;
}

/** The debounced, one-at-a-time scheduler behind the chip. */
export function createSuggester(opts: SuggesterOptions) {
	const delay = opts.delayMs ?? SUGGEST_DEBOUNCE_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let latest: Query | null = null;
	let inFlight = false;
	let waiting = false;

	async function send(q: Query) {
		inFlight = true;
		const result = await opts.request(q).catch(() => null);
		inFlight = false;
		const current = latest;
		if (current && current.title === q.title && current.type === q.type) opts.onResult(result);
		if (waiting && current) {
			waiting = false;
			if (current.title !== q.title || current.type !== q.type) void send(current);
		}
	}

	return {
		input(title: string, type: CategoryKind) {
			clearTimeout(timer);
			const trimmed = title.trim();
			latest = { title: trimmed, type };
			if (Array.from(trimmed).length < SUGGEST_MIN_CHARS) {
				opts.onResult(null);
				return;
			}
			timer = setTimeout(() => {
				if (inFlight) waiting = true;
				else if (latest) void send(latest);
			}, delay);
		},
		dispose() {
			clearTimeout(timer);
			latest = null;
		}
	};
}
