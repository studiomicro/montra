import { fail } from '@sveltejs/kit';
import { listCategoriesWithPresets } from '#lib/server/categories/repo';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { resolveMerchants } from '#lib/server/merchants/resolve';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { frequentManualTransactions, MAX_FREQUENT } from '#lib/server/transactions/aggregate';
import { overTransactionCreateLimit } from '#lib/server/transactions/create-limit';
import {
	REFS_GONE,
	TRANSACTION_CHANGED,
	TRANSACTION_LIMIT,
	TRANSACTION_NOT_FOUND,
	TRANSACTION_RATE_LIMITED,
	TRANSACTIONS_LOAD_FAILED,
	VOICE_DUPLICATE,
	VOICE_NOTHING,
	VOICE_ROWS_INVALID
} from '#lib/server/transactions/messages';
import { deleteTransaction } from '#lib/server/transactions/repo';
import { ID_MAX_LENGTH } from '#lib/server/transactions/validation';
import {
	checkVoiceRows,
	recordAgain,
	saveVoiceTransactions,
	submissionKey,
	VOICE_FORM_MAX_BYTES
} from '#lib/server/transactions/voice';
import { newId } from '#lib/server/util';
import { listWallets } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { cleanMoneyText } from '#lib/shared/money-parse';
import { parseVoiceSentence, VOICE_BATCH_MAX } from '#lib/shared/voice-parse';
import type { Actions, PageServerLoad } from './$types';

