import { z } from 'zod';
import { addDays, isDateString, wibDateString } from '#lib/shared/dates';
import { parseDecimal, type Decimal } from '#lib/shared/net-worth';
import { WALLET_CURRENCIES } from '#lib/shared/wallets';

/**
 * External prices for net worth (FN-25). Server-only: the jobs Worker's hourly cron (06–23 WIB) fetches and
 * writes the `CACHE` KV namespace; page loads only read KV, so a page never waits on, or fails with, a third
 * party, and the browser never calls these hosts (the CSP stays `connect-src 'self'`).
 *
 * Sources (terms re-checked 2026-10-08, see docs/features/fn-25-net-worth/ENGINEER_REPORT.md):
 * - Indodax public REST `GET https://indodax.com/api/ticker_all` (keyless; documented limit 180 requests per
 *   minute; one request per tick covers every coin in use). `last` is IDR per coin.
 * - gold-api.com `GET https://api.gold-api.com/price/XAU` (keyless real-time price; commercial use permitted;
 *   no more than one request per second). USD per troy ounce.
 * - Frankfurter v2 `GET https://api.frankfurter.dev/v2/rate/<CUR>/IDR` (keyless; free for commercial use; no
 *   quotas, abuse rate-limited). IDR per one unit of CUR, with the rate's own date. Fetched once per WIB day
 *   per currency in use.
 *
 * KV keys (one per source, so a page load costs at most three reads; each `put` only after a fully validated
 * fetch, so a failure always leaves the last good value):
 * - `price:indodax`   → `{ v: 1, entries: { <coin>: { price, at } } }`  IDR per coin, decimal text
 * - `price:gold_api:xau` → `{ v: 1, price, at }`                         USD per troy ounce, decimal text
 * - `fx:idr`          → `{ v: 1, entries: { <CUR>: { rate, date, at } } }` IDR per unit, decimal text
 * `at` is the fetch time (UTC ms). Values are written with a KV `expirationTtl` of KV_TTL_SECONDS; a price older
 * than PRICE_MAX_AGE_MS is no longer used (the item falls back to its manual value), and one older than
 * PRICE_STALE_AFTER_MS is shown with its time as "not updated".
 */

/** The only hosts the fetchers may contact (exact match, HTTPS, default port). */
export const PRICE_HOSTS: readonly string[] = [
	'indodax.com',
	'api.gold-api.com',
	'api.frankfurter.dev'
];
const FETCH_TIMEOUT_MS = 8_000;
/** Body caps: ticker_all is ~75 KB (2026-10-08); the single-price answers are under 300 bytes. */
const MAX_TICKER_ALL_BYTES = 512 * 1024;
const MAX_SMALL_BYTES = 8 * 1024;

export const KV_INDODAX = 'price:indodax';
export const KV_GOLD = 'price:gold_api:xau';
export const KV_FX = 'fx:idr';
/** How long KV keeps a key after its last successful write. */
export const KV_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * A price older than this is labelled as not updated. The cron skips 00–05 WIB, so the newest price at 05:59
 * WIB is about 7 hours old; 8 hours keeps that normal night gap from being called stale.
 */
export const PRICE_STALE_AFTER_MS = 8 * 60 * 60 * 1000;
/** A price (or rate) older than this is not used at all: the item falls back to its manual value. */
export const PRICE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const FX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Sanity bounds: a value outside them is refused as a bad payload, never stored. */
const MAX_COIN_PRICE_IDR = 10n ** 13n;
const MAX_PRICE_DECIMALS = 12;
const E8 = 100_000_000n;
/** USD per troy ounce: 100 – 100.000 (spot was 4.105 on 2026-10-08). */
const GOLD_USD_BOUNDS = [100n * E8, 100_000n * E8] as const;
/** IDR per unit: USD 1.000 – 100.000 (17.881 on 2026-10-07); any other currency 0,0001 – 1.000.000. */
const FX_BOUNDS: Readonly<Record<string, readonly [bigint, bigint]>> = {
	USD: [1_000n * E8, 100_000n * E8]
};
const FX_DEFAULT_BOUNDS = [10_000n, 1_000_000n * E8] as const;
/**
 * How many days old a rate may be. Frankfurter republishes TWD monthly, not on ECB's daily cycle (checked on
 * frankfurter.dev 2026-10-11), so its window covers a month plus a margin (owner decision 1, FN-47).
 */
