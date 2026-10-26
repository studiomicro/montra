import { error, fail, redirect } from '@sveltejs/kit';
import { getEnv } from '#lib/server/env';
import { belongingsTotal } from '#lib/server/belongings/repo';
import { collectiblesTotal } from '#lib/server/collectibles/repo';
import { readFormBody, textField } from '#lib/server/forms';
import { errorLabel } from '#lib/server/util';
import { NW_CHANGED, NW_LIMIT, NW_LOAD_FAILED, NW_NOT_FOUND } from '#lib/server/net-worth/messages';
// One phrase for every read-only `Data demo` row (FN-28's answer, same i18n key).
import { COLLECTIBLE_DEMO_READONLY as DEMO_READONLY } from '#lib/server/collectibles/messages';
import { readPriceBook } from '#lib/server/net-worth/prices';
import {
	createNetWorthItem,
	deleteNetWorthItem,
	updateNetWorthItem,
	type NetWorthWriteResult
} from '#lib/server/net-worth/repo';
import { cardSummaries } from '#lib/server/cards/summary';
import { creditCardSpend } from '#lib/server/net-worth/credit-cards';
import { sectionTotals } from '#lib/server/net-worth/sections';
import { netWorthChange, netWorthSummary, type WalletLine } from '#lib/server/net-worth/summary';
import { netWorthTrend } from '#lib/server/net-worth/trend';
import { parseNetWorthForm } from '#lib/server/net-worth/validation';
import { requireSpaceAccess, type SpaceScope } from '#lib/server/spaces/access';
import { wibTodayString } from '#lib/shared/dates';
import {
	allocationOf,
	parseTrendRange,
	type TrendRange,
	type WealthSuggestion
} from '#lib/shared/wealth';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// Kekayaan bersih (FN-25), the Fitur section's net-worth page; wallets and goals moved to /dompet (wave C). The
// page works on the session's current space (locals.space, already a re-validated membership). Every load
// and action still passes it through requireSpaceAccess with locals.user, so there is one access rule; an
// item id from the form is only ever looked up inside that space, so another space's id and an unknown id
// get the same answer.

/** Longest item id read from a form; ids are UUIDs, anything longer cannot match. */
const ITEM_ID_MAX_LENGTH = 64;
/** An `updated_at` (epoch ms) as the form carries it. */
const UPDATED_AT = /^\d{1,15}$/;

async function pageScope(locals: App.Locals) {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	if (!locals.space) error(404, 'Not found');
	const access = await requireSpaceAccess(locals.db, user.id, locals.space.id);
	const scope: SpaceScope = { spaceId: access.space.id, userId: user.id };
	return { scope };
}

/** `&saran=emas|pensiun` (a "Belum dihitung" card without JavaScript): the suggestion to pre-fill from. */
function suggestionParam(value: string | null): WealthSuggestion | null {
	return value === 'emas' ? 'gold' : value === 'pensiun' ? 'pension' : null;
}

function itemId(form: FormData): string {
	const id = textField(form, 'itemId');
	return id.length > ITEM_ID_MAX_LENGTH ? '' : id;
}

/** The coin codes of the latest cached Indodax ticker; null while none is cached (codes then accepted). */
async function knownCoins(): Promise<ReadonlySet<string> | null> {
	const book = await readPriceBook(getEnv().CACHE, Date.now());
	return book.coins.size > 0 ? new Set(book.coins.keys()) : null;
}

function itemRefused(result: Exclude<NetWorthWriteResult, 'ok'>) {
	if (result === 'demo') return fail(400, { nwError: DEMO_READONLY });
	return result === 'missing'
		? fail(404, { nwError: NW_NOT_FOUND })
		: fail(409, { nwError: NW_CHANGED });
}

/** The `updated_at` the form was loaded with; -1 (matches nothing, so "changed meanwhile") when malformed. */
function expectedUpdatedAt(form: FormData): number {
	const value = textField(form, 'updatedAt');
	return UPDATED_AT.test(value) ? Number(value) : -1;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const { scope } = await pageScope(locals);
	// Each section loads on its own: a failure in one leaves the others as they are.
	// FN-27: the belongings value (same rows and estimate as /barang).
	const belongings = await loadBelongings(locals.db, scope.spaceId);
	// FN-28: the collectibles value (same rows as /koleksi, Data demo left out).
	const collectibles = await loadCollectibles(locals.db, scope.spaceId);
	// The net-worth section (FN-25); `?aset=baru` / `?aset=<id>` open its form without JS, `&saran=` (FN-25b's
	// "Belum dihitung" cards) pre-fills the new item.
	const now = Date.now();
	const today = wibTodayString(now);
	const netWorth = await loadNetWorth(locals.db, scope.spaceId, now);
	// FN-25b: the trend chart's range (`?rentang=`) and the credit cards' 30-day spend.
	const range = parseTrendRange(url.searchParams.get('rentang'));
	const trend = await loadTrend(locals.db, scope.spaceId, range, today);
	const creditCards = await loadCreditCards(locals.db, scope.spaceId, netWorth.wallets, today);
	const openItem = url.searchParams.get('aset')?.slice(0, ITEM_ID_MAX_LENGTH) ?? null;
	const suggestion = suggestionParam(url.searchParams.get('saran'));
	return { netWorth, trend, creditCards, openItem, suggestion, belongings, collectibles };
};

