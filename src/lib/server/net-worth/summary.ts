import { and, eq, isNull, sql } from 'drizzle-orm';
import { netWorthSnapshots, spaces } from '../db/schema';
import { addDays, wibDateString } from '#lib/shared/dates';
import { currencyExponent } from '#lib/shared/money-format';
import type { EmoneyIssuer, WalletType } from '#lib/shared/wallets';
import {
	CLASS_OF_KIND,
	convertToIdrMinor,
	goldGramUnitPrice,
	idrUnitPrice,
	isLiabilityKind,
	NET_WORTH_CLASSES,
	netWorthValueMinor,
	type NetWorthClass,
	type UnitPrice,
	type ValueBasis
} from '#lib/shared/net-worth';
import type { Db } from '../db';
import { getCronCursor, setCronCursor } from '../notifications/schedule';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { safeMinor } from '../transactions/aggregate';
import { walletTransactionsSums } from '../transactions/wallet-sum';
import { shownBalance } from '../wallets/balance';
import { listWallets } from '../wallets/repo';
import { PRICE_STALE_AFTER_MS, type PriceBook } from './prices';
import { listNetWorthItems, type NetWorthItem } from './repo';

/** An item with what it is worth now and where that figure comes from. */
export interface ValuedNetWorthItem extends NetWorthItem {
	/** Positive magnitude in the item's currency; null: no price and no manual value ("Belum ada harga"). */
	valueMinor: number | null;
	basis: ValueBasis | null;
	/** When the price used was fetched (UTC ms); null for a manual value or a fallback. */
	priceAt: number | null;
	/** The price used is older than PRICE_STALE_AFTER_MS (shown with its time, never as live). */
	stale: boolean;
	/** An Indodax item whose coin code is not in the cached ticker: "harga tidak tersedia". */
	unlisted: boolean;
}

export interface NetWorthSummary {
	/** IDR sen: wallets + items − debts, foreign currencies converted at the cached daily rate. Null: too large. */
	totalMinor: number | null;
	/** Per allocation class in IDR sen (only classes that hold something); they add up to `totalMinor`. */
	classes: { cls: NetWorthClass; minor: number | null }[];
	/** Foreign amounts without a usable rate: listed apart, never in the total. */
	unconverted: { currency: string; minor: number | null }[];
	/** The rates used for the total, with their own dates. */
	rates: { currency: string; rate: string; date: string }[];
	items: ValuedNetWorthItem[];
	/** Items left out of the total: priced, no price cached and no manual value. */
	missingCount: number;
}

/** A wallet as the total needs it: its currency and balance (null when past the safe range). */
export interface WalletBalance {
	currency: string;
	balanceMinor: number | null;
	/** FN-55a: a `kartu_kredit` wallet that owes money counts on the Utang line; absent: any other wallet. */
	type?: WalletType;
}

/** The exact unit price for a priced item from the cache, or null (no price: the item falls back). */
function unitPriceFor(
	item: NetWorthItem,
	book: PriceBook
): { price: UnitPrice; at: number } | null {
	if (item.priceSource === 'indodax' && item.priceSymbol) {
		const coin = book.coins.get(item.priceSymbol);
		return coin ? { price: idrUnitPrice(coin.price), at: coin.at } : null;
	}
	if (item.priceSource === 'gold_api') {
		const usd = book.fx.get('USD');
		if (!book.gold || !usd) return null;
		return {
			price: goldGramUnitPrice(book.gold.usdPerOunce, usd.rate),
			at: Math.min(book.gold.at, usd.at)
		};
	}
	return null;
}

/**
 * The net-worth figures from wallets, items and the cached prices (pure: no I/O). Sums are exact BigInt; each
 * item rounds once (quantity × price), each (class, currency) sum is converted to IDR once, and the total is
 * the sum of the class figures, so the allocation always adds up to the total.
 */
