import { sql } from 'drizzle-orm';
import type { Locale } from '#lib/shared/i18n';
import { VOICE_BATCH_MAX } from '#lib/shared/voice-parse';
import { listCategories, getCategory } from '../categories/repo';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import { textField } from '../forms';
import type { SpaceScope } from '../spaces/access';
import { bumpSpaceSeq } from '../sync/seq';
import { isUniqueViolation, newId } from '../util';
import { getWallet, listWallets } from '../wallets/repo';
import { TYPE_INVALID } from './messages';
import {
	createTransaction,
	getTransaction,
	insertTransactions,
	MAX_TRANSACTIONS_PER_SPACE
} from './repo';
import {
	capturedTransactionInput,
	parseTransactionForm,
	resolveTransactionInput,
	type FieldErrors,
	type TransactionInput
} from './validation';

/**
 * FN-14 server side. The browser parses the sentence; the server only ever receives the reviewed rows and checks
 * each one with FN-05's own compose-form schema (`parseTransactionForm` + `resolveTransactionInput`, never a
 * second schema), then writes them through FN-05's one insert path with `source = 'voice'`.
 */

/**
 * Body cap of the "Simpan" form: VOICE_BATCH_MAX rows of five fields, each title up to 80 characters that may
 * be percent-encoded multi-byte text (≈ 900 bytes a row at worst), plus the key and count.
 */
export const VOICE_FORM_MAX_BYTES = 24 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNT = /^\d{1,4}$/;

/** The submission key a review form carries (one per parsed sentence), or null when absent or malformed. */
export function submissionKey(form: FormData): string | null {
	const key = textField(form, 'key');
	return UUID.test(key) ? key : null;
}

/** One review row as posted (echoed back on a refusal so a no-JavaScript page keeps the user's edits). */
interface VoiceRowValues {
	type: string;
	amount: string;
	walletId: string;
	categoryId: string;
	title: string;
}

export type CheckedVoiceRows =
	| { ok: true; inputs: TransactionInput[]; remaining: number }
	| {
			ok: false;
			rows: VoiceRowValues[];
			errors: FieldErrors[];
			remaining: number;
	  };

/**
 * The posted rows (`type.i`, `amount.i`, `walletId.i`, `categoryId.i`, `title.i` for i < `count`), at most
 * VOICE_BATCH_MAX of them (`remaining` says how many more were posted and not read). Each goes through FN-05's
 * compose-form schema with `occurredOn = today` (WIB) and no time; a voice row is an expense or an income,
 * never a transfer. Wallet and category ids are looked up inside `spaceId` only (another space's id reads as
 * not found). All or nothing: one bad row returns every row with its errors.
 */
export async function checkVoiceRows(
	db: Db,
	spaceId: string,
	form: FormData,
	today: string,
	locale: Locale
): Promise<CheckedVoiceRows> {
	const countText = textField(form, 'count');
	const posted = COUNT.test(countText) ? Number(countText) : 0;
	const n = Math.min(posted, VOICE_BATCH_MAX);
	const remaining = posted - n;
	const [wallets, categories] = await Promise.all([
		listWallets(db, spaceId),
		listCategories(db, spaceId)
	]);
	const rows: VoiceRowValues[] = [];
	const errors: FieldErrors[] = [];
	const inputs: TransactionInput[] = [];
	for (let i = 0; i < n; i++) {
		const row = new FormData();
		const field = (name: keyof VoiceRowValues) => textField(form, `${name}.${i}`);
		row.set('type', field('type'));
		row.set('amount', field('amount'));
		row.set('walletId', field('walletId'));
		row.set('transferToWalletId', '');
		row.set('categoryId', field('categoryId'));
		row.set('title', field('title'));
		row.set('note', '');
		row.set('occurredOn', today);
		row.set('occurredTime', '');
		const parsed = parseTransactionForm(row, locale);
		const v = parsed.values;
		rows.push({
			type: v.type,
			amount: v.amount,
			walletId: v.walletId,
			categoryId: v.categoryId,
			title: v.title
		});
		if (v.type === 'transfer') {
			errors.push({ type: TYPE_INVALID });
			continue;
		}
		if (!parsed.ok) {
			errors.push(parsed.errors);
			continue;
		}
		const wallet = wallets.find((w) => w.id === parsed.draft.walletId);
		const category = categories.find((c) => c.id === parsed.draft.categoryId);
		const resolved = resolveTransactionInput(parsed.draft, {
			wallet: wallet ? { id: wallet.id, currency: wallet.currency } : null,
			toWallet: null,
			category: category ? { id: category.id, kind: category.kind } : null
		});
		if (!resolved.ok) {
			errors.push(resolved.errors);
			continue;
		}
		errors.push({});
		inputs.push(resolved.value);
	}
	if (n === 0 || inputs.length !== n) return { ok: false, rows, errors, remaining };
	return { ok: true, inputs, remaining };
}

