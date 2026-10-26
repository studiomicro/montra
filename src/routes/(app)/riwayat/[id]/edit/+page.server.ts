import { error, fail, redirect } from '@sveltejs/kit';
import { listCategoriesWithPresets } from '#lib/server/categories/repo';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { learnFromCorrection } from '#lib/server/merchants/learn';
import { resolveMerchants } from '#lib/server/merchants/resolve';
import { getSeries } from '#lib/server/recurring/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { adjustmentEditInput } from '#lib/server/transactions/adjustment';
import { readTransactionForm } from '#lib/server/transactions/form';
import {
	TRANSACTION_CHANGED,
	TRANSACTION_LINKED,
	TRANSACTION_NOT_FOUND
} from '#lib/server/transactions/messages';
import {
	deleteTransaction,
	getTransaction,
	updateTransaction,
	type TransactionUpdateResult
} from '#lib/server/transactions/repo';
import { setSavedNotice } from '#lib/server/transactions/saved-notice';
import { ID_MAX_LENGTH, parseAdjustmentEdit } from '#lib/server/transactions/validation';
import { listWallets } from '#lib/server/wallets/repo';
import { minorToAmountText } from '#lib/shared/amount-input';
import type { MerchantReason } from '#lib/shared/merchants/resolve';
import type { AdjustmentFormValues, TransactionFormValues } from '#lib/shared/transactions';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/** An `updated_at` (epoch ms) as the form carries it. */
const UPDATED_AT = /^\d{1,15}$/;

/** The route's id, cut so an over-long one costs the same lookup (and matches nothing). */
const routeId = (params: { id: string }) => (params.id.length > ID_MAX_LENGTH ? '' : params.id);

/** The `updated_at` the form was loaded with; -1 (matches nothing, so "changed meanwhile") when malformed. */
function expectedUpdatedAt(form: FormData): number {
	const value = textField(form, 'updatedAt');
	return UPDATED_AT.test(value) ? Number(value) : -1;
}

function refused(result: Exclude<TransactionUpdateResult, 'ok'>) {
	if (result === 'missing') return fail(404, { error: TRANSACTION_NOT_FOUND });
	return fail(409, { error: result === 'linked' ? TRANSACTION_LINKED : TRANSACTION_CHANGED });
}

/**
 * FN-48 AC-31/32: why a captured row has its category, recomputed now (deterministic layers only, never stored)
 * and shown only while the stored category is exactly what the resolver still picks for its title. A manual row,
 * a changed category or a failed lookup shows no reason.
 */
async function categoryReasonOf(
	locals: App.Locals,
	scope: Awaited<ReturnType<typeof currentSpaceScope>>,
	tx: { source: string; type: string; title: string | null; categoryId: string | null }
): Promise<MerchantReason | null> {
	if (tx.source === 'manual' || !tx.title || !tx.categoryId) return null;
	if (tx.type !== 'expense' && tx.type !== 'income') return null;
	try {
		const { items } = await resolveMerchants(
			locals.db,
			scope,
			[{ rawText: tx.title, type: tx.type }],
			{ userId: scope.userId, allowAi: false }
		);
		const [item] = items;
		return item && item.reason !== 'none' && item.categoryId === tx.categoryId ? item.reason : null;
	} catch (e) {
		console.error('riwayat/edit: reason lookup failed', e instanceof Error ? e.message : 'unknown');
		return null;
	}
}