export function summarizeNetWorth(
	wallets: readonly WalletBalance[],
	items: readonly NetWorthItem[],
	book: PriceBook,
	now: number
): NetWorthSummary {
	const buckets = new Map<NetWorthClass, Map<string, bigint>>();
	let tooLarge = false;
	const add = (cls: NetWorthClass, currency: string, amount: bigint) => {
		const byCurrency = buckets.get(cls) ?? new Map<string, bigint>();
		byCurrency.set(currency, (byCurrency.get(currency) ?? 0n) + amount);
		buckets.set(cls, byCurrency);
	};

	for (const w of wallets) {
		if (w.balanceMinor === null) tooLarge = true;
		// FN-55a A4: a card's owed balance is a liability (the `debt` class, never a bar segment); the total is the
		// same either way, only the class split moves. A card at zero or in credit stays with the wallets.
		else
			add(
				w.type === 'kartu_kredit' && w.balanceMinor < 0 ? 'debt' : 'wallets',
				w.currency,
				BigInt(w.balanceMinor)
			);
	}

	const usedRates = new Map<string, { currency: string; rate: string; date: string }>();
	const useRate = (currency: string) => {
		const fx = book.fx.get(currency);
		if (fx) usedRates.set(currency, { currency, rate: fx.text, date: fx.date });
		return fx;
	};

	let missingCount = 0;
	const valued: ValuedNetWorthItem[] = items.map((item) => {
		const priced = unitPriceFor(item, book);
		const unlisted =
			item.priceSource === 'indodax' &&
			book.coins.size > 0 &&
			!(item.priceSymbol && book.coins.has(item.priceSymbol));
		const value = netWorthValueMinor(item, priced?.price ?? null);
		if (!value) {
			if (!item.isDemo) missingCount++;
			return { ...item, valueMinor: null, basis: null, priceAt: null, stale: false, unlisted };
		}
		// A `Data demo` item is listed with its value but never added to a total (nor to a snapshot).
		if (!item.isDemo)
			add(
				CLASS_OF_KIND[item.kind],
				item.currency,
				isLiabilityKind(item.kind) ? -value.valueMinor : value.valueMinor
			);
		const priceAt = value.basis === 'price' && priced ? priced.at : null;
		// Gold is priced through the USD rate: shown with its date next to the total.
		if (priceAt !== null && item.priceSource === 'gold_api' && !item.isDemo) useRate('USD');
		return {
			...item,
			valueMinor: safeMinor(value.valueMinor),
			basis: value.basis,
			priceAt,
			stale: priceAt !== null && now - priceAt > PRICE_STALE_AFTER_MS,
			unlisted
		};
	});

	const unconverted = new Map<string, bigint>();
	const classes: { cls: NetWorthClass; minor: number | null }[] = [];
	let total = 0n;
	for (const cls of NET_WORTH_CLASSES) {
		const byCurrency = buckets.get(cls);
		if (!byCurrency) continue;
		let sum = 0n;
		for (const [currency, amount] of byCurrency) {
			if (currency === 'IDR') {
				sum += amount;
				continue;
			}
			const fx = useRate(currency);
			if (!fx) {
				unconverted.set(currency, (unconverted.get(currency) ?? 0n) + amount);
				continue;
			}
			sum += convertToIdrMinor(amount, currencyExponent(currency), fx.rate);
		}
		total += sum;
		classes.push({ cls, minor: safeMinor(sum) });
	}

	return {
		totalMinor: tooLarge ? null : safeMinor(total),
		classes,
		unconverted: [...unconverted]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([currency, minor]) => ({ currency, minor: safeMinor(minor) })),
		rates: [...usedRates.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)),
		items: valued,
		missingCount
	};
}

/** A live wallet as the Kekayaan page lists it (FN-25b): its balance as FN-04 computes it. */
export interface WalletLine extends WalletBalance {
	id: string;
	name: string;
	type: WalletType;
	lastFour: string | null;
	/** FN-55a, a card only: its typed limit and due day (the card's available credit and due chip). */
	creditLimitMinor: number | null;
	dueDay: number | null;
	/** FN-58 pass 1, an e-money card only: its issuer (the row's "Kartu e-money · BCA Flazz"). */
	emoneyIssuer: EmoneyIssuer | null;
}

