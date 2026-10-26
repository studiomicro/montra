import { fail } from '@sveltejs/kit';
import { isAiGatewayConfigured } from '#lib/server/ai-keys/anthropic';
import { resolveAnthropicKey } from '#lib/server/ai-keys/lookup';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import {
	listCategories,
	listCategoriesWithPresets,
	type CategorySummary
} from '#lib/server/categories/repo';
import { getEnv } from '#lib/server/env';
import { PHOTO_UPLOAD_FAILED } from '#lib/server/photos/messages';
import { cleanUpFiles } from '#lib/server/photos/store';
import { uploadPhoto } from '#lib/server/photos/upload';
import { readReceiptImage } from '#lib/server/receipts/anthropic';
import { photoAlreadySaved, receiptKeyPrefix } from '#lib/server/receipts/dedupe';
import { possibleReceiptDuplicates } from '#lib/server/receipts/duplicate';
import { checkReadTicket, issueReadTicket } from '#lib/server/receipts/read-ticket';
import {
	announcesTooLargeReceipt,
	readReceiptForm,
	readReceiptPhoto,
	reserveReceiptSlot
} from '#lib/server/receipts/image';
import {
	RECEIPT_ALREADY_SAVED,
	RECEIPT_BUSY,
	RECEIPT_MODEL_UNAVAILABLE,
	RECEIPT_NO_KEY,
	RECEIPT_NOT_A_RECEIPT,
	RECEIPT_NOT_CONFIGURED,
	RECEIPT_PHOTO_TOO_LARGE,
	RECEIPT_RATE_LIMITED,
	RECEIPT_READ_FIRST,
	RECEIPT_SAVE_FAILED,
	RECEIPT_UNREADABLE
} from '#lib/server/receipts/messages';
import {
	parseReceiptForm,
	receiptFormValues,
	saveReceiptTransactions
} from '#lib/server/receipts/save';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { overTransactionCreateLimit } from '#lib/server/transactions/create-limit';
import {
	REFS_GONE,
	TRANSACTION_LIMIT,
	TRANSACTION_RATE_LIMITED,
	TRANSACTIONS_LOAD_FAILED
} from '#lib/server/transactions/messages';
import { errorLabel } from '#lib/server/util';
import { listWallets, type WalletSummary } from '#lib/server/wallets/repo';
import { AI_KEY_TEST_LABELS } from '#lib/shared/ai-keys';
import { groupDigits, minorToDigits } from '#lib/shared/amount-input';
import { wibTodayString } from '#lib/shared/dates';
import { createTranslator } from '#lib/shared/i18n';
import {
	itemCategoryHint,
	receiptDateCheck,
	receiptWalletGuess,
	RECEIPT_READS_PER_WINDOW,
	type ReceiptFormValues,
	type ReceiptReading,
	type ReceiptReview
} from '#lib/shared/receipts';
import { sql } from 'drizzle-orm';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * FN-15 Struk. One page: pick a photo (re-encoded in the browser), "Baca struk" (`read`: one provider call with
 * the user's own key), review and edit, "Simpan" (`save`). Nothing is kept between the two requests: the photo
 * and the read figures live in the page, and `save` reads and checks everything again. Every load and action
 * resolves the space through `currentSpaceScope` (signed-out: /masuk); every id in a form is only looked up
 * inside that space.
 */

/** Seconds a client is told to wait when this isolate's receipt lane is full. */
const RECEIPT_RETRY_AFTER_S = 30;

/** The IDR wallets a receipt can be paid from (every saved row is IDR). */
const idrWallets = (wallets: readonly WalletSummary[]) =>
	wallets
		.filter((w) => w.currency === 'IDR')
		.map(({ id, name, type, currency, isFavourite }) => ({
			id,
			name,
			type,
			currency,
			isFavourite
		}));

const expenseCategories = (categories: readonly CategorySummary[]) =>
	categories
		.filter((c) => c.kind === 'expense')
		.map(({ id, name, tileKey, isPreset }) => ({ id, name, tileKey, isPreset }));

export const load: PageServerLoad = async ({ locals }) => {
	const { spaceId, userId } = await currentSpaceScope(locals);
	const db = locals.db;
	const env = getEnv();
	const configured = isAiGatewayConfigured(env);
	try {
		const [hasKey, wallets, categories] = await Promise.all([
			// Only whether a key opens: the key itself never leaves the server.
			configured ? resolveAnthropicKey(db, userId, env).then((k) => k !== null) : false,
			listWallets(db, spaceId),
			listCategoriesWithPresets(db, spaceId)
		]);
		return {
			configured,
			hasKey,
			wallets: idrWallets(wallets),
			categories: expenseCategories(categories),
			today: wibTodayString(),
			loadError: null
		};
	} catch (e) {
		console.error('riwayat/struk: load failed', errorLabel(e));
		return {
			configured,
			hasKey: false,
			wallets: [],
			categories: [],
			today: wibTodayString(),
			loadError: TRANSACTIONS_LOAD_FAILED
		};
	}
};

/** 503 with Retry-After: this isolate already holds RECEIPT_LANE_MAX receipt requests, or this user has one. */
function busy(event: RequestEvent, action: 'read' | 'save') {
	event.setHeaders({ 'retry-after': String(RECEIPT_RETRY_AFTER_S) });
	return fail(503, { action, error: RECEIPT_BUSY });
}

const digits = (minor: number | null) => (minor === null ? '' : groupDigits(minorToDigits(minor)));

/** The review form's first values: the reading as whole-rupiah text, the wallet and categories preselected. */
function reviewValues(
	reading: ReceiptReading,
	date: string,
	wallets: ReturnType<typeof idrWallets>,
	categories: ReturnType<typeof expenseCategories>,
	readTicket: string
): ReceiptFormValues {
	const presetFor = (name: string) => {
		const tile = itemCategoryHint(name);
		return tile ? (categories.find((c) => c.isPreset && c.tileKey === tile)?.id ?? '') : '';
	};
	return {
		mode: 'single',
		shop: reading.shop,
		occurredOn: date,
		walletId: receiptWalletGuess(reading.paymentMethod, wallets),
		categoryId: presetFor(reading.shop),
		paymentMethod: reading.paymentMethod,
		items: reading.items.map((item) => ({
			name: item.name,
			amount: digits(item.amountMinor),
			categoryId: presetFor(item.name)
		})),
		tax: digits(reading.taxMinor),
		service: digits(reading.serviceMinor),
		discount: digits(reading.discountMinor),
		total: digits(reading.totalMinor),
		keepPhoto: true,
		acceptMismatch: false,
		readTicket
	};
}

const READ_FAILURES = {
	unreadable: [422, RECEIPT_UNREADABLE],
	not_a_receipt: [422, RECEIPT_NOT_A_RECEIPT],
	invalid: [502, AI_KEY_TEST_LABELS.invalid],
	quota: [502, AI_KEY_TEST_LABELS.quota],
	network: [502, AI_KEY_TEST_LABELS.network],
	model_unavailable: [502, RECEIPT_MODEL_UNAVAILABLE],
	not_configured: [503, RECEIPT_NOT_CONFIGURED]
} as const;

export const actions: Actions = {
	/** "Baca struk" and "Baca lagi": the photo read once by the user's own key; nothing is stored. */
	read: async (event) => {
		const { spaceId, userId } = await currentSpaceScope(event.locals);
		const db = event.locals.db;
		const env = getEnv();
		if (!isAiGatewayConfigured(env))
			return fail(503, { action: 'read' as const, error: RECEIPT_NOT_CONFIGURED });
		const apiKey = await resolveAnthropicKey(db, userId, env);
		if (!apiKey) return fail(400, { action: 'read' as const, error: RECEIPT_NO_KEY, noKey: true });
		if (announcesTooLargeReceipt(event.request))
			return fail(413, { action: 'read' as const, error: RECEIPT_PHOTO_TOO_LARGE });
		const release = reserveReceiptSlot(userId);
		if (!release) return busy(event, 'read');
		try {
			// Counted before the body is read and before any provider call (criterion 20).
			if (
				await overUserAttemptLimit(db, userId, Date.now(), 'receipt-read', RECEIPT_READS_PER_WINDOW)
			)
				return fail(429, { action: 'read' as const, error: RECEIPT_RATE_LIMITED });
			const form = await readReceiptForm(event.request);
			const photo = await readReceiptPhoto(form);
			if (!photo.ok) return fail(400, { action: 'read' as const, error: photo.message });
			const outcome = await readReceiptImage(env, apiKey, photo.image);
			if (outcome.kind !== 'ok') {
				const [status, error] = READ_FAILURES[outcome.kind];
				return fail(status, { action: 'read' as const, error });
			}
			const { reading } = outcome;
			const today = wibTodayString();
			const date = reading.occurredOn ?? today;
			const [wallets, categories, prefix] = await Promise.all([
				listWallets(db, spaceId),
				listCategories(db, spaceId),
				receiptKeyPrefix(photo.image.bytes)
			]);
			const amounts = reading.items.flatMap((item, i) =>
				item.amountMinor === null ? [] : [{ key: `item.${i}`, amountMinor: item.amountMinor }]
			);
			if (reading.totalMinor !== null)
				amounts.push({ key: 'total', amountMinor: reading.totalMinor });
			const [duplicates, [saved], ticket] = await Promise.all([
				possibleReceiptDuplicates(db, spaceId, date, amounts),
				db.all<{ n: number }>(sql`select ${photoAlreadySaved(spaceId, prefix)} as n`),
				issueReadTicket(env, { userId, spaceId, keyPrefix: prefix }, Date.now())
			]);
			const review: ReceiptReview = {
				values: reviewValues(
					reading,
					date,
					idrWallets(wallets),
					expenseCategories(categories),
					ticket ?? ''
				),
				dateCheck: reading.occurredOn ? receiptDateCheck(reading.occurredOn, today) : 'ok',
				duplicates: [...duplicates],
				alreadySaved: Boolean(saved?.n),
				foreignCurrency:
					reading.currency !== null && reading.currency !== 'IDR' ? reading.currency : null
			};
			return { action: 'read' as const, review };
		} finally {
			release();
		}
	},

	/** "Simpan": every edited field checked again; all rows or none; success only after the batch is written. */
	save: async (event) => {
		const scope = await currentSpaceScope(event.locals);
		const db = event.locals.db;
		if (announcesTooLargeReceipt(event.request))
			return fail(413, { action: 'save' as const, error: RECEIPT_PHOTO_TOO_LARGE });
		const release = reserveReceiptSlot(scope.userId);
		if (!release) return busy(event, 'save');
		try {
			const form = await readReceiptForm(event.request);
			const values = receiptFormValues(form);
			const t = createTranslator(event.locals.locale);
			const parsed = parseReceiptForm(values, t);
			if (!parsed.ok) return fail(400, { action: 'save' as const, errors: parsed.errors, values });
			// The photo is needed even when it is not kept: its hash is the receipt's dedupe key.
			const photo = await readReceiptPhoto(form);
			if (!photo.ok) return fail(400, { action: 'save' as const, error: photo.message, values });
			const now = Date.now();
			// One creating action however many rows it saves (create-limit.ts).
			if (await overTransactionCreateLimit(db, scope.userId, now))
				return fail(429, { action: 'save' as const, error: TRANSACTION_RATE_LIMITED, values });
			const env = getEnv();
			const prefix = await receiptKeyPrefix(photo.image.bytes);
			// Rows are tagged `receipt` only after a real read of these very bytes (red team L3).
			const binding = { userId: scope.userId, spaceId: scope.spaceId, keyPrefix: prefix };
			if (!(await checkReadTicket(env, values.readTicket, binding, now)))
				return fail(400, { action: 'save' as const, error: RECEIPT_READ_FIRST, values });
			const [saved] = await db.all<{ n: number }>(
				sql`select ${photoAlreadySaved(scope.spaceId, prefix)} as n`
			);
			// Checked before the upload so a resend uploads nothing; the insert repeats the check (races).
			if (saved?.n)
				return fail(409, { action: 'save' as const, error: RECEIPT_ALREADY_SAVED, values });
			const stored = parsed.draft.keepPhoto
				? await uploadPhoto(env, db, scope.spaceId, 'receipts', photo.image, now)
				: null;
			if (parsed.draft.keepPhoto && !stored)
				return fail(503, { action: 'save' as const, error: PHOTO_UPLOAD_FAILED, values });
			let result;
			try {
				result = await saveReceiptTransactions(
					db,
					scope,
					parsed.draft,
					prefix,
					stored,
					t,
					now,
					wibTodayString(now)
				);
			} catch (e) {
				console.error('riwayat/struk: save failed', errorLabel(e));
				result = null;
			}
			if (!result?.ok) {
				// Nothing points at the uploaded photo: delete it now (the sweep is the fallback).
				if (stored) await cleanUpFiles(env, db, [stored.key], now);
				if (!result)
					return fail(503, { action: 'save' as const, error: RECEIPT_SAVE_FAILED, values });
				if (result.reason === 'invalid')
					return fail(400, { action: 'save' as const, errors: result.errors, values });
				const error =
					result.reason === 'already'
						? RECEIPT_ALREADY_SAVED
						: result.reason === 'limit'
							? TRANSACTION_LIMIT
							: REFS_GONE;
				return fail(409, { action: 'save' as const, error, values });
			}
			return {
				action: 'save' as const,
				saved: {
					count: result.ids.length,
					firstId: result.ids[0] ?? null,
					photo: result.photoId !== null
				}
			};
		} finally {
			release();
		}
	}
};
