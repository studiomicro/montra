import { fail } from '@sveltejs/kit';
import { cardSummaries } from '#lib/server/cards/summary';
import { readFormBody, textField } from '#lib/server/forms';
import { errorLabel } from '#lib/server/util';
import { GOAL_LIMIT, GOAL_NOT_FOUND, GOALS_LOAD_FAILED } from '#lib/server/goals/messages';
import { goalsSetAside } from '#lib/server/goals/progress';
import { createGoal, listGoals } from '#lib/server/goals/repo';
import { parseGoalForm } from '#lib/server/goals/validation';
import { currentSpaceAccess } from '#lib/server/spaces/current';
import { balanceTotals, shownBalance } from '#lib/server/wallets/balance';
import { walletHasTransactions } from '#lib/server/transactions/repo';
import { walletTransactionsSums } from '#lib/server/transactions/wallet-sum';
import {
	BANK_STATEMENTS_TYPE_LOCKED,
	CARD_TYPE_LOCKED,
	CURRENCY_LOCKED,
	LOAD_FAILED,
	WALLET_CHANGED,
	WALLET_LIMIT,
	WALLET_NOT_FOUND
} from '#lib/server/wallets/messages';
import {
	archiveWallet,
	createWallet,
	getWallet,
	listWallets,
	restoreWallet,
	setFavourite,
	updateWallet,
	walletHasCardStatements,
	type WalletWriteResult
} from '#lib/server/wallets/repo';
import { parseWalletForm, walletFormValues } from '#lib/server/wallets/validation';
import { wibTodayString } from '#lib/shared/dates';
import { emoneyQuickPick, walletQuickPick } from '#lib/shared/wallets';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// Dompet (APP_PARITY § 3: wallets and goals; FN-04 and FN-10) works on the session's current space (locals.space,
// already a re-validated membership). Every load and action still passes it through requireSpaceAccess with
// locals.user, so there is one access rule; a wallet id from the form is only ever looked up inside that space,
// so another space's id and an unknown id get the same answer.

/** Longest wallet id read from a form; ids are UUIDs, anything longer cannot match. */
const WALLET_ID_MAX_LENGTH = 64;
/** An `updated_at` (epoch ms) as the form carries it. */
const UPDATED_AT = /^\d{1,15}$/;

function walletId(form: FormData): string {
	const id = textField(form, 'walletId');
	return id.length > WALLET_ID_MAX_LENGTH ? '' : id;
}

/** The `updated_at` the form was loaded with; -1 (matches nothing, so "changed meanwhile") when malformed. */
function expectedUpdatedAt(form: FormData): number {
	const value = textField(form, 'updatedAt');
	return UPDATED_AT.test(value) ? Number(value) : -1;
}

function refused(result: Exclude<WalletWriteResult, 'ok'>) {
	if (result === 'card_locked') return fail(409, { error: CARD_TYPE_LOCKED });
	if (result === 'bank_statements_locked') return fail(409, { error: BANK_STATEMENTS_TYPE_LOCKED });
	return result === 'missing'
		? fail(404, { error: WALLET_NOT_FOUND })
		: fail(409, { error: WALLET_CHANGED });
}

async function loadGoals(db: App.Locals['db'], spaceId: string, includeArchived: boolean) {
	try {
		const goals = await listGoals(db, spaceId, { includeArchived });
		return { goals, setAside: goalsSetAside(goals), goalsError: null };
	} catch (e) {
		console.error('dompet: goal list failed', errorLabel(e));
		return { goals: [], setAside: [], goalsError: GOALS_LOAD_FAILED };
	}
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const { scope, space } = await currentSpaceAccess(locals);
	// The space's own name only for a shared space; a personal space is labelled by the page.
	const spaceLabel = { kind: space.kind, name: space.kind === 'shared' ? space.name : '' };
	const showArchived = url.searchParams.get('arsip') === '1';
	// `?tambah=1` / `?ubah=<id>` open the wallet form and `?target=baru` the goal form without JavaScript (a
	// sheet does it with JavaScript).
	const editId = url.searchParams.get('ubah')?.slice(0, WALLET_ID_MAX_LENGTH) ?? null;
	const open = url.searchParams.get('tambah') === '1' ? 'add' : editId;
	// `&jenis=kartu_kredit` (the card page's "Tambah kartu"): the new wallet starts as a card, without JavaScript too.
	const addCard = open === 'add' && url.searchParams.get('jenis') === 'kartu_kredit';
	// `&dompet=<id>`: an FN-39 quick pick (GoPay, OVO, …) prefilling the new wallet; anything else is ignored.
	const quickPick =
		open === 'add' ? (walletQuickPick(url.searchParams.get('dompet'))?.id ?? null) : null;
	// `&kartu=<issuer>`: an FN-58 e-money card quick pick (BCA Flazz, KMT, …); anything else is ignored.
	const emoneyPick =
		open === 'add' ? (emoneyQuickPick(url.searchParams.get('kartu'))?.issuer ?? null) : null;
	const openGoal = url.searchParams.get('target') === 'baru';
	// The goals (FN-10) and the wallets load side by side, each on its own: a failure in one leaves the other
	// untouched.
	const [goalsSection, walletSection] = await Promise.all([
		loadGoals(locals.db, scope.spaceId, showArchived),
		loadWallets(locals.db, scope.spaceId, showArchived)
	]);
	const base = { space: spaceLabel, showArchived, openGoal, ...goalsSection };
	if (!walletSection)
		return {
			...base,
			wallets: [],
			cards: [],
			totals: [],
			heroCurrency: 'IDR',
			loadError: LOAD_FAILED,
			open: null,
			quickPick: null,
			emoneyPick: null,
			addCard: false
		};
	return { ...base, ...walletSection, loadError: null, open, quickPick, emoneyPick, addCard };
};

