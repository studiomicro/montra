import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createSuggester,
	fetchSuggestions,
	SUGGEST_DEBOUNCE_MS,
	type MerchantSuggestion
} from './merchant-suggest';

const answer = (merchant: string): MerchantSuggestion => ({
	merchant,
	categoryId: 'c1',
	reason: 'history'
});

describe('createSuggester (FN-20 AC-15)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('one request per debounce pause, none under 3 characters', async () => {
		const request = vi.fn(async (q: { title: string }) => answer(q.title));
		const results: (MerchantSuggestion | null)[] = [];
		const s = createSuggester({ request, onResult: (r) => results.push(r) });
		s.input('ko', 'expense');
		s.input('kop', 'expense');
		s.input('kopi', 'expense');
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS - 1);
		expect(request).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith({ title: 'kopi', type: 'expense' });
		expect(results.at(-1)).toEqual(answer('kopi'));
		s.input('ko', 'expense');
		expect(results.at(-1)).toBeNull();
	});

	it('never two at once; only the latest waiting title is sent after; a stale answer is dropped', async () => {
		let release: (v: MerchantSuggestion) => void = () => {};
		const request = vi.fn(
			(q: { title: string }) =>
				new Promise<MerchantSuggestion>((resolve) => {
					release = (v) => resolve(v);
					void q;
				})
		);
		const results: (MerchantSuggestion | null)[] = [];
		const s = createSuggester({ request, onResult: (r) => results.push(r) });
		s.input('kopi', 'expense');
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		s.input('kopi s', 'expense');
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		s.input('kopi senja', 'expense');
		await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
		expect(request).toHaveBeenCalledTimes(1);
		release(answer('kopi'));
		await vi.advanceTimersByTimeAsync(0);
		// The answer for "kopi" is stale (the title is now "kopi senja"): not shown.
		expect(results).toEqual([]);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request).toHaveBeenLastCalledWith({ title: 'kopi senja', type: 'expense' });
		release(answer('kopi senja'));
		await vi.advanceTimersByTimeAsync(0);
		expect(results).toEqual([answer('kopi senja')]);
	});
});

describe('fetchSuggestions', () => {
	it('posts a form and validates the answer', async () => {
		const fetchFn = vi.fn(
			async () => new Response(JSON.stringify({ items: [answer('Kopi')] }), { status: 200 })
		);
		expect(await fetchSuggestions([{ title: 'kopi', type: 'expense' }], fetchFn)).toEqual([
			answer('Kopi')
		]);
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/riwayat/saran');
		expect(String(init.body)).toBe('title=kopi&type=expense');
	});
	it('a refusal, a network error or a malformed answer give null', async () => {
		expect(
			await fetchSuggestions(
				[{ title: 'kopi', type: 'expense' }],
				async () => new Response('', { status: 400 })
			)
		).toBeNull();
		expect(
			await fetchSuggestions([{ title: 'kopi', type: 'expense' }], async () => {
				throw new TypeError('offline');
			})
		).toBeNull();
		expect(
			await fetchSuggestions(
				[{ title: 'kopi', type: 'expense' }],
				async () => new Response(JSON.stringify({ items: [{ merchant: 1, reason: 'x' }] }))
			)
		).toBeNull();
	});
});
