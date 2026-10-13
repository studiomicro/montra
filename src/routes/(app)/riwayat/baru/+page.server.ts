import { fail, redirect } from '@sveltejs/kit';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { PHOTO_TOO_LARGE, PHOTO_UPLOAD_FAILED } from '#lib/server/photos/messages';
import { cleanUpFiles } from '#lib/server/photos/store';
import { readPhotoField, readPhotoForm, uploadPhoto } from '#lib/server/photos/upload';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { createBalanceAdjustment } from '#lib/server/transactions/adjustment';
import { createTransactionOnce } from '#lib/server/transactions/client-id';
import { overTransactionCreateLimit } from '#lib/server/transactions/create-limit';
import { readTransactionForm } from '#lib/server/transactions/form';
import {
	REFS_GONE,
	TRANSACTION_LIMIT,
	TRANSACTION_RATE_LIMITED,
	TRANSACTIONS_LOAD_FAILED
} from '#lib/server/transactions/messages';
import { createTransaction, holdsPhoto } from '#lib/server/transactions/repo';
import { setSavedNotice } from '#lib/server/transactions/saved-notice';
import { parseAdjustmentForm, transactionFormValues } from '#lib/server/transactions/validation';
import { walletTransactionsSums } from '#lib/server/transactions/wallet-sum';
import { shownBalance } from '#lib/server/wallets/balance';
import { listWallets } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { isClientId } from '#lib/shared/offline-queue';
import type { AdjustmentFormValues, TransactionFormValues } from '#lib/shared/transactions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const type = url.searchParams.get('type');
	const adjustment = type === 'adjustment';
	try {
		await ensurePresetCategories(locals.db, spaceId);
		const [categories, wallets, sums] = await Promise.all([
			adjustment ? [] : listCategories(locals.db, spaceId),
			listWallets(locals.db, spaceId),
			// Only a hint next to "Saldo baru": the action reads the balance again when the form is sent.
			adjustment ? walletTransactionsSums(locals.db, spaceId) : null
		]);
		// `?wallet=<id>` (Dompet's "Sesuaikan saldo") picks the wallet when it is a live wallet of this space;
		// otherwise the favourite wallet, listed first (wallets/repo.ts), is the default.
		const asked = wallets.find((w) => w.id === url.searchParams.get('wallet'));
		const walletId = asked?.id ?? wallets[0]?.id ?? '';
		const today = wibTodayString();
		const values: TransactionFormValues = {
			type: type === 'income' || type === 'transfer' ? type : 'expense',
			amount: '',
			walletId,
			transferToWalletId: '',
			categoryId: '',
			title: '',
			note: '',
			occurredOn: today,
			occurredTime: ''
		};
		const adjustmentValues: AdjustmentFormValues | null = adjustment
			? {
					walletId,
					balance: '',
					negative: false,
					title: '',
					note: '',
					occurredOn: today,
					occurredTime: ''
				}
			: null;
		return {
			values,
			adjustmentValues,
			categories,
			wallets: wallets.map((w) => ({
				id: w.id,
				name: w.name,
				currency: w.currency,
				balanceMinor: sums ? shownBalance(w, sums.get(w.id)) : null
			})),
			loadError: null
		};
	} catch (e) {
		console.error('riwayat/baru: load failed', e);
		return {
			values: null,
			adjustmentValues: null,
			categories: [],
			wallets: [],
			loadError: TRANSACTIONS_LOAD_FAILED
		};
	}
};

export const actions: Actions = {
	create: async (event) => {
		// FN-15 "Lampirkan fotonya saja": a multipart form may carry the receipt photo and is read within the photo
		// bounds; a plain form keeps the 8 KiB cap and its timing.
		const multipart = (event.request.headers.get('content-type') ?? '')
			.toLowerCase()
			.startsWith('multipart/form-data');
		// The photo-sized read only after the access check (photos/upload.ts); a plain form as before.
		const plain = multipart ? null : await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const form = plain ?? (await readPhotoForm(event.request));
		if (!form) return fail(413, { error: PHOTO_TOO_LARGE });
		const db = event.locals.db;
		const read = await readTransactionForm(db, scope.spaceId, form, event.locals.locale);
		if (!read.ok) return fail(400, { errors: read.errors, values: read.values });
		const photo = await readPhotoField(form, 'photo');
		if (photo.kind === 'refused')
			return fail(400, { error: photo.message, values: transactionFormValues(form) });
		const now = Date.now();
		if (await overTransactionCreateLimit(db, scope.userId, now))
			return fail(429, { error: TRANSACTION_RATE_LIMITED, values: transactionFormValues(form) });
		const env = getEnv();
		const stored =
			photo.kind === 'image'
				? await uploadPhoto(env, db, scope.spaceId, 'receipts', photo.image, now)
				: null;
		if (photo.kind === 'image' && !stored)
			return fail(503, { error: PHOTO_UPLOAD_FAILED, values: transactionFormValues(form) });
		// FN-02: with JavaScript the form carries a device-minted id, so the same submission sent again (after an
		// unanswered first attempt, or from the offline queue) writes one row. Without it, a fresh id as before.
		const clientId = textField(form, 'clientId');
		const created = isClientId(clientId)
			? await createTransactionOnce(db, scope, clientId, read.input, now, stored)
			: await createTransaction(
					db,
					scope,
					read.input,
					now,
					undefined,
					undefined,
					undefined,
					stored
				);
		// The membership, wallet or category went between the check and the write: nothing was written.
		// Refused, or an existing row answered the clientId (a resend, or another member's id: red team L1): the
		// upload is attached to nothing, so it is deleted now rather than left for the sweep.
		if (stored && !(created.ok && (await holdsPhoto(db, scope.spaceId, created.id, stored.key))))
			await cleanUpFiles(env, db, [stored.key], now);
		if (!created.ok)
			return fail(409, { error: created.reason === 'limit' ? TRANSACTION_LIMIT : REFS_GONE });
		setSavedNotice(event.cookies, event.locals.secure, 'created');
		redirect(303, '/riwayat?saved=created');
	},

	/** "Penyesuaian saldo" (FN-37): the wallet's balance is read again here, never taken from the page. */
	adjust: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const parsed = parseAdjustmentForm(form, event.locals.locale);
		if (!parsed.ok)
			return fail(400, { adjustmentErrors: parsed.errors, adjustmentValues: parsed.values });
		const now = Date.now();
		if (await overTransactionCreateLimit(event.locals.db, scope.userId, now))
			return fail(429, {
				adjustmentErrors: {},
				adjustmentValues: parsed.values,
				error: TRANSACTION_RATE_LIMITED
			});
		const result = await createBalanceAdjustment(event.locals.db, scope, parsed.draft, now);
		if (!result.ok)
			return fail(result.status, {
				adjustmentErrors: result.errors ?? {},
				adjustmentValues: parsed.values,
				error: result.error
			});
		setSavedNotice(event.cookies, event.locals.secure, 'adjusted');
		redirect(303, '/riwayat?saved=adjusted');
	}
};