export type SaveVoiceResult =
	{ ok: true; saved: number } | { ok: false; reason: 'limit' | 'gone' | 'duplicate' };

async function full(db: Db, spaceId: string, adding: number): Promise<boolean> {
	const [count] = await db.all<{ n: number }>(
		sql`select count(*) as n from transactions where space_id = ${spaceId} and deleted_at is null`
	);
	return (count?.n ?? 0) + adding > MAX_TRANSACTIONS_PER_SPACE;
}

/**
 * "Simpan N transaksi": every checked row in one `db.batch` through FN-05's insert path (`insertTransactions`,
 * the same statement `createTransaction` runs), `source = 'voice'`, each with the dedupe key `<key>:<i>`. A
 * trailing assertion makes it all or nothing: if a wallet, category or the membership went meanwhile, or the
 * space would pass its transaction cap, nothing is written. A resent submission (same key) hits the dedupe
 * index and writes nothing either (`duplicate`).
 */
export async function saveVoiceTransactions(
	db: Db,
	scope: SpaceScope,
	inputs: readonly TransactionInput[],
	key: string,
	now: number
): Promise<SaveVoiceResult> {
	const { spaceId } = scope;
	const rows = inputs.map((input, i) => ({
		id: newId(),
		input,
		origin: { source: 'voice' as const, dedupeKey: `${key}:${i}` }
	}));
	const ids = JSON.stringify(rows.map((r) => r.id));
	try {
		await db.batch([
			bumpSpaceSeq(db, spaceId),
			insertTransactions(db, scope, rows, now),
			batchAssert(
				db,
				sql`(select count(*) from transactions t where t.space_id = ${spaceId}
					and t.id in (select value from json_each(${ids}))) = ${rows.length}`
			)
		]);
		return { ok: true, saved: rows.length };
	} catch (e) {
		if (isUniqueViolation(e)) return { ok: false, reason: 'duplicate' };
		if (!isBatchAssertFailure(e)) throw e;
	}
	return { ok: false, reason: (await full(db, spaceId, rows.length)) ? 'limit' : 'gone' };
}

export type RecordAgainResult =
	| { ok: true; id: string; updatedAt: number }
	| { ok: false; reason: 'missing' | 'gone' | 'limit' | 'duplicate' };

/**
 * "Catat lagi": a copy of one live manual/voice expense or income of the space (`sourceId`, normally a
 * `frequentManualTransactions` entry) dated `today` (WIB), saved through `createTransaction` with
 * `source = 'voice'` and the tap's dedupe key, so a resent tap writes nothing. The copy is checked by FN-05's
 * captured-row validator against the wallet and category as they are now. `missing` for an unknown, deleted,
 * other-space, `Data demo`, transfer, balance-adjustment or captured row (one answer, no oracle).
 */
export async function recordAgain(
	db: Db,
	scope: SpaceScope,
	sourceId: string,
	key: string,
	today: string,
	now: number
): Promise<RecordAgainResult> {
	const { spaceId } = scope;
	const tx = await getTransaction(db, spaceId, sourceId);
	if (
		!tx ||
		tx.isDemo ||
		(tx.type !== 'expense' && tx.type !== 'income') ||
		(tx.source !== 'manual' && tx.source !== 'voice')
	)
		return { ok: false, reason: 'missing' };
	const [wallet, category] = await Promise.all([
		getWallet(db, spaceId, tx.walletId),
		tx.categoryId ? getCategory(db, spaceId, tx.categoryId) : null
	]);
	const checked = capturedTransactionInput(
		{
			type: tx.type,
			amountMinor: tx.amountMinor,
			currency: tx.currency,
			walletId: tx.walletId,
			categoryId: tx.categoryId,
			title: tx.title,
			note: null,
			occurredOn: today
		},
		{
			wallet: wallet ? { id: wallet.id, currency: wallet.currency } : null,
			toWallet: null,
			category: category && !category.isHidden ? { id: category.id, kind: category.kind } : null
		}
	);
	if (!checked.ok) return { ok: false, reason: 'gone' };
	try {
		const created = await createTransaction(db, scope, checked.value, now, {
			source: 'voice',
			dedupeKey: key
		});
		if (!created.ok) return created;
		return { ok: true, id: created.id, updatedAt: now };
	} catch (e) {
		if (isUniqueViolation(e)) return { ok: false, reason: 'duplicate' };
		throw e;
	}
}