/** The wallets with their balances, the live cards' summaries and the totals; null when they cannot be loaded. */
async function loadWallets(db: App.Locals['db'], spaceId: string, showArchived: boolean) {
	try {
		const [rows, sums] = await Promise.all([
			listWallets(db, spaceId, { includeArchived: showArchived }),
			walletTransactionsSums(db, spaceId)
		]);
		const wallets = rows.map((w) => ({ ...w, balanceMinor: shownBalance(w, sums.get(w.id)) }));
		const live = wallets.filter((w) => !w.archived);
		const heroCurrency = live.find((w) => w.isFavourite)?.currency ?? 'IDR';
		// FN-55a: a live card's owed amount, available credit and due chip (computed, never typed).
		const cards = await cardSummaries(
			db,
			spaceId,
			live.filter((w) => w.type === 'kartu_kredit'),
			wibTodayString()
		);
		return { wallets, cards, totals: balanceTotals(live, heroCurrency), heroCurrency };
	} catch (e) {
		console.error('dompet: wallet list failed', errorLabel(e));
		return null;
	}
}

async function guarded(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const { scope } = await currentSpaceAccess(event.locals);
	return { form, scope, db: event.locals.db };
}

export const actions: Actions = {
	createWallet: async (event) => {
		const { form, scope, db } = await guarded(event);
		const parsed = parseWalletForm(form, event.locals.locale);
		if (!parsed.ok)
			return fail(400, { action: 'create', errors: parsed.errors, values: parsed.values });
		const created = await createWallet(db, scope, parsed.value, Date.now());
		if (!created.ok)
			return created.reason === 'limit'
				? fail(409, { error: WALLET_LIMIT })
				: fail(404, { error: WALLET_NOT_FOUND });
		return { saved: 'created' as const };
	},

	updateWallet: async (event) => {
		const { form, scope, db } = await guarded(event);
		const id = walletId(form);
		const parsed = parseWalletForm(form, event.locals.locale);
		if (!parsed.ok)
			return fail(400, {
				action: 'update',
				walletId: id,
				errors: parsed.errors,
				values: parsed.values
			});
		// FN-55a: imported card statements need a card wallet (the write repeats the check in its guard).
		if (
			parsed.value.type !== 'kartu_kredit' &&
			(await walletHasCardStatements(db, scope.spaceId, id))
		)
			return fail(409, { error: CARD_TYPE_LOCKED });
		// A wallet's transactions are in its currency (FN-05): the code is fixed once it has any.
		const current = await getWallet(db, scope.spaceId, id);
		if (
			current &&
			current.currency !== parsed.value.currency &&
			(await walletHasTransactions(db, scope.spaceId, id))
		)
			return fail(400, {
				action: 'update',
				walletId: id,
				errors: { currency: CURRENCY_LOCKED },
				values: walletFormValues(form)
			});
		const result = await updateWallet(
			db,
			scope,
			id,
			parsed.value,
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return refused(result);
		return { saved: 'updated' as const };
	},

	archiveWallet: async (event) => {
		const { form, scope, db } = await guarded(event);
		const result = await archiveWallet(
			db,
			scope,
			walletId(form),
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return refused(result);
		return { saved: 'archived' as const };
	},

	restoreWallet: async (event) => {
		const { form, scope, db } = await guarded(event);
		const result = await restoreWallet(
			db,
			scope,
			walletId(form),
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return refused(result);
		return { saved: 'restored' as const };
	},

	setFavourite: async (event) => {
		const { form, scope, db } = await guarded(event);
		const result = await setFavourite(db, scope, walletId(form), Date.now());
		if (result !== 'ok') return refused(result);
		return { saved: 'favourite' as const };
	},

	/** FN-10: a new savings goal (the goal's own page, /kekayaan/tabungan/[id], holds every other goal action). */
	createGoal: async (event) => {
		const { form, scope, db } = await guarded(event);
		const parsed = parseGoalForm(form);
		if (!parsed.ok)
			return fail(400, {
				goalAction: 'create' as const,
				goalErrors: parsed.errors,
				goalValues: parsed.values
			});
		const created = await createGoal(db, scope, parsed.value, Date.now());
		if (!created.ok)
			return created.reason === 'limit'
				? fail(409, { goalError: GOAL_LIMIT })
				: fail(404, { goalError: GOAL_NOT_FOUND });
		return { goalSaved: 'created' as const };
	}
};
