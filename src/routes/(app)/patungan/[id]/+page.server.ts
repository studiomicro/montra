import { error, fail, redirect } from '@sveltejs/kit';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { readFormBody, expectedUpdatedAt, boundedId, idField } from '#lib/server/forms';
import {
	ALREADY_LINKED,
	BILL_UNAVAILABLE,
	PAYER_ONLY,
	SPLIT_CHANGED,
	SPLIT_NOT_FOUND
} from '#lib/server/patungan/messages';
import {
	billCandidates,
	createOwnShare,
	deleteSplit,
	getSplit,
	linkSplit,
	setParticipantPaid,
	unlinkSplit
} from '#lib/server/patungan/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { overTransactionCreateLimit } from '#lib/server/transactions/create-limit';
import {
	CATEGORY_REQUIRED,
	REFS_GONE,
	TRANSACTION_LIMIT,
	TRANSACTION_RATE_LIMITED,
	WALLET_REQUIRED
} from '#lib/server/transactions/messages';
import {
	setSplitSavedNotice,
	takeSplitSavedNotice,
	type SplitSavedKind
} from '#lib/server/transactions/saved-notice';
import { getWallet, listWallets } from '#lib/server/wallets/repo';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// FN-49: one split. Any live member of the space can see it (FN-03: space data is shared); only its payer
// (`created_by_user_id`) can settle, link or unlink, record their share, edit or delete it — each repo write
// repeats that rule inside its own statement, so a hidden button is never the guard.
export const load: PageServerLoad = async ({ locals, params, url, cookies }) => {
	const scope = await currentSpaceScope(locals);
	const { spaceId, userId } = scope;
	const db = locals.db;
	const split = await getSplit(db, spaceId, boundedId(params.id));
	// Unknown, deleted and other-space ids get the one same answer.
	if (!split) error(404, 'Not found');
	const saved = takeSplitSavedNotice(cookies, locals.secure, url.searchParams.get('saved'));
	const isPayer = split.createdByUserId === userId;
	// What the payer can link or record while no transaction is linked (the "no bill row" state).
	const unlinked = isPayer && !split.linked && !split.isDemo;
	if (unlinked) await ensurePresetCategories(db, spaceId);
	const [candidates, wallets, categories] = unlinked
		? await Promise.all([
				billCandidates(db, spaceId, {
					amountMinor: split.totalAmountMinor,
					currency: split.currency
				}),
				listWallets(db, spaceId),
				listCategories(db, spaceId)
			])
		: [[], [], []];
	return {
		split,
		isPayer,
		// Owner decision (red team L2): once the payer is no longer a member, the Pemilik may unlink or delete it.
		canRescue: !isPayer && !split.isDemo && !split.payerIsMember && locals.space?.role === 'owner',
		viewerId: userId,
		saved,
		candidates,
		wallets: wallets
			.filter((w) => w.currency === split.currency)
			.map(({ id, name, currency }) => ({ id, name, currency })),
		categories: categories
			.filter((c) => c.kind === 'expense')
			.map(({ id, name, tileKey, isPreset }) => ({ id, name, tileKey, isPreset }))
	};
};

async function guarded(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const scope = await currentSpaceScope(event.locals);
	return { form, scope, db: event.locals.db, id: boundedId(event.params.id) };
}

/** A confirmed write: the one-shot notice first, then the redirect that carries `?saved=`. */
function saved(event: RequestEvent, kind: SplitSavedKind): never {
	setSplitSavedNotice(event.cookies, event.locals.secure, kind);
	redirect(
		303,
		kind === 'deleted' ? '/patungan?saved=deleted' : `/patungan/${event.params.id}?saved=${kind}`
	);
}

function refused(
	result: 'missing' | 'forbidden' | 'stale' | 'locked' | 'bill' | 'gone' | 'already'
) {
	if (result === 'missing') return fail(404, { error: SPLIT_NOT_FOUND });
	if (result === 'forbidden') return fail(403, { error: PAYER_ONLY });
	if (result === 'stale') return fail(409, { error: SPLIT_CHANGED });
	if (result === 'already') return fail(409, { error: ALREADY_LINKED });
	if (result === 'bill') return fail(409, { error: BILL_UNAVAILABLE });
	return fail(409, { error: REFS_GONE });
}

async function paid(event: RequestEvent, value: boolean) {
	const { form, scope, db, id } = await guarded(event);
	const participant = idField(form, 'participant');
	const result = await setParticipantPaid(db, scope, id, participant, value, Date.now());
	if (result !== 'ok') return refused(result);
	saved(event, value ? 'settled' : 'unsettled');
}

export const actions: Actions = {
	/** "Tandai lunas": idempotent, never touches a transaction or a total. */
	settle: (event) => paid(event, true),

	/** "Batalkan lunas" (a mistaken tap). */
	unsettle: (event) => paid(event, false),

	/** "Lepas tautan": the transaction counts in full again from the next read. */
	unlink: async (event) => {
		const { scope, db, id } = await guarded(event);
		const result = await unlinkSplit(db, scope, id, Date.now());
		if (result !== 'ok') return refused(result);
		saved(event, 'unlinked');
	},

	/** "Tautkan transaksi": an existing expense of exactly the split's total and currency. */
	link: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const transactionId = idField(form, 'transaction');
		const result = await linkSplit(db, scope, id, transactionId, Date.now());
		if (result !== 'ok') return refused(result);
		saved(event, 'linked');
	},

	/** "Buat transaksi untuk bagianmu": a new expense of the payer's share, linked. */
	ownShare: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const split = await getSplit(db, scope.spaceId, id);
		// A Data demo split is never written (red team L1): the same answer as a missing one.
		if (!split || split.isDemo) return fail(404, { error: SPLIT_NOT_FOUND });
		if (split.createdByUserId !== scope.userId) return fail(403, { error: PAYER_ONLY });
		const walletId = idField(form, 'walletId');
		const categoryId = idField(form, 'categoryId');
		const [wallet, categories] = await Promise.all([
			walletId ? getWallet(db, scope.spaceId, walletId) : null,
			listCategories(db, scope.spaceId)
		]);
		const errors: Record<string, string> = {};
		if (!wallet || wallet.currency !== split.currency) errors.walletId = WALLET_REQUIRED;
		if (!categories.some((c) => c.id === categoryId && c.kind === 'expense'))
			errors.categoryId = CATEGORY_REQUIRED;
		if (Object.keys(errors).length > 0) return fail(400, { errors });
		const now = Date.now();
		if (await overTransactionCreateLimit(db, scope.userId, now))
			return fail(429, { error: TRANSACTION_RATE_LIMITED });
		const result = await createOwnShare(
			db,
			scope,
			split,
			{ transactionId: crypto.randomUUID(), walletId, categoryId },
			now
		);
		if (result === 'limit') return fail(409, { error: TRANSACTION_LIMIT });
		if (result !== 'ok') return refused(result);
		saved(event, 'linked');
	},

	/** "Hapus": the split and its people become tombstones; a linked transaction is unlinked, never deleted. */
	delete: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const result = await deleteSplit(db, scope, id, expectedUpdatedAt(form), Date.now());
		if (result !== 'ok') return refused(result);
		saved(event, 'deleted');
	}
};
