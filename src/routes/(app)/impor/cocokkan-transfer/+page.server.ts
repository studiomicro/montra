import { fail } from '@sveltejs/kit';
import { readFormBody, expectedUpdatedAt, idField } from '#lib/server/forms';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { TRANSACTION_CHANGED } from '#lib/server/transactions/messages';
import {
	applyTransferMatch,
	listTransferLinks,
	MATCH_PREVIEW_MAX,
	proposeTransferMatches,
	undoTransferMatch,
	type TransferLinkCursor
} from '#lib/server/transfers/match';
import {
	TRANSFER_ALREADY_MERGED,
	TRANSFER_ALREADY_UNDONE,
	TRANSFER_LINK_NOT_FOUND,
	TRANSFER_MATCH_LOAD_FAILED,
	TRANSFER_PAIR_NOT_FOUND,
	TRANSFER_PAIR_REQUIRED
} from '#lib/server/transfers/messages';
import { errorLabel } from '#lib/server/util';
import { listWallets } from '#lib/server/wallets/repo';
import type { Actions, PageServerLoad } from './$types';

/** `?sebelum=<createdAt>.<id>`: the links page below that link (QA low: older links stay reachable to undo). */
const LINKS_CURSOR = /^(\d{1,15})\.([^.]{1,64})$/;

function linksCursor(url: URL): TransferLinkCursor | null {
	const m = LINKS_CURSOR.exec(url.searchParams.get('sebelum') ?? '');
	return m ? { createdAt: Number(m[1]), id: m[2]! } : null;
}

/**
 * FN-48 Part C "Cocokkan transfer" (sub-view of /impor). Every load and action re-checks the membership through
 * `currentSpaceScope`; the write statements repeat `isLiveMember` (transfers/match.ts). The review is computed on
 * the server; a form sends the two row ids and their versions only — one pair per confirm, never a batch.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	const scope = await currentSpaceScope(locals);
	const db = locals.db;
	const before = linksCursor(url);
	try {
		const [preview, page, wallets] = await Promise.all([
			proposeTransferMatches(db, scope.spaceId),
			listTransferLinks(db, scope.spaceId, before),
			listWallets(db, scope.spaceId, { includeArchived: true })
		]);
		return {
			preview,
			links: page.links,
			linksOlder: page.next ? `${page.next.createdAt}.${page.next.id}` : null,
			linksPaged: before !== null,
			max: MATCH_PREVIEW_MAX,
			wallets: wallets.map(({ id, name }) => ({ id, name })),
			loadError: null
		};
	} catch (e) {
		console.error('cocokkan-transfer: load failed', errorLabel(e));
		return {
			preview: null,
			links: [],
			linksOlder: null,
			linksPaged: before !== null,
			max: MATCH_PREVIEW_MAX,
			wallets: [],
			loadError: TRANSFER_MATCH_LOAD_FAILED
		};
	}
};

export const actions: Actions = {
	merge: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const debitId = idField(form, 'debitId');
		const creditId = idField(form, 'creditId');
		if (debitId === '' || creditId === '') return fail(400, { error: TRANSFER_PAIR_REQUIRED });
		const result = await applyTransferMatch(
			event.locals.db,
			scope,
			{
				debitId,
				creditId,
				debitUpdatedAt: expectedUpdatedAt(form, 'debitUpdatedAt'),
				creditUpdatedAt: expectedUpdatedAt(form, 'creditUpdatedAt')
			},
			Date.now()
		);
		if (result.status === 'already')
			return { done: 'already' as const, message: TRANSFER_ALREADY_MERGED };
		if (result.status === 'stale') return fail(409, { error: TRANSACTION_CHANGED });
		if (result.status === 'missing') return fail(404, { error: TRANSFER_PAIR_NOT_FOUND });
		return { done: 'merged' as const };
	},

	undo: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const result = await undoTransferMatch(event.locals.db, scope, idField(form, 'id'), Date.now());
		if (result === 'missing') return fail(404, { error: TRANSFER_LINK_NOT_FOUND });
		if (result === 'stale') return fail(409, { error: TRANSACTION_CHANGED });
		if (result === 'already') return { done: 'already' as const, message: TRANSFER_ALREADY_UNDONE };
		return { done: 'undone' as const };
	}
};
