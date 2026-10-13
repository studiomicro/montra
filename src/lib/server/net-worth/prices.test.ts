import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeKv, json, stubFetch } from '../../../../test/helpers/kv';
import {
	fetchGoldSpotUsd,
	fetchIdrRate,
	fetchIndodaxPrices,
	KV_FX,
	KV_GOLD,
	KV_INDODAX,
	KV_TTL_SECONDS,
	PRICE_HOSTS,
	PRICE_MAX_AGE_MS,
	PriceFetchError,
	readPriceBook,
	refreshPrices
} from './prices';

// Every test stubs the providers: no real network call is ever made here.
const TICKER_ALL = 'https://indodax.com/api/ticker_all';
const GOLD = 'https://api.gold-api.com/price/XAU';
const FX_USD = 'https://api.frankfurter.dev/v2/rate/USD/IDR';
const FX_SGD = 'https://api.frankfurter.dev/v2/rate/SGD/IDR';

/** 2026-10-08 10:00 WIB. */
const NOW = Date.UTC(2026, 9, 8, 3, 0);
const TODAY = '2026-10-08';

const tickers = (entries: Record<string, unknown>) => json({ tickers: entries });
const goldBody = (price: unknown = 4105.299805) => ({
	currency: 'USD',
	currencySymbol: '$',
	exchangeRate: 1.0,
	name: 'Gold',
	price,
	symbol: 'XAU',
	updatedAt: '2026-10-08T02:59:00Z'
});
const fxBody = (rate: unknown = 17881, over: Record<string, unknown> = {}) => ({
	date: '2026-10-07',
	base: 'USD',
	quote: 'IDR',
	rate,
	...over
});

const reason = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'resolved';
	} catch (e) {
		return e instanceof PriceFetchError ? e.reason : `other: ${String(e)}`;
	}
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('fetchIndodaxPrices', () => {
	it('reads IDR per coin for every IDR pair from one ticker_all call, never following redirects', async () => {
		const inits: RequestInit[] = [];
		const { fetch, calls } = stubFetch({
			[TICKER_ALL]: () =>
				tickers({
					btc_idr: { last: '1493387000', buy: '1' },
					pepe_idr: { last: '0.073354' },
					btc_usdt: { last: '83000' }
				})
		});
		const prices = await fetchIndodaxPrices((url, init) => {
			inits.push(init);
			return fetch(url, init);
		});
		expect([...prices]).toEqual([
			['btc', '1493387000'],
			['pepe', '0.073354']
		]);
		expect(calls).toEqual([TICKER_ALL]);
		expect(inits[0]).toMatchObject({ method: 'GET', redirect: 'manual' });
		expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	it('leaves out coins that are missing or carry a hostile or absurd price', async () => {
		const { fetch } = stubFetch({
			[TICKER_ALL]: () =>
				tickers({
					btc_idr: { last: '-5' },
					eth_idr: { last: '1e9' },
					sol_idr: { last: 2_000_000 },
					doge_idr: { last: '0' },
					ada_idr: { last: '100000000000000' },
					xrp_idr: { last: '0.0000000000001' },
					usdt_idr: { last: '17890' },
					__proto___idr: { last: '1' },
					'BAD-CODE_idr': { last: '1' }
				})
		});
		const prices = await fetchIndodaxPrices(fetch);
		expect([...prices]).toEqual([['usdt', '17890']]);
	});

	it('refuses a malformed answer, an error status, a redirect, an oversized body and bad JSON', async () => {
		const cases: [() => Response, string][] = [
			[() => json({ error: 'invalid_pair' }), 'schema'],
			[() => json({ tickers: [] }), 'schema'],
			[() => new Response('oops', { status: 503 }), 'status'],
			[
				() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
				'redirect'
			],
			[
				() => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } }),
				'too_large'
			],
			[() => new Response('{"tickers":{"a":"' + 'x'.repeat(600 * 1024) + '"}}'), 'too_large'],
			[() => new Response('<html>not json'), 'json']
		];
		for (const [answer, expected] of cases) {
			const { fetch } = stubFetch({ [TICKER_ALL]: answer });
			expect(await reason(fetchIndodaxPrices(fetch))).toBe(expected);
		}
	});

	it('reports a timeout or network failure as network', async () => {
		const timeout = async () => {
			throw new DOMException('The operation timed out.', 'TimeoutError');
		};
		expect(await reason(fetchIndodaxPrices(timeout))).toBe('network');
	});
});

