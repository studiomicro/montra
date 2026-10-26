import { fail, redirect } from '@sveltejs/kit';
import { listCategories, listCategoriesWithPresets } from '#lib/server/categories/repo';
import { boundedId, idField, readFormBody, textField } from '#lib/server/forms';
import { readSplitForm, type SplitFormErrors } from '#lib/server/patungan/form';
import { BILL_UNAVAILABLE, SPLIT_LIMIT, SPLITS_LOAD_FAILED } from '#lib/server/patungan/messages';
import {
	billCandidate,
	billCandidates,
	createSplit,
	getSplit,
	spaceMemberNames
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
import { setSplitSavedNotice } from '#lib/server/transactions/saved-notice';
import { getWallet, listWallets } from '#lib/server/wallets/repo';
import { minorToAmountText } from '#lib/shared/amount-input';
import { wibTodayString } from '#lib/shared/dates';
import { isClientId } from '#lib/shared/offline-queue';
import type { PatunganFormValues } from '#lib/shared/patungan';
import type { Actions, PageServerLoad } from './$types';

// FN-49 "Patungan baru". `?dariTransaksi=<id>` (Riwayat's "Buat patungan", or the picker below) links that
// expense as the bill: its title, total, currency and date are taken from it and the total is fixed. Without it,
// the payer's own share is written as a new expense from the chosen wallet (owner decision 1).
export const load: PageServerLoad = async ({ locals, url }) => {
	const scope = await currentSpaceScope(locals);
	const { spaceId } = scope;
	const db = locals.db;
	const today = wibTodayString();
	const asked = boundedId(url.searchParams.get('dariTransaksi') ?? '');
	try {
		const [bill, candidates, members, wallets, categories] = await Promise.all([
			asked ? billCandidate(db, spaceId, asked) : null,
			billCandidates(db, spaceId),
			spaceMemberNames(db, spaceId),
			listWallets(db, spaceId),
			listCategoriesWithPresets(db, spaceId)
		]);
		const values: PatunganFormValues = {
			title: bill?.title ?? '',
			occurredOn: bill?.occurredOn ?? today,
			note: '',
			mode: 'equal',
			amount: bill ? minorToAmountText(bill.amountMinor, bill.currency, locals.locale) : '',
			payerShare: '',
			members: [],
			memberShares: {},
			guests: [],
			walletId: wallets[0]?.id ?? '',
			categoryId: ''
		};
		return {
			clientId: crypto.randomUUID(),
			bill,
			// The asked-for row cannot be a bill (another space's, deleted, not an expense, already linked).
			billRefused: asked !== '' && !bill,
			candidates,
			members: members.filter((m) => m.userId !== scope.userId),
			wallets: wallets.map(({ id, name, currency }) => ({ id, name, currency })),
			categories: categories
				.filter((c) => c.kind === 'expense')
				.map(({ id, name, tileKey, isPreset }) => ({ id, name, tileKey, isPreset })),
			values,
			loadError: null
		};
	} catch (e) {
		console.error('patungan/baru: load failed', e instanceof Error ? e.name : 'unknown');
		return {
			clientId: crypto.randomUUID(),
			bill: null,
			billRefused: false,
			candidates: [],
			members: [],
			wallets: [],
			categories: [],
			values: null,
			loadError: SPLITS_LOAD_FAILED
		};
	}
};

export const actions: Actions = {
	create: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const { spaceId, userId } = scope;
		const db = event.locals.db;
		const now = Date.now();
		const clientId = textField(form, 'clientId');
		if (!isClientId(clientId)) return fail(409, { error: REFS_GONE });
		// A resend of a form that was already saved (its answer was lost): the split it wrote, nothing new.
		if (await getSplit(db, spaceId, clientId)) {
			setSplitSavedNotice(event.cookies, event.locals.secure, 'created');
			redirect(303, `/patungan/${clientId}?saved=created`);
		}
		const billId = idField(form, 'bill');
		const [bill, members] = await Promise.all([
			billId ? billCandidate(db, spaceId, billId) : null,
			spaceMemberNames(db, spaceId)
		]);
		if (billId && !bill) return fail(409, { error: BILL_UNAVAILABLE });
		const payer = members.find((m) => m.userId === userId);
		if (!payer) return fail(409, { error: REFS_GONE });

		const errors: SplitFormErrors = {};
		let currency = bill?.currency ?? 'IDR';
		let own: { walletId: string; categoryId: string } | null = null;
		if (!bill) {
			const walletId = idField(form, 'walletId');
			const categoryId = idField(form, 'categoryId');
			const [wallet, categories] = await Promise.all([
				walletId ? getWallet(db, spaceId, walletId) : null,
				listCategories(db, spaceId)
			]);
			const category = categories.find((c) => c.id === categoryId && c.kind === 'expense');
			if (!wallet) errors.walletId = WALLET_REQUIRED;
			if (!category) errors.categoryId = CATEGORY_REQUIRED;
			if (wallet) currency = wallet.currency;
			if (wallet && category) own = { walletId: wallet.id, categoryId: category.id };
		}
		const read = readSplitForm(form, {
			currency,
			fixedTotal: bill?.amountMinor ?? null,
			payer,
			members,
			locale: event.locals.locale
		});
		if (!read.ok || Object.keys(errors).length > 0)
			return fail(400, {
				errors: { ...errors, ...(read.ok ? {} : read.errors) },
				values: read.values
			});
		// The standalone path writes a transaction: the same per-user budget as every other creating action.
		if (!bill && (await overTransactionCreateLimit(db, userId, now)))
			return fail(429, { error: TRANSACTION_RATE_LIMITED, values: read.values });

		const created = await createSplit(
			db,
			scope,
			clientId,
			read.fields,
			currency,
			bill
				? { kind: 'link', transactionId: bill.id }
				: {
						kind: 'own',
						transactionId: crypto.randomUUID(),
						...(own as { walletId: string; categoryId: string })
					},
			now
		);
		if (!created.ok && created.reason !== 'already') {
			const error =
				created.reason === 'bill'
					? BILL_UNAVAILABLE
					: created.reason === 'limit'
						? TRANSACTION_LIMIT
						: created.reason === 'split_limit'
							? SPLIT_LIMIT
							: REFS_GONE;
			return fail(409, { error, values: read.values });
		}
		setSplitSavedNotice(event.cookies, event.locals.secure, 'created');
		redirect(303, `/patungan/${clientId}?saved=created`);
	}
};