/**
 * The net-worth section: the total, its allocation, the items with their values and the change since the
 * snapshot of 30 days ago. Prices come only from the KV cache the jobs Worker fills (never a fetch here); a
 * KV outage reads as "no price" and items fall back to their manual values. A D1 failure shows the section's
 * error state and leaves the rest of the page as it is.
 */
async function loadNetWorth(db: App.Locals['db'], spaceId: string, now: number) {
	try {
		const book = await readPriceBook(getEnv().CACHE, now);
		const summary = await netWorthSummary(db, spaceId, book, now);
		const change = await netWorthChange(db, spaceId, summary.totalMinor, now);
		const { wallets, ...rest } = summary;
		return {
			summary: rest,
			change,
			wallets,
			allocation: allocationOf(summary.classes),
			sections: sectionTotals(wallets, summary.items),
			error: null
		};
	} catch (e) {
		console.error('kekayaan: net worth failed', errorLabel(e));
		return {
			summary: null,
			change: null,
			wallets: [],
			allocation: null,
			sections: null,
			error: NW_LOAD_FAILED
		};
	}
}

/** The stored daily totals of the chosen range (FN-25b); a failure shows the chart's own error state. */
async function loadTrend(db: App.Locals['db'], spaceId: string, range: TrendRange, today: string) {
	try {
		return { range, points: await netWorthTrend(db, spaceId, range, today), failed: false };
	} catch (e) {
		console.error('kekayaan: trend failed', errorLabel(e));
		return { range, points: [], failed: true };
	}
}

/**
 * The credit-card wallets' 30-day spend (FN-25b) with each card's available credit and due chip (FN-55a); a
 * failure shows the section's own error line.
 */
async function loadCreditCards(
	db: App.Locals['db'],
	spaceId: string,
	wallets: readonly WalletLine[],
	today: string
) {
	try {
		const [spend, summaries] = await Promise.all([
			creditCardSpend(db, spaceId, wallets, today),
			cardSummaries(
				db,
				spaceId,
				wallets.filter((w) => w.type === 'kartu_kredit'),
				today
			)
		]);
		const byWallet = new Map(summaries.map((c) => [c.walletId, c]));
		const cards = spend.map((c) => ({
			...c,
			available: byWallet.get(c.walletId)?.available ?? null,
			due: byWallet.get(c.walletId)?.due ?? null
		}));
		return { cards, failed: false };
	} catch (e) {
		console.error('kekayaan: credit cards failed', errorLabel(e));
		return { cards: [], failed: true };
	}
}

/** The belongings total per currency, or null when it cannot be loaded (the row then says so). */
async function loadBelongings(db: App.Locals['db'], spaceId: string) {
	try {
		return { totals: await belongingsTotal(db, spaceId, wibTodayString()), failed: false };
	} catch (e) {
		console.error('kekayaan: belongings total failed', errorLabel(e));
		return { totals: [], failed: true };
	}
}

/** The collectibles total per currency, or failed when it cannot be loaded (the row then says so). */
async function loadCollectibles(db: App.Locals['db'], spaceId: string) {
	try {
		return { totals: await collectiblesTotal(db, spaceId), failed: false };
	} catch (e) {
		console.error('kekayaan: collectibles total failed', errorLabel(e));
		return { totals: [], failed: true };
	}
}

async function guarded(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const { scope } = await pageScope(event.locals);
	return { form, scope, db: event.locals.db };
}

export const actions: Actions = {
	/** FN-25: add a net-worth item. */
	createItem: async (event) => {
		const { form, scope, db } = await guarded(event);
		const parsed = parseNetWorthForm(form, event.locals.locale, await knownCoins());
		if (!parsed.ok)
			return fail(400, {
				nwAction: 'create' as const,
				nwErrors: parsed.errors,
				nwValues: parsed.values
			});
		const created = await createNetWorthItem(db, scope, parsed.value, Date.now());
		if (!created.ok)
			return created.reason === 'limit'
				? fail(409, { nwError: NW_LIMIT })
				: fail(404, { nwError: NW_NOT_FOUND });
		return { nwSaved: 'created' as const };
	},

	updateItem: async (event) => {
		const { form, scope, db } = await guarded(event);
		const id = itemId(form);
		const parsed = parseNetWorthForm(form, event.locals.locale, await knownCoins());
		if (!parsed.ok)
			return fail(400, {
				nwAction: 'update' as const,
				nwItemId: id,
				nwErrors: parsed.errors,
				nwValues: parsed.values
			});
		const result = await updateNetWorthItem(
			db,
			scope,
			id,
			parsed.value,
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return itemRefused(result);
		return { nwSaved: 'updated' as const };
	},

	deleteItem: async (event) => {
		const { form, scope, db } = await guarded(event);
		const result = await deleteNetWorthItem(
			db,
			scope,
			itemId(form),
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return itemRefused(result);
		return { nwSaved: 'deleted' as const };
	}
};