describe('fetchGoldSpotUsd', () => {
	it('returns USD per troy ounce as decimal text', async () => {
		const { fetch, calls } = stubFetch({ [GOLD]: () => json(goldBody()) });
		expect(await fetchGoldSpotUsd(fetch)).toBe('4105.299805');
		expect(calls).toEqual([GOLD]);
	});

	it('refuses implausible, mistyped or mislabelled answers', async () => {
		for (const [body, expected] of [
			[goldBody(5), 'bounds'],
			[goldBody(1_000_000), 'bounds'],
			[goldBody(-4105), 'bounds'],
			[goldBody('4105.30'), 'schema'],
			[goldBody(null), 'schema'],
			[{ ...goldBody(), symbol: 'XAG' }, 'schema'],
			[{ ...goldBody(), currency: 'EUR' }, 'schema']
		] as const) {
			const { fetch } = stubFetch({ [GOLD]: () => json(body) });
			expect(await reason(fetchGoldSpotUsd(fetch)), JSON.stringify(body)).toBe(expected);
		}
	});
});

describe('fetchIdrRate', () => {
	it('returns the rate with its own date', async () => {
		const { fetch } = stubFetch({ [FX_USD]: () => json(fxBody()) });
		expect(await fetchIdrRate('USD', TODAY, fetch)).toEqual({ rate: '17881', date: '2026-10-07' });
	});

	it('refuses a mismatched base, an implausible rate and a date out of range', async () => {
		for (const [body, expected] of [
			[fxBody(17881, { base: 'EUR' }), 'schema'],
			[fxBody(17881, { quote: 'USD' }), 'schema'],
			[fxBody(17881, { date: '2026-02-30' }), 'schema'],
			[fxBody(17.881), 'bounds'],
			[fxBody(1e7), 'bounds'],
			[fxBody(17881, { date: '2026-10-10' }), 'bounds'],
			[fxBody(17881, { date: '2026-09-01' }), 'bounds']
		] as const) {
			const { fetch } = stubFetch({ [FX_USD]: () => json(body) });
			expect(await reason(fetchIdrRate('USD', TODAY, fetch)), JSON.stringify(body)).toBe(expected);
		}
	});

	it('never builds a URL for a currency outside the allow-list', async () => {
		const { fetch, calls } = stubFetch({});
		expect(await reason(fetchIdrRate('../x', TODAY, fetch))).toBe('host');
		expect(await reason(fetchIdrRate('IDR', TODAY, fetch))).toBe('host');
		expect(calls).toEqual([]);
	});

	it('FN-47: HKD and CNY take ECB’s daily rate with the 14-day window', async () => {
		for (const [code, rate] of [
			['HKD', 2300.5],
			['CNY', 2512.25]
		] as const) {
			const url = `https://api.frankfurter.dev/v2/rate/${code}/IDR`;
			const ok = stubFetch({ [url]: () => json(fxBody(rate, { base: code, date: '2026-09-24' })) });
			expect(await fetchIdrRate(code, TODAY, ok.fetch)).toEqual({
				rate: String(rate),
				date: '2026-09-24'
			});
			expect(ok.calls).toEqual([url]);
			const stale = stubFetch({
				[url]: () => json(fxBody(rate, { base: code, date: '2026-09-23' }))
			});
			expect(await reason(fetchIdrRate(code, TODAY, stale.fetch))).toBe('bounds');
		}
	});

	it('FN-47: TWD (a monthly dataset) is accepted up to 40 days old, never older or in the future', async () => {
		const url = 'https://api.frankfurter.dev/v2/rate/TWD/IDR';
		const at = (date: string) =>
			stubFetch({ [url]: () => json(fxBody(560.12, { base: 'TWD', date })) }).fetch;
		// 15 and 40 days before 8 October: valid (a USD answer this old is refused).
		for (const date of ['2026-09-23', '2026-08-29'])
			expect(await fetchIdrRate('TWD', TODAY, at(date))).toEqual({ rate: '560.12', date });
		expect(
			await reason(
				fetchIdrRate(
					'USD',
					TODAY,
					stubFetch({ [FX_USD]: () => json(fxBody(17881, { date: '2026-09-23' })) }).fetch
				)
			)
		).toBe('bounds');
		for (const date of ['2026-08-28', '2026-10-10'])
			expect(await reason(fetchIdrRate('TWD', TODAY, at(date))), date).toBe('bounds');
		// The generic bounds apply: 0,0001 – 1.000.000 IDR per unit.
		const silly = stubFetch({ [url]: () => json(fxBody(2e6, { base: 'TWD', date: TODAY })) });
		expect(await reason(fetchIdrRate('TWD', TODAY, silly.fetch))).toBe('bounds');
	});

	it('only ever contacts the three allow-listed hosts', () => {
		for (const url of [TICKER_ALL, GOLD, FX_USD, FX_SGD])
			expect(PRICE_HOSTS).toContain(new URL(url).hostname);
	});
});