const FX_RATE_MAX_AGE_DAYS: Readonly<Record<string, number>> = { TWD: 40 };
const FX_RATE_DEFAULT_MAX_AGE_DAYS = 14;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type PriceFailure =
	'host' | 'network' | 'redirect' | 'status' | 'too_large' | 'json' | 'schema' | 'bounds';

export class PriceFetchError extends Error {
	constructor(readonly reason: PriceFailure) {
		super(`price fetch failed: ${reason}`);
	}
}

/** A JSON answer from an allow-listed host: no redirect followed, time- and size-capped, body never logged. */
async function getJson(url: string, maxBytes: number, fetchFn: FetchLike): Promise<unknown> {
	const target = new URL(url);
	if (
		target.protocol !== 'https:' ||
		target.port !== '' ||
		target.username !== '' ||
		target.password !== '' ||
		!PRICE_HOSTS.includes(target.hostname)
	)
		throw new PriceFetchError('host');
	let response: Response;
	try {
		response = await fetchFn(target.href, {
			method: 'GET',
			headers: { accept: 'application/json' },
			redirect: 'manual',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
	} catch {
		throw new PriceFetchError('network');
	}
	// `redirect: 'manual'` hands a 3xx back as is (Workers): never followed, to this host or another.
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => {});
		throw new PriceFetchError('redirect');
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new PriceFetchError('status');
	}
	const declared = Number(response.headers.get('content-length') ?? '0');
	if (declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new PriceFetchError('too_large');
	}
	const text = await readCapped(response, maxBytes);
	try {
		return JSON.parse(text);
	} catch {
		throw new PriceFetchError('json');
	}
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new PriceFetchError('too_large');
			}
			chunks.push(value);
		}
	} catch (e) {
		if (e instanceof PriceFetchError) throw e;
		throw new PriceFetchError('network');
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		bytes.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/** A JSON number as plain decimal text (`4105.299805`); null for exponent forms, non-finite or too precise. */
function numberText(value: number, maxDecimals: number): string | null {
	if (!Number.isFinite(value) || value <= 0) return null;
	const text = String(value);
	return parseDecimal(text, maxDecimals) ? text : null;
}

/** min ≤ d ≤ max, compared exactly; the bounds are in units of 10^-8 (`E8`). */
const decimalWithin = (d: Decimal, [min, max]: readonly [bigint, bigint]) => {
	const value = d.n * E8;
	const unit = 10n ** BigInt(d.exp);
	return value >= min * unit && value <= max * unit;
};

const coinCode = /^[a-z0-9]{1,15}$/;
const tickerAllSchema = z.object({ tickers: z.record(z.string(), z.unknown()) });
const tickerSchema = z.object({ last: z.string().max(40) });

/** Most `<coin>_idr` pairs kept from one answer (Indodax lists a few hundred; the body cap bounds it anyway). */
const MAX_PAIRS = 2_000;

/**
 * IDR per coin for **every** `<coin>_idr` pair in one Indodax `ticker_all` answer, so no user's coin codes decide
 * what gets priced (red team M2). A pair with a malformed or out-of-bounds `last` is simply absent; a malformed
 * answer as a whole throws.
 */
export async function fetchIndodaxPrices(fetchFn: FetchLike): Promise<Map<string, string>> {
	const body = tickerAllSchema.safeParse(
		await getJson('https://indodax.com/api/ticker_all', MAX_TICKER_ALL_BYTES, fetchFn)
	);
	if (!body.success) throw new PriceFetchError('schema');
	const prices = new Map<string, string>();
	for (const [pair, raw] of Object.entries(body.data.tickers)) {
		if (prices.size >= MAX_PAIRS) break;
		if (!pair.endsWith('_idr')) continue;
		const coin = pair.slice(0, -'_idr'.length);
		if (!coinCode.test(coin)) continue;
		const ticker = tickerSchema.safeParse(raw);
		if (!ticker.success) continue;
		const price = parseDecimal(ticker.data.last, MAX_PRICE_DECIMALS);
		if (!price || price.n <= 0n || price.n > MAX_COIN_PRICE_IDR * 10n ** BigInt(price.exp))
			continue;
		prices.set(coin, ticker.data.last);
	}
	return prices;
}

/**
 * A move larger than this factor (up or down) against the last good price is held for confirmation (red team
 * L1): ×1,5 / ÷1,5, i.e. more than a 50 % rise or a 33 % fall within an hour.
 */
const JUMP_NUM = 3n;
const JUMP_DEN = 2n;

/** True when `next` differs from `prev` by more than JUMP_NUM/JUMP_DEN either way (exact). */
function isPriceJump(prev: Decimal, next: Decimal): boolean {
	const e = Math.max(prev.exp, next.exp);
	const a = prev.n * 10n ** BigInt(e - prev.exp);
	const b = next.n * 10n ** BigInt(e - next.exp);
	return b * JUMP_DEN > a * JUMP_NUM || a * JUMP_DEN > b * JUMP_NUM;
}

const goldSchema = z.object({
	symbol: z.literal('XAU'),
	currency: z.literal('USD'),
	price: z.number()
});

/** USD per troy ounce of gold, as decimal text. Throws on any malformed or implausible answer. */
export async function fetchGoldSpotUsd(fetchFn: FetchLike): Promise<string> {
	const body = goldSchema.safeParse(
		await getJson('https://api.gold-api.com/price/XAU', MAX_SMALL_BYTES, fetchFn)
	);
	if (!body.success) throw new PriceFetchError('schema');
	const text = numberText(body.data.price, 8);
	const price = text ? parseDecimal(text, 8) : null;
	if (!text || !price || !decimalWithin(price, GOLD_USD_BOUNDS))
		throw new PriceFetchError('bounds');
	return text;
}

const fxSchema = z.object({
	date: z.string().max(10),
	base: z.string().max(3),
	quote: z.literal('IDR'),
	rate: z.number()
});

/**
 * IDR per one unit of `currency` (an allow-listed wallet currency other than IDR) with the rate's own date
 * (the provider's latest publication; a weekend asks get Friday's). Throws on any malformed, mismatched,
 * implausible or out-of-date answer (a date after tomorrow, or more than 14 days before `today`; 40 for TWD's
 * monthly dataset).
 */
export async function fetchIdrRate(
	currency: string,
	today: string,
	fetchFn: FetchLike
): Promise<{ rate: string; date: string }> {
	if (currency === 'IDR' || !(WALLET_CURRENCIES as readonly string[]).includes(currency))
		throw new PriceFetchError('host');
	const body = fxSchema.safeParse(
		await getJson(`https://api.frankfurter.dev/v2/rate/${currency}/IDR`, MAX_SMALL_BYTES, fetchFn)
	);
	if (!body.success || body.data.base !== currency || !isDateString(body.data.date))
		throw new PriceFetchError('schema');
	const maxAge = FX_RATE_MAX_AGE_DAYS[currency] ?? FX_RATE_DEFAULT_MAX_AGE_DAYS;
	if (body.data.date > addDays(today, 1) || body.data.date < addDays(today, -maxAge))
		throw new PriceFetchError('bounds');
	const bounds = FX_BOUNDS[currency] ?? FX_DEFAULT_BOUNDS;
	const text = numberText(body.data.rate, 8);
	const rate = text ? parseDecimal(text, 8) : null;
	if (!text || !rate || !decimalWithin(rate, bounds)) throw new PriceFetchError('bounds');
	return { rate: text, date: body.data.date };
}

// ---- KV cache ----

const decimalText = z
	.string()
	.max(40)
	.refine((s) => parseDecimal(s, MAX_PRICE_DECIMALS) !== null);
const at = z.number().int().nonnegative();
const coinBookSchema = z.object({
	v: z.literal(1),
	entries: z.record(
		z.string().regex(coinCode),
		z.object({
			price: decimalText,
			at,
			/** A jump seen once and not yet confirmed by the next tick (the last good price stays in use). */
			pending: z.object({ price: decimalText, at }).optional()
		})
	)
});
const goldBookSchema = z.object({ v: z.literal(1), price: decimalText, at });
const fxBookSchema = z.object({
	v: z.literal(1),
	entries: z.record(
		z.string().regex(/^[A-Z]{3}$/),
		z.object({ rate: decimalText, date: z.string().refine(isDateString), at })
	)
});

type CoinBook = z.infer<typeof coinBookSchema>;
type FxBook = z.infer<typeof fxBookSchema>;

/** What the cache knows, already age-filtered: everything here may be used for a value. */
export interface PriceBook {
	coins: Map<string, { price: Decimal; at: number }>;
	gold: { usdPerOunce: Decimal; at: number } | null;
	fx: Map<string, { rate: Decimal; text: string; date: string; at: number }>;
}

export const emptyPriceBook = (): PriceBook => ({ coins: new Map(), gold: null, fx: new Map() });

/** A KV JSON value checked against `schema`; null when absent, unreadable or malformed (never throws). */
async function readKv<T>(kv: KVNamespace, key: string, schema: z.ZodType<T>): Promise<T | null> {
	try {
		const raw = await kv.get(key, 'text');
		if (raw === null || raw.length > MAX_TICKER_ALL_BYTES) return null;
		const parsed = schema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch (e) {
		console.warn('net-worth: price cache read failed', { key, error: String(e).slice(0, 100) });
		return null;
	}
}

/**
 * The cached prices usable at `now` (prices up to PRICE_MAX_AGE_MS old, rates up to FX_MAX_AGE_MS). Never
 * throws: a KV outage or a corrupt value reads as "no price", so items fall back to their manual values.
 */
export async function readPriceBook(kv: KVNamespace | undefined, now: number): Promise<PriceBook> {
	const book = emptyPriceBook();
	if (!kv) return book;
	const [coins, gold, fx] = await Promise.all([
		readKv(kv, KV_INDODAX, coinBookSchema),
		readKv(kv, KV_GOLD, goldBookSchema),
		readKv(kv, KV_FX, fxBookSchema)
	]);
	const fresh = (t: number, maxAge: number) => t <= now + 60_000 && now - t <= maxAge;
	for (const [coin, e] of Object.entries(coins?.entries ?? {}))
		if (fresh(e.at, PRICE_MAX_AGE_MS))
			book.coins.set(coin, {
				price: parseDecimal(e.price, MAX_PRICE_DECIMALS) as Decimal,
				at: e.at
			});
	if (gold && fresh(gold.at, PRICE_MAX_AGE_MS))
		book.gold = {
			usdPerOunce: parseDecimal(gold.price, MAX_PRICE_DECIMALS) as Decimal,
			at: gold.at
		};
	for (const [currency, e] of Object.entries(fx?.entries ?? {}))
		if (fresh(e.at, FX_MAX_AGE_MS))
			book.fx.set(currency, {
				rate: parseDecimal(e.rate, MAX_PRICE_DECIMALS) as Decimal,
				text: e.rate,
				date: e.date,
				at: e.at
			});
	return book;
}

export interface RefreshDemand {
	/** Any live Indodax-priced item exists (the whole ticker is then cached, never a per-code list). */
	crypto: boolean;
	gold: boolean;
	currencies: string[];
}

export interface RefreshResult {
	coins: { ok: number; held: number; failed: boolean };
	gold: 'ok' | 'failed' | 'skipped';
	fx: { ok: number; failed: number; skipped: number };
}

const logFailure = (source: string, e: unknown) =>
	console.warn('net-worth: price fetch failed', {
		source,
		reason: e instanceof PriceFetchError ? e.reason : 'error'
	});

/**
 * One cron tick's refresh: every Indodax IDR pair (one request) when any crypto item exists, gold when any gold
 * item exists, and a rate for each foreign currency in use (plus USD for gold) not yet fetched this WIB day. Each
 * source is written to KV only after its answer validated; a failed source keeps its previous value (last good).
 * A coin price that jumps past the factor in `isPriceJump` keeps its last good price until a second tick
 * confirms the new level. Entries older than PRICE_MAX_AGE_MS are dropped on the next successful write.
 */
export async function refreshPrices(
	kv: KVNamespace,
	demand: RefreshDemand,
	fetchFn: FetchLike,
	now: number
): Promise<RefreshResult> {
	const result: RefreshResult = {
		coins: { ok: 0, held: 0, failed: false },
		gold: 'skipped',
		fx: { ok: 0, failed: 0, skipped: 0 }
	};
	const put = (key: string, value: unknown) =>
		kv.put(key, JSON.stringify(value), { expirationTtl: KV_TTL_SECONDS });

	if (demand.crypto) {
		try {
			const prices = await fetchIndodaxPrices(fetchFn);
			const previous = await readKv(kv, KV_INDODAX, coinBookSchema);
			const entries: CoinBook['entries'] = {};
			// Last good prices of pairs missing from this answer stay until they age out.
			for (const [coin, old] of Object.entries(previous?.entries ?? {}))
				if (!prices.has(coin) && now - old.at <= PRICE_MAX_AGE_MS) entries[coin] = old;
			for (const [coin, text] of prices) {
				const old = previous?.entries[coin];
				const next = parseDecimal(text, MAX_PRICE_DECIMALS) as Decimal;
				const usable = old && now - old.at <= PRICE_MAX_AGE_MS ? old : null;
				if (
					!usable ||
					!isPriceJump(parseDecimal(usable.price, MAX_PRICE_DECIMALS) as Decimal, next)
				) {
					entries[coin] = { price: text, at: now };
					continue;
				}
				// A jump: accepted only when the previous tick already saw the same level (two in a row).
				const pending = usable.pending;
				if (
					pending &&
					!isPriceJump(parseDecimal(pending.price, MAX_PRICE_DECIMALS) as Decimal, next)
				) {
					entries[coin] = { price: text, at: now };
					continue;
				}
				entries[coin] = { price: usable.price, at: usable.at, pending: { price: text, at: now } };
				result.coins.held++;
				console.warn('net-worth: price jump held', { source: 'indodax', coin });
			}
			result.coins.ok = prices.size - result.coins.held;
			if (prices.size > 0) await put(KV_INDODAX, { v: 1, entries });
		} catch (e) {
			result.coins.failed = true;
			logFailure('indodax', e);
		}
	}

	if (demand.gold) {
		try {
			await put(KV_GOLD, { v: 1, price: await fetchGoldSpotUsd(fetchFn), at: now });
			result.gold = 'ok';
		} catch (e) {
			result.gold = 'failed';
			logFailure('gold_api', e);
		}
	}

	const wanted = new Set(demand.currencies.filter((c) => c !== 'IDR'));
	if (demand.gold) wanted.add('USD');
	if (wanted.size > 0) {
		const today = wibDateString(now);
		const previous = await readKv(kv, KV_FX, fxBookSchema);
		const entries: FxBook['entries'] = {};
		let fetched = 0;
		for (const currency of [...wanted].sort()) {
			const old = previous?.entries[currency];
			if (old && wibDateString(old.at) === today) {
				entries[currency] = old;
				result.fx.skipped++;
				continue;
			}
			try {
				entries[currency] = { ...(await fetchIdrRate(currency, today, fetchFn)), at: now };
				fetched++;
			} catch (e) {
				result.fx.failed++;
				logFailure(`frankfurter:${currency}`, e);
				if (old && now - old.at <= FX_MAX_AGE_MS) entries[currency] = old;
			}
		}
		result.fx.ok = fetched;
		if (fetched > 0)
			await put(KV_FX, { v: 1, entries }).catch((e: unknown) => logFailure('kv:fx', e));
	}
	return result;
}