/** The space's live wallets with their balances (FN-04's contract), as the total and the page need them. */
async function walletLines(db: Db, spaceId: string): Promise<WalletLine[]> {
	const [rows, sums] = await Promise.all([
		listWallets(db, spaceId, { includeArchived: false }),
		walletTransactionsSums(db, spaceId)
	]);
	return rows.map((w) => ({
		id: w.id,
		name: w.name,
		type: w.type,
		lastFour: w.lastFour,
		currency: w.currency,
		balanceMinor: shownBalance(w, sums.get(w.id)),
		creditLimitMinor: w.creditLimitMinor,
		dueDay: w.dueDay,
		emoneyIssuer: w.emoneyIssuer
	}));
}

/**
 * The net worth of `spaceId` now, with the live wallets it counted. Callers have already admitted the user with
 * `requireSpaceAccess` (the page) or are the jobs Worker; `book` comes from `readPriceBook`, so no external
 * call happens here.
 */
export async function netWorthSummary(
	db: Db,
	spaceId: string,
	book: PriceBook,
	now: number
): Promise<NetWorthSummary & { wallets: WalletLine[] }> {
	const [wallets, items] = await Promise.all([
		walletLines(db, spaceId),
		listNetWorthItems(db, spaceId)
	]);
	return { ...summarizeNetWorth(wallets, items, book, now), wallets };
}

// ---- Daily snapshots and the 30-day change ----

const CHANGE_DAYS = 30;

/**
 * The change shown under the total: against the snapshot of exactly 30 WIB days ago (`days30`); against an
 * older one when that day is missing (`since`, its date shown); against the oldest snapshot when the space is
 * younger than 30 days (`since_start`). Partial snapshots (a price or rate missing that day) are never used, so
 * an outage never shows as a gain or loss. Null: no earlier complete snapshot, or a figure too large to subtract.
 */
export interface NetWorthChange {
	kind: 'days30' | 'since' | 'since_start';
	fromDate: string;
	deltaMinor: number;
}

export async function netWorthChange(
	db: Db,
	spaceId: string,
	totalMinor: number | null,
	now: number
): Promise<NetWorthChange | null> {
	if (totalMinor === null) return null;
	const today = wibDateString(now);
	const target = addDays(today, -CHANGE_DAYS);
	// One round trip: the newest complete snapshot on or before the target (`k` 0) and the oldest one before
	// today (`k` 1, used only when there is no `k` 0 row), each one primary-key range step.
	const rows = await db.all<{
		k: number;
		date: string;
		total: number;
	}>(sql`select 0 as k, date, total
		from (select date, total_minor as total from net_worth_snapshots
			where space_id = ${spaceId} and deleted_at is null and partial = 0 and date <= ${target}
			order by date desc limit 1)
		union all
		select 1 as k, date, total
		from (select date, total_minor as total from net_worth_snapshots
			where space_id = ${spaceId} and deleted_at is null and partial = 0 and date < ${today}
			order by date asc limit 1)`);
	const atOrBefore = rows.find((r) => r.k === 0);
	const from = atOrBefore ?? rows.find((r) => r.k === 1);
	if (!from) return null;
	const delta = safeMinor(BigInt(totalMinor) - BigInt(from.total));
	if (delta === null) return null;
	return {
		kind: atOrBefore ? (from.date === target ? 'days30' : 'since') : 'since_start',
		fromDate: from.date,
		deltaMinor: delta
	};
}

/** Most due spaces one page query returns. */
const SNAPSHOT_PAGE_SIZE = 100;
/**
 * Worst-case D1 statements of one space's snapshot: its wallets, their transaction sums and its items
 * (`netWorthSummary`), then the seq bump and the upsert (`upsertSnapshot`). A test measures it.
 */
