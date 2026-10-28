import { fail, redirect } from '@sveltejs/kit';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { idField, readFormBody } from '#lib/server/forms';
import {
	GMAIL_AUTOSAVE_WALLET,
	GMAIL_RATE_LIMITED,
	GMAIL_SAVE_CATEGORY,
	GMAIL_REVIEW_LOAD_FAILED,
	GMAIL_SAVE_DUPLICATE,
	GMAIL_SAVE_LIMIT,
	GMAIL_SAVE_NONE,
	GMAIL_SAVE_STALE,
	GMAIL_SCAN_NOT_FOUND,
	GMAIL_UNDO_ALREADY
} from '#lib/server/gmail/messages';
import {
	listGmailCaptures,
	parseReviewCursor,
	reviewChoices,
	saveScanDrafts,
	undoGmailScan
} from '#lib/server/gmail/review';
import { errorLabel } from '#lib/server/util';
import { GMAIL_SCAN_ACTIONS_PER_WINDOW, GMAIL_UNDO_PER_WINDOW } from '#lib/shared/gmail/ledger';
import { gmailMessageUrl, groupReview } from '#lib/shared/gmail/review';
import type { Actions, PageServerLoad } from './$types';

// FN-19b "Transaksi dari Gmail" (docs/features/fn-19b-gmail-followups/PRD.md § C). Account-level like the Gmail
// page: the connection, its scans and captures are resolved from the SESSION user only (no space or connection id
// is taken from the client); rows come only from spaces the user is still a live member of. Another user's scan id
// answers exactly like a missing one (404).

function signedIn(locals: App.Locals) {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	return user;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = signedIn(locals);
	const cursor = parseReviewCursor(url.searchParams.get('setelah'));
	try {
		const [page, choices] = await Promise.all([
			listGmailCaptures(locals.db, user.id, cursor, Date.now()),
			reviewChoices(locals.db, user.id)
		]);
		const address = page.connection?.googleAddress ?? null;
		return {
			connected: page.connection !== null,
			days: groupReview(page.rows).map((day) => ({
				...day,
				scans: day.scans.map((g) => ({
					...g,
					rows: g.rows.map((r) => ({ ...r, gmailUrl: gmailMessageUrl(address, r.gmailId) }))
				}))
			})),
			nextCursor: page.nextCursor,
			paged: cursor !== null,
			wallets: choices.wallets,
			categories: choices.categories,
			loadError: null
		};
	} catch (e) {
		console.error('pengaturan/aplikasi/gmail/transaksi: load failed', errorLabel(e));
		return {
			connected: true,
			days: [],
			nextCursor: null,
			paged: cursor !== null,
			wallets: [],
			categories: [],
			loadError: GMAIL_REVIEW_LOAD_FAILED
		};
	}
};

export const actions: Actions = {
	/** "Urungkan pemindaian": exact counts on success; a second call answers "Sudah diurungkan". */
	undo: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const scanId = idField(form, 'scanId');
		if (
			await overUserAttemptLimit(
				locals.db,
				user.id,
				Date.now(),
				'gmail-undo',
				GMAIL_UNDO_PER_WINDOW
			)
		)
			return fail(429, { error: GMAIL_RATE_LIMITED, scanId });
		const result = scanId
			? await undoGmailScan(locals.db, user.id, scanId, Date.now())
			: ({ kind: 'missing' } as const);
		if (result.kind === 'missing') return fail(404, { error: GMAIL_SCAN_NOT_FOUND, scanId });
		if (result.kind === 'already') return fail(409, { error: GMAIL_UNDO_ALREADY, scanId });
		return {
			undone: {
				scanId,
				cancelled: result.drafts + result.transactions,
				skipped: result.skipped
			}
		};
	},

	/** "Simpan semua yang lengkap" (look-backs): FN-05's one save path; incomplete drafts stay and are counted. */
	saveAll: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const scanId = idField(form, 'scanId');
		if (
			await overUserAttemptLimit(
				locals.db,
				user.id,
				Date.now(),
				'gmail-scan',
				GMAIL_SCAN_ACTIONS_PER_WINDOW
			)
		)
			return fail(429, { error: GMAIL_RATE_LIMITED, scanId });
		const result = scanId
			? await saveScanDrafts(
					locals.db,
					user.id,
					scanId,
					{
						walletId: idField(form, 'walletId') || null,
						categoryId: idField(form, 'categoryId') || null
					},
					Date.now()
				)
			: ({ kind: 'missing' } as const);
		switch (result.kind) {
			case 'ok':
				return { savedAll: { scanId, saved: result.saved, incomplete: result.incomplete } };
			case 'missing':
				return fail(404, { error: GMAIL_SCAN_NOT_FOUND, scanId });
			case 'none':
				return fail(409, { error: GMAIL_SAVE_NONE, scanId });
			case 'limit':
				return fail(409, { error: GMAIL_SAVE_LIMIT, scanId });
			case 'duplicate':
				return fail(409, { error: GMAIL_SAVE_DUPLICATE, scanId });
			case 'wallet':
				return fail(400, { error: GMAIL_AUTOSAVE_WALLET, scanId });
			case 'category':
				return fail(400, { error: GMAIL_SAVE_CATEGORY, scanId });
			default:
				return fail(409, { error: GMAIL_SAVE_STALE, scanId });
		}
	}
};
