import type { z } from 'zod';
import { daysBetween, isDateString, monthOf } from '#lib/shared/dates';
import { createTranslator } from '#lib/shared/i18n';
import { isClientId } from '#lib/shared/offline-queue';
import { parseRiwayatQuery, viewFilter } from '#lib/shared/riwayat-query';
import type { Db } from '../db';
import { getEnv } from '../env';
import type { SpaceScope } from '../spaces/access';
import {
	MAX_FILTER_DAYS,
	PAGE_SIZE,
	parseCursor,
	type TransactionFilter
} from '../transactions/aggregate';
import { createTransactionOnce } from '../transactions/client-id';
import { readTransactionForm } from '../transactions/form';
import {
	REFS_GONE,
	TRANSACTION_CHANGED,
	TRANSACTION_LIMIT,
	TRANSACTION_LINKED
} from '../transactions/messages';
import {
	deleteTransaction,
	getTransaction,
	updateTransaction,
	type TransactionDetail,
	type TransactionUpdateResult
} from '../transactions/repo';
import { ApiError, NOT_FOUND, validationError } from './http';
import type { CreateTransactionBody, transactionsQuery, UpdateTransactionBody } from './schemas';
import { detailOut } from './serialize';

/**
 * FN-38 transactions over the public API: the list reads Riwayat's own filter (`parseRiwayatQuery` +
 * `viewFilter`) and keyset pages; writes go through the compose form's validation (`readTransactionForm`, the
 * amount given exactly in minor units) and FN-02's `createTransactionOnce` / the edit form's
 * `updateTransaction` / `deleteTransaction`, so the API is not a second way to write a row.
 */

const en = createTranslator('en');

/** The list's filter and page: Riwayat's view of the same parameters, refused (400) where Riwayat would guess. */
export function listFilter(
	query: z.infer<typeof transactionsQuery>,
	today: string
): { filter: TransactionFilter; cursor: string | null; limit: number } {
	const bad = (name: string, message: string) =>
		new ApiError(400, 'invalid_request', message, { [name]: message });
	const limit = query.limit === undefined ? PAGE_SIZE : Number(query.limit);
	if (limit < 1 || limit > PAGE_SIZE) throw bad('limit', `Use a limit from 1 to ${PAGE_SIZE}.`);
	if (query.cursor !== undefined && !parseCursor(query.cursor))
		throw bad('cursor', 'Pass back a next_cursor value unchanged.');
	if ((query.from === undefined) !== (query.to === undefined))
		throw bad(query.from === undefined ? 'from' : 'to', 'Send from and to together.');
	const params = new URLSearchParams();
	if (query.type) params.set('type', query.type);
	if (query.category_id) params.set('category', query.category_id);
	if (query.wallet_id) params.set('wallet', query.wallet_id);
	if (query.q) params.set('q', query.q);
	if (query.from !== undefined && query.to !== undefined) {
		if (!isDateString(query.from)) throw bad('from', 'Use a real date (YYYY-MM-DD).');
		if (!isDateString(query.to)) throw bad('to', 'Use a real date (YYYY-MM-DD).');
		const span = daysBetween(query.from, query.to);
		if (span < 0) throw bad('to', 'to must not be before from.');
		if (span >= MAX_FILTER_DAYS)
			throw bad('to', `A period covers at most ${MAX_FILTER_DAYS} days.`);
		params.set('period', 'range');
		params.set('from', query.from);
		params.set('to', query.to);
	} else params.set('month', monthOf(today));
	const { view } = parseRiwayatQuery(params, today);
	return { filter: viewFilter(view), cursor: query.cursor ?? null, limit };
}

type FormFields = Record<
	| 'type'
	| 'walletId'
	| 'transferToWalletId'
	| 'categoryId'
	| 'title'
	| 'note'
	| 'occurredOn'
	| 'occurredTime',
	string
>;

function formOf(fields: FormFields): FormData {
	const form = new FormData();
	for (const [name, value] of Object.entries(fields)) form.append(name, value);
	return form;
}

/** The API's write result as its fixed answer (409 for every "nothing was written"). */
function writeRefusal(result: Exclude<TransactionUpdateResult, 'ok'>): ApiError {
	if (result === 'missing') return NOT_FOUND();
	if (result === 'linked') return new ApiError(409, 'linked', en.tr(TRANSACTION_LINKED));
	return new ApiError(409, 'stale', en.tr(TRANSACTION_CHANGED));
}