export const SNAPSHOT_SPACE_STATEMENTS = 5;
/** A snapshot written more recently than this is current for this tick. */
const SNAPSHOT_REFRESH_MS = 30 * 60 * 1000;
/** `app_meta` key of the rotating cursor: the id of the last space a tick handled. */
const SNAPSHOT_CURSOR_KEY = 'net_worth_snapshot_cursor';

/**
 * Live spaces holding a live wallet or item whose snapshot for `date` (WIB) is missing or older than
 * SNAPSHOT_REFRESH_MS, with an id in (`after`, `upTo`], in id order, at most `limit`.
 */
export async function spacesDueForSnapshot(
	db: Db,
	date: string,
	now: number,
	{
		after = '',
		upTo = null,
		limit = SNAPSHOT_PAGE_SIZE
	}: { after?: string; upTo?: string | null; limit?: number } = {}
): Promise<string[]> {
	const rows = await db.all<{ id: string }>(sql`select s.id as id from spaces s
		left join net_worth_snapshots n on n.space_id = s.id and n.date = ${date}
		where s.deleted_at is null and s.id > ${after}
			${upTo === null ? sql`` : sql`and s.id <= ${upTo}`}
			and (n.space_id is null or n.updated_at < ${now - SNAPSHOT_REFRESH_MS})
			and (exists (select 1 from wallets w where w.space_id = s.id and w.deleted_at is null)
				or exists (select 1 from net_worth_items i where i.space_id = s.id and i.deleted_at is null))
		order by s.id
		limit ${Math.max(1, Math.min(limit, SNAPSHOT_PAGE_SIZE))}`);
	return rows.map((r) => r.id);
}

/**
 * The summary's per-class figures as the snapshot stores them (FN-53, `classes`): a JSON object of the classes that
 * hold something, in IDR sen. Null when a class is too large to store exactly (then no group split, never a guess).
 */
function snapshotClasses(
	classes: readonly { cls: NetWorthClass; minor: number | null }[]
): string | null {
	const record: Partial<Record<NetWorthClass, number>> = {};
	for (const c of classes) {
		if (c.minor === null) return null;
		record[c.cls] = c.minor;
	}
	return JSON.stringify(record);
}

/**
 * The summary left something out: an item without a price, a priced item on its manual fallback (red team L5)
 * or a currency without a rate. Such a total is never an opening or closing value of a comparison.
 */
export function summaryIsPartial(summary: NetWorthSummary): boolean {
	return (
		summary.missingCount > 0 ||
		summary.unconverted.length > 0 ||
		summary.items.some((i) => i.basis === 'fallback')
	);
}

/**
 * Writes (or overwrites) the space's snapshot for WIB `date` in one batch with its seq bump; nothing for a
 * space deleted meanwhile (the insert selects from the live space row). A partial figure never replaces a
 * complete one of the same day (red team L2), its `classes` (FN-53) included.
 */
export async function upsertSnapshot(
	db: Db,
	spaceId: string,
	date: string,
	totalMinor: number,
	now: number,
	partial = false,
	classes: string | null = null
): Promise<void> {
	await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(netWorthSnapshots)
			.select((qb) =>
				qb
					.select({
						spaceId: spaces.id,
						date: sql`${date}`.as('date'),
						totalMinor: sql`${totalMinor}`.as('total_minor'),
						currency: sql`'IDR'`.as('currency'),
						partial: sql`${partial ? 1 : 0}`.as('partial'),
						classes: sql`${classes}`.as('classes'),
						createdAt: sql`${now}`.as('created_at'),
						updatedAt: sql`${now}`.as('updated_at'),
						deletedAt: sql`null`.as('deleted_at'),
						seq: sql`${currentSpaceSeq(spaceId)}`.as('seq')
					})
					.from(spaces)
					.where(and(eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
			)
			.onConflictDoUpdate({
				target: [netWorthSnapshots.spaceId, netWorthSnapshots.date],
				set: {
					totalMinor: sql`excluded.total_minor`,
					partial: sql`excluded.partial`,
					classes: sql`excluded.classes`,
					updatedAt: sql`excluded.updated_at`,
					seq: sql`excluded.seq`,
					deletedAt: null
				},
				setWhere: sql`excluded.partial = 0 or ${netWorthSnapshots.partial} = 1`
			})
	]);
}