describe('refreshPrices and readPriceBook', () => {
	const allUp = () =>
		stubFetch({
			[TICKER_ALL]: () =>
				tickers({ btc_idr: { last: '1493387000' }, eth_idr: { last: '70000000' } }),
			[GOLD]: () => json(goldBody()),
			[FX_USD]: () => json(fxBody()),
			[FX_SGD]: () => json(fxBody(13900, { base: 'SGD' }))
		});

	it('writes every source with a TTL and reads it back as exact decimals', async () => {
		const { kv, puts } = fakeKv();
		const { fetch } = allUp();
		const r = await refreshPrices(
			kv,
			{ crypto: true, gold: true, currencies: ['SGD'] },
			fetch,
			NOW
		);
		expect(r).toEqual({
			coins: { ok: 2, held: 0, failed: false },
			gold: 'ok',
			fx: { ok: 2, failed: 0, skipped: 0 }
		});
		expect(puts.map((p) => p.key).sort()).toEqual([KV_FX, KV_GOLD, KV_INDODAX].sort());
		expect(puts.every((p) => p.ttl === KV_TTL_SECONDS)).toBe(true);
		const book = await readPriceBook(kv, NOW);
		expect(book.coins.get('btc')).toEqual({ price: { n: 1493387000n, exp: 0 }, at: NOW });
		expect(book.gold).toEqual({ usdPerOunce: { n: 4105299805n, exp: 6 }, at: NOW });
		expect(book.fx.get('USD')).toMatchObject({ text: '17881', date: '2026-10-07' });
		expect(book.fx.get('SGD')).toMatchObject({ text: '13900' });
	});

	it('provider down: keeps the last good value and logs without the body', async () => {
		const { kv, store } = fakeKv();
		await refreshPrices(kv, { crypto: true, gold: true, currencies: [] }, allUp().fetch, NOW);
		const before = new Map(store);
		const later = NOW + 60 * 60 * 1000;
		const down = stubFetch({
			[TICKER_ALL]: () => new Response('<h1>secret upstream page</h1>', { status: 502 }),
			[GOLD]: () => json({ price: 'NaN' }),
			[FX_USD]: () => json(fxBody())
		});
		const r = await refreshPrices(
			kv,
			{ crypto: true, gold: true, currencies: [] },
			down.fetch,
			later
		);
		expect(r.coins.failed).toBe(true);
		expect(r.gold).toBe('failed');
		expect(store.get(KV_INDODAX)).toBe(before.get(KV_INDODAX));
		expect(store.get(KV_GOLD)).toBe(before.get(KV_GOLD));
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).toContain('indodax');
		expect(logged).not.toContain('secret upstream page');
		const book = await readPriceBook(kv, later);
		expect(book.coins.get('btc')?.at).toBe(NOW);
	});

	it('FN-47: refreshes TWD, HKD and CNY like USD; a failing one keeps nothing invented', async () => {
		const { kv } = fakeKv();
		const url = (code: string) => `https://api.frankfurter.dev/v2/rate/${code}/IDR`;
		const { fetch } = stubFetch({
			[url('TWD')]: () => json(fxBody(560.12, { base: 'TWD', date: '2026-09-15' })),
			[url('HKD')]: () => json(fxBody(2300.5, { base: 'HKD' })),
			[url('CNY')]: () => new Response('down', { status: 503 })
		});
		const r = await refreshPrices(
			kv,
			{ crypto: false, gold: false, currencies: ['TWD', 'HKD', 'CNY'] },
			fetch,
			NOW
		);
		expect(r.fx).toEqual({ ok: 2, failed: 1, skipped: 0 });
		const book = await readPriceBook(kv, NOW);
		expect(book.fx.get('TWD')).toMatchObject({ text: '560.12', date: '2026-09-15', at: NOW });
		expect(book.fx.get('HKD')).toMatchObject({ text: '2300.5', at: NOW });
		expect(book.fx.has('CNY')).toBe(false);
	});

	it('fetches each rate once per WIB day', async () => {
		const { kv } = fakeKv();
		const first = allUp();
		await refreshPrices(kv, { crypto: false, gold: false, currencies: ['USD'] }, first.fetch, NOW);
		const second = allUp();
		const r = await refreshPrices(
			kv,
			{ crypto: false, gold: false, currencies: ['USD'] },
			second.fetch,
			NOW + 60 * 60 * 1000
		);
		expect(second.calls).toEqual([]);
		expect(r.fx).toEqual({ ok: 0, failed: 0, skipped: 1 });
		// 06:00 WIB the next day (23:00 UTC): a new WIB day, fetched again.
		const third = allUp();
		await refreshPrices(
			kv,
			{ crypto: false, gold: false, currencies: ['USD'] },
			third.fetch,
			Date.UTC(2026, 9, 8, 23, 0)
		);
		expect(third.calls).toEqual([FX_USD]);
	});

	it('keeps an older coin price when one coin is missing from a later answer', async () => {
		const { kv } = fakeKv();
		await refreshPrices(kv, { crypto: true, gold: false, currencies: [] }, allUp().fetch, NOW);
		const partial = stubFetch({ [TICKER_ALL]: () => tickers({ btc_idr: { last: '1500000000' } }) });
		const later = NOW + 3_600_000;
		await refreshPrices(kv, { crypto: true, gold: false, currencies: [] }, partial.fetch, later);
		const book = await readPriceBook(kv, later);
		expect(book.coins.get('btc')).toEqual({ price: { n: 1500000000n, exp: 0 }, at: later });
		expect(book.coins.get('eth')?.at).toBe(NOW);
	});

	it('caches every IDR pair of the answer, whatever coin codes users typed (red team M2)', async () => {
		const { kv } = fakeKv();
		const many: Record<string, { last: string }> = { btc_idr: { last: '1493387000' } };
		for (let i = 0; i < 600; i++) many[`a${String(i).padStart(4, '0')}_idr`] = { last: '1' };
		const { fetch, calls } = stubFetch({ [TICKER_ALL]: () => tickers(many) });
		await refreshPrices(kv, { crypto: true, gold: false, currencies: [] }, fetch, NOW);
		const book = await readPriceBook(kv, NOW);
		expect(calls).toEqual([TICKER_ALL]);
		expect(book.coins.size).toBe(601);
		expect(book.coins.get('btc')?.at).toBe(NOW);
	});

	it('holds a jump of more than 50 % until the next tick confirms it (red team L1)', async () => {
		const { kv } = fakeKv();
		const at = (price: string) =>
			stubFetch({ [TICKER_ALL]: () => tickers({ btc_idr: { last: price } }) });
		const demand = { crypto: true, gold: false, currencies: [] };
		await refreshPrices(kv, demand, at('1000000000').fetch, NOW);
		// ×1000 once: the last good price stays, flagged and logged.
		const h1 = NOW + 3_600_000;
		const r = await refreshPrices(kv, demand, at('1000000000000').fetch, h1);
		expect(r.coins).toMatchObject({ held: 1, ok: 0 });
		expect((await readPriceBook(kv, h1)).coins.get('btc')).toEqual({
			price: { n: 1000000000n, exp: 0 },
			at: NOW
		});
		expect(JSON.stringify(warn.mock.calls)).toContain('price jump held');
		// Back to normal: accepted (no jump against the last good price), the pending jump forgotten.
		const h2 = h1 + 3_600_000;
		await refreshPrices(kv, demand, at('1100000000').fetch, h2);
		expect((await readPriceBook(kv, h2)).coins.get('btc')?.price).toEqual({
			n: 1100000000n,
			exp: 0
		});
		// A real move seen on two ticks in a row is accepted on the second.
		const h3 = h2 + 3_600_000;
		await refreshPrices(kv, demand, at('500000000').fetch, h3);
		expect((await readPriceBook(kv, h3)).coins.get('btc')?.price.n).toBe(1100000000n);
		const h4 = h3 + 3_600_000;
		await refreshPrices(kv, demand, at('510000000').fetch, h4);
		expect((await readPriceBook(kv, h4)).coins.get('btc')).toEqual({
			price: { n: 510000000n, exp: 0 },
			at: h4
		});
	});

	it('a KV outage during the refresh is logged per source, never thrown', async () => {
		const { kv, state } = fakeKv();
		state.failing = true;
		const r = await refreshPrices(
			kv,
			{ crypto: true, gold: true, currencies: ['SGD'] },
			allUp().fetch,
			NOW
		);
		expect(r.coins.failed).toBe(true);
		expect(r.gold).toBe('failed');
		expect(r.fx.ok).toBe(2);
		expect(JSON.stringify(warn.mock.calls)).toContain('kv:fx');
	});

	it('reads nothing usable from a corrupt, hostile, too old or unreachable cache (never throws)', async () => {
		const { kv, store, state } = fakeKv();
		store.set(KV_INDODAX, '{not json');
		store.set(KV_GOLD, JSON.stringify({ v: 1, price: '1e9', at: NOW }));
		store.set(
			KV_FX,
			JSON.stringify({
				v: 1,
				entries: { USD: { rate: '17881', date: '2026-10-07', at: NOW - PRICE_MAX_AGE_MS * 10 } }
			})
		);
		let book = await readPriceBook(kv, NOW);
		expect(book.coins.size + book.fx.size).toBe(0);
		expect(book.gold).toBeNull();
		store.set(KV_GOLD, JSON.stringify({ v: 1, price: '4105.3', at: NOW + 3_600_000 }));
		expect((await readPriceBook(kv, NOW)).gold).toBeNull();
		store.set(KV_GOLD, JSON.stringify({ v: 1, price: '4105.3', at: NOW - PRICE_MAX_AGE_MS - 1 }));
		expect((await readPriceBook(kv, NOW)).gold).toBeNull();
		state.failing = true;
		book = await readPriceBook(kv, NOW);
		expect(book.gold).toBeNull();
		expect(await readPriceBook(undefined, NOW)).toMatchObject({ gold: null });
	});
});