export const load: PageServerLoad = async ({ locals, params }) => {
	const scope = await currentSpaceScope(locals);
	const { spaceId } = scope;
	const db = locals.db;
	const transaction = await getTransaction(db, spaceId, routeId(params));
	// Unknown, deleted and other-space ids get the one same answer.
	if (!transaction) error(404, 'Not found');
	const [categories, wallets, series, categoryReason] = await Promise.all([
		listCategoriesWithPresets(db, spaceId, { includeHidden: true }),
		listWallets(db, spaceId, { includeArchived: true }),
		// FN-36: the live series this row came from ("Ubah seri" links to it); this form edits the row only.
		transaction.recurringSeriesId ? getSeries(db, spaceId, transaction.recurringSeriesId) : null,
		categoryReasonOf(locals, scope, transaction)
	]);
	const used = new Set([transaction.walletId, transaction.transferToWalletId]);
	// A balance adjustment (FN-37) keeps its amount, direction and wallet: only title, note, date and time.
	const adjustment =
		transaction.type === 'adjustment'
			? {
					updatedAt: transaction.updatedAt,
					walletName: wallets.find((w) => w.id === transaction.walletId)?.name ?? '',
					signedMinor:
						transaction.adjustmentDirection === 'decrease'
							? -transaction.amountMinor
							: transaction.amountMinor,
					currency: transaction.currency
				}
			: null;
	const adjustmentValues: AdjustmentFormValues | null = adjustment
		? {
				walletId: transaction.walletId,
				balance: '',
				negative: false,
				title: transaction.title ?? '',
				note: transaction.note ?? '',
				occurredOn: transaction.occurredOn,
				occurredTime: ''
			}
		: null;
	const values: TransactionFormValues = {
		type: transaction.type,
		// Cents kept for a currency that has them (FN-47): saving unchanged keeps the exact amount.
		amount: minorToAmountText(transaction.amountMinor, transaction.currency, locals.locale),
		walletId: transaction.walletId,
		transferToWalletId: transaction.transferToWalletId ?? '',
		categoryId: transaction.categoryId ?? '',
		title: transaction.title ?? '',
		note: transaction.note ?? '',
		occurredOn: transaction.occurredOn,
		occurredTime: ''
	};
	return {
		transaction: {
			id: transaction.id,
			updatedAt: transaction.updatedAt,
			occurredAt: transaction.occurredAt,
			// FN-15: a kept receipt photo, served by /riwayat/<id>/foto.
			hasPhoto: transaction.hasPhoto
		},
		values,
		categoryReason,
		adjustment,
		adjustmentValues,
		seriesId: series?.id ?? null,
		// FN-49: the split this row is linked to, or whether it can become one's bill ("Buat patungan").
		patungan: transaction.patungan
			? {
					...transaction.patungan,
					amountMinor: transaction.amountMinor,
					currency: transaction.currency
				}
			: null,
		canSplit: transaction.type === 'expense' && !transaction.isDemo,
		// A hidden category or archived wallet this transaction already uses stays selectable for it.
		categories: categories.filter((c) => !c.isHidden || c.id === transaction.categoryId),
		wallets: wallets
			.filter((w) => !w.archived || used.has(w.id))
			.map(({ id, name, currency }) => ({ id, name, currency }))
	};
};

async function guarded(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const scope = await currentSpaceScope(event.locals);
	return { form, scope, db: event.locals.db, id: routeId(event.params) };
}

export const actions: Actions = {
	update: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const current = await getTransaction(db, scope.spaceId, id);
		if (!current) return fail(404, { error: TRANSACTION_NOT_FOUND });
		let input;
		if (current.type === 'adjustment') {
			// Whatever else the form sends, an adjustment keeps its amount, direction and wallet.
			const edit = parseAdjustmentEdit(form);
			if (!edit.ok) return fail(400, { errors: edit.errors, adjustmentValues: edit.values });
			input = adjustmentEditInput(current, edit.edit);
		} else {
			// The generic form never writes an adjustment (its type list has none): no type change into one.
			const read = await readTransactionForm(db, scope.spaceId, form, event.locals.locale, current);
			if (!read.ok) return fail(400, { errors: read.errors, values: read.values });
			input = read.input;
		}
		const result = await updateTransaction(
			db,
			scope,
			id,
			input,
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return refused(result);
		// FN-20 learning: a confirmed category change on an expense or income teaches the space (owner decision 4).
		const kind = input.type === 'expense' || input.type === 'income' ? input.type : null;
		if (kind && input.categoryId && input.title && input.categoryId !== current.categoryId)
			await learnFromCorrection(
				db,
				scope,
				{ descriptor: input.title, kind, categoryId: input.categoryId },
				Date.now()
			).catch((e: unknown) =>
				console.error('riwayat/edit: learning failed', e instanceof Error ? e.message : 'unknown')
			);
		setSavedNotice(event.cookies, event.locals.secure, 'updated');
		redirect(303, '/riwayat?saved=updated');
	},

	delete: async (event) => {
		const { form, scope, db, id } = await guarded(event);
		const result = await deleteTransaction(
			db,
			scope,
			id,
			expectedUpdatedAt(form),
			Date.now(),
			getEnv()
		);
		if (result !== 'ok') return refused(result);
		setSavedNotice(event.cookies, event.locals.secure, 'deleted');
		redirect(303, '/riwayat?saved=deleted');
	}
};