/**
 * One run of daily snapshots: today's (WIB) total for due spaces from the cached prices, marked partial when an
 * item had no price (or used its manual fallback) or a currency no rate. A space whose total is too large is
 * skipped; a failing space is logged (id only) and the rest continue.
 *
 * Paged by the D1 statements the run may still use (`statementsLeft`, read before every page: the caller's
 * share of D1's per-invocation cap, counted with `countStatements`), so a tick does as many spaces as the cap
 * allows instead of a fixed 100 (FN-25 red team L4). It walks the due spaces after the stored cursor, then wraps
 * round from the start up to that cursor; it saves where it stopped (the last space handled; '' after a full
 * round), so the next tick continues there. A skipped or failed space moves behind the cursor and never holds a
 * slot (red team M1). `more`: stopped by the budget with due spaces left.
 */
export async function writeSnapshots(
	db: Db,
	book: PriceBook,
	now: number,
	statementsLeft: () => number
): Promise<{ written: number; partial: number; skipped: number; failed: number; more: boolean }> {
	const date = wibDateString(now);
	const counts = { written: 0, partial: 0, skipped: 0, failed: 0 };
	// Room for the cursor read, one page, one space and the cursor write, or nothing is touched.
	if (statementsLeft() < 3 + SNAPSHOT_SPACE_STATEMENTS) return { ...counts, more: true };
	const start = (await getCronCursor(db, SNAPSHOT_CURSOR_KEY)) ?? '';
	const segments: { after: string; upTo: string | null }[] =
		start === ''
			? [{ after: '', upTo: null }]
			: [
					{ after: start, upTo: null },
					{ after: '', upTo: start }
				];
	let cursor = start;
	let more = false;
	walk: for (const segment of segments) {
		let after = segment.after;
		for (;;) {
			// This page's query and the cursor write at the end come first.
			const room = Math.floor((statementsLeft() - 2) / SNAPSHOT_SPACE_STATEMENTS);
			if (room < 1) {
				more = true;
				break walk;
			}
			const limit = Math.min(room, SNAPSHOT_PAGE_SIZE);
			const ids = await spacesDueForSnapshot(db, date, now, { after, upTo: segment.upTo, limit });
			for (const spaceId of ids) {
				await snapshotSpace(db, spaceId, date, book, now, counts);
				after = cursor = spaceId;
			}
			if (ids.length < limit) break;
		}
	}
	if (!more || cursor !== start)
		await setCronCursor(db, SNAPSHOT_CURSOR_KEY, more ? cursor : '', now);
	return { ...counts, more };
}

/** One space's snapshot for `writeSnapshots`, counted into `counts`; never throws. */
async function snapshotSpace(
	db: Db,
	spaceId: string,
	date: string,
	book: PriceBook,
	now: number,
	counts: { written: number; partial: number; skipped: number; failed: number }
): Promise<void> {
	try {
		const summary = await netWorthSummary(db, spaceId, book, now);
		if (summary.totalMinor === null) {
			counts.skipped++;
			return;
		}
		const partial = summaryIsPartial(summary);
		await upsertSnapshot(
			db,
			spaceId,
			date,
			summary.totalMinor,
			now,
			partial,
			snapshotClasses(summary.classes)
		);
		counts.written++;
		if (partial) counts.partial++;
	} catch (e) {
		counts.failed++;
		console.error('net-worth: snapshot failed', { spaceId, error: String(e).slice(0, 200) });
	}
}