async function answerWith(db: Db, spaceId: string, id: string) {
	const row = await getTransaction(db, spaceId, id);
	if (!row) throw new ApiError(409, 'gone', 'This transaction was deleted.');
	return { data: detailOut(row) };
}

/** `POST /transactions`: one row per `client_id`; a resend answers the row the first attempt wrote. */
export async function createViaApi(
	db: Db,
	scope: SpaceScope,
	body: CreateTransactionBody,
	now: number
) {
	if (!isClientId(body.client_id))
		throw new ApiError(400, 'validation_failed', 'client_id must be a lowercase UUID.', {
			client_id: 'client_id must be a lowercase UUID.'
		});
	const form = formOf({
		type: body.type,
		walletId: body.wallet_id,
		transferToWalletId: body.transfer_to_wallet_id ?? '',
		categoryId: body.category_id ?? '',
		title: body.title ?? '',
		note: body.note ?? '',
		occurredOn: body.occurred_on,
		occurredTime: body.occurred_time ?? ''
	});
	// The amount is exact minor units, never text: the locale reads nothing here.
	const read = await readTransactionForm(db, scope.spaceId, form, 'en', null, body.amount_minor);
	if (!read.ok) throw validationError(read.errors);
	const created = await createTransactionOnce(db, scope, body.client_id, read.input, now);
	if (!created.ok)
		throw created.reason === 'limit'
			? new ApiError(409, 'limit_reached', en.tr(TRANSACTION_LIMIT))
			: new ApiError(409, 'gone', en.tr(REFS_GONE));
	return answerWith(db, scope.spaceId, created.id);
}

/** A row the API may change: live in the space, and not a balance adjustment (changed in the app only). */
async function editable(db: Db, spaceId: string, id: string): Promise<TransactionDetail> {
	const current = await getTransaction(db, spaceId, id.slice(0, 65));
	if (!current) throw NOT_FOUND();
	if (current.type === 'adjustment')
		throw new ApiError(
			400,
			'invalid_request',
			'Balance adjustments can only be changed in the app.'
		);
	return current;
}

/** Keeps `current` where the body leaves a field out (undefined); null clears an optional field. */
const pick = (value: string | null | undefined, current: string | null) =>
	value === undefined ? (current ?? '') : (value ?? '');

/** `PATCH /transactions/{id}`: the edit form's checks and stale rule; fields left out keep their value. */
export async function updateViaApi(
	db: Db,
	scope: SpaceScope,
	id: string,
	body: UpdateTransactionBody,
	now: number
) {
	const current = await editable(db, scope.spaceId, id);
	const form = formOf({
		type: body.type ?? current.type,
		walletId: body.wallet_id ?? current.walletId,
		transferToWalletId: pick(body.transfer_to_wallet_id, current.transferToWalletId),
		categoryId: pick(body.category_id, current.categoryId),
		title: pick(body.title, current.title),
		note: pick(body.note, current.note),
		occurredOn: body.occurred_on ?? current.occurredOn,
		// Without a time the stored instant is kept (the edit form's rule).
		occurredTime: body.occurred_time ?? ''
	});
	const amount = body.amount_minor ?? current.amountMinor;
	const read = await readTransactionForm(db, scope.spaceId, form, 'en', current, amount);
	if (!read.ok) throw validationError(read.errors);
	const result = await updateTransaction(
		db,
		scope,
		current.id,
		read.input,
		body.expected_updated_at,
		now
	);
	if (result !== 'ok') throw writeRefusal(result);
	return answerWith(db, scope.spaceId, current.id);
}

/** `DELETE /transactions/{id}`: a tombstone, only while `expected_updated_at` still holds. */
export async function deleteViaApi(
	db: Db,
	scope: SpaceScope,
	id: string,
	expectedUpdatedAt: number,
	now: number
) {
	const current = await editable(db, scope.spaceId, id);
	const result = await deleteTransaction(db, scope, current.id, expectedUpdatedAt, now, getEnv());
	if (result !== 'ok') throw writeRefusal(result);
	return { data: { id: current.id, deleted: true as const } };
}