/**
 * FN-14 Suara. The sentence is parsed in the browser (speech or typed); only the reviewed rows reach the server.
 * Without JavaScript the typed sentence is posted to `parse`, which runs the very same `parseVoiceSentence`.
 * Every load and action resolves the space through `currentSpaceScope` (`requireSpaceAccess` with
 * `locals.user`); every id in a form is only looked up inside that space.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const db = locals.db;
	const today = wibTodayString();
	try {
		const [wallets, categories, frequent] = await Promise.all([
			listWallets(db, spaceId),
			listCategoriesWithPresets(db, spaceId),
			frequentManualTransactions(db, spaceId, { limit: MAX_FREQUENT, today })
		]);
		// Spoken amounts are rupiah: the favourite wallet (listed first) unless it is not IDR, then the first IDR one.
		const favourite =
			wallets.find((w) => w.isFavourite && w.currency === 'IDR') ??
			wallets.find((w) => w.currency === 'IDR') ??
			wallets[0];
		return {
			wallets: wallets.map(({ id, name, type, currency }) => ({ id, name, type, currency })),
			categories: categories.map(({ id, kind, name, tileKey, isPreset }) => ({
				id,
				kind,
				name,
				tileKey,
				isPreset
			})),
			defaultWalletId: favourite?.id ?? '',
			frequent,
			// One key per page view: a double-sent "Catat lagi" without JavaScript records once.
			tapKey: newId(),
			loadError: null
		};
	} catch (e) {
		console.error('riwayat/suara: load failed', e);
		return {
			wallets: [],
			categories: [],
			defaultWalletId: '',
			frequent: [],
			tapKey: newId(),
			loadError: TRANSACTIONS_LOAD_FAILED
		};
	}
};

const idField = (form: FormData, name: string) => {
	const value = textField(form, name);
	return value.length > ID_MAX_LENGTH ? '' : value;
};

export const actions: Actions = {
	/** No-JavaScript typed sentence → candidates (with JavaScript the page parses it locally instead). */
	parse: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const sentence = textField(form, 'sentence');
		const wallets = await listWallets(event.locals.db, scope.spaceId);
		const all = parseVoiceSentence(sentence, { wallets });
		const candidates = all.slice(0, VOICE_BATCH_MAX);
		// FN-20: the same deterministic resolution the page asks /riwayat/saran for with JavaScript.
		const { items: resolved } = await resolveMerchants(
			event.locals.db,
			scope,
			candidates.map((c) => ({ rawText: c.title, type: c.type, hintTileKey: c.categoryHint })),
			{ userId: scope.userId, allowAi: false }
		);
		return {
			action: 'parse' as const,
			sentence: cleanMoneyText(sentence),
			candidates,
			resolved: resolved.map(({ merchant, categoryId, reason }) => ({
				merchant,
				categoryId,
				reason
			})),
			remaining: Math.max(0, all.length - VOICE_BATCH_MAX),
			key: newId()
		};
	},

	/** "Simpan N transaksi": all reviewed rows or none; success only after the batch is written. */
	save: async (event) => {
		const form = await readFormBody(event.request, VOICE_FORM_MAX_BYTES);
		const scope = await currentSpaceScope(event.locals);
		const db = event.locals.db;
		const key = submissionKey(form);
		if (!key) return fail(400, { action: 'save' as const, error: VOICE_NOTHING });
		const checked = await checkVoiceRows(
			db,
			scope.spaceId,
			form,
			wibTodayString(),
			event.locals.locale
		);
		if (!checked.ok)
			return fail(400, {
				action: 'save' as const,
				error: checked.rows.length === 0 ? VOICE_NOTHING : VOICE_ROWS_INVALID,
				rows: checked.rows,
				rowErrors: checked.errors,
				remaining: checked.remaining,
				key
			});
		// One creating action however many rows it saves (create-limit.ts).
		const now = Date.now();
		if (await overTransactionCreateLimit(db, scope.userId, now))
			return fail(429, { action: 'save' as const, error: TRANSACTION_RATE_LIMITED });
		const saved = await saveVoiceTransactions(db, scope, checked.inputs, key, now);
		if (!saved.ok) {
			const error =
				saved.reason === 'limit'
					? TRANSACTION_LIMIT
					: saved.reason === 'duplicate'
						? VOICE_DUPLICATE
						: REFS_GONE;
			return fail(409, { action: 'save' as const, error });
		}
		return { action: 'save' as const, saved: saved.saved, remaining: checked.remaining };
	},

	/** "Catat lagi": one tap records a copy of a frequent transaction today. */
	catatLagi: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const key = submissionKey(form);
		const id = idField(form, 'id');
		if (!key || !id)
			return fail(404, { action: 'catatLagi' as const, error: TRANSACTION_NOT_FOUND });
		const now = Date.now();
		if (await overTransactionCreateLimit(event.locals.db, scope.userId, now))
			return fail(429, { action: 'catatLagi' as const, error: TRANSACTION_RATE_LIMITED });
		const result = await recordAgain(event.locals.db, scope, id, key, wibTodayString(), now);
		if (!result.ok) {
			const [status, error] =
				result.reason === 'missing'
					? [404, TRANSACTION_NOT_FOUND]
					: result.reason === 'limit'
						? [409, TRANSACTION_LIMIT]
						: result.reason === 'duplicate'
							? [409, VOICE_DUPLICATE]
							: [409, REFS_GONE];
			return fail(status, { action: 'catatLagi' as const, error });
		}
		return {
			action: 'catatLagi' as const,
			recorded: { id: result.id, updatedAt: result.updatedAt }
		};
	},

	/** "Urungkan" on the "Dicatat" toast: FN-05's delete of exactly the row just recorded. */
	urungkan: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const id = idField(form, 'id');
		const updatedAtText = textField(form, 'updatedAt');
		const updatedAt = /^\d{1,15}$/.test(updatedAtText) ? Number(updatedAtText) : -1;
		const result = await deleteTransaction(
			event.locals.db,
			scope,
			id,
			updatedAt,
			Date.now(),
			getEnv()
		);
		if (result === 'missing')
			return fail(404, { action: 'urungkan' as const, error: TRANSACTION_NOT_FOUND });
		if (result === 'stale')
			return fail(409, { action: 'urungkan' as const, error: TRANSACTION_CHANGED });
		return { action: 'urungkan' as const, undone: true };
	}
};
