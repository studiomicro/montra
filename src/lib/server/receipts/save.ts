import { sql } from 'drizzle-orm';
import { isDateString, wibInstantUtcMs } from '#lib/shared/dates';
import type { Translator } from '#lib/shared/i18n';
import { formatMoney } from '#lib/shared/money-format';
import {
	adjustmentsMinor,
	canSplit,
	RECEIPT_ITEMS_MAX,
	RECEIPT_PAYMENT_MAX_LENGTH,
	reconcileReceipt,
	type ReceiptFormValues,
	type ReceiptItemValues,
	type ReceiptMode
} from '#lib/shared/receipts';
import { cleanText, maskAccountNumbers } from '#lib/shared/text';
import { NOTE_MAX_LENGTH, TITLE_MAX_LENGTH } from '#lib/shared/transactions';
import { listCategories } from '../categories/repo';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import { textField, wholeAmountMinor, ID_MAX_LENGTH } from '../forms';
import type { StoredPhoto } from '../photos/store';
import type { SpaceScope } from '../spaces/access';
import { bumpSpaceSeq } from '../sync/seq';
import { AMOUNT_INVALID, DATE_INVALID } from '../transactions/messages';
import {
	attachPhoto,
	insertTransactions,
	transactionCapReached,
	type NewTransaction
} from '../transactions/repo';
import { capturedTransactionInput, type FieldErrors } from '../transactions/validation';
import { isUniqueViolation, newId } from '../util';
import { WALLET_NOT_FOUND } from '../wallets/messages';
import { getWallet } from '../wallets/repo';
import { photoAlreadySaved } from './dedupe';
import { READ_TICKET_MAX_LENGTH } from './read-ticket';
import {
	RECEIPT_ADJUSTMENTS_TITLE,
	RECEIPT_ITEMS_REQUIRED,
	RECEIPT_NOTE_DISCOUNT,
	RECEIPT_NOTE_SERVICE,
	RECEIPT_NOTE_TAX,
	RECEIPT_NOTE_TOTAL,
	RECEIPT_SPLIT_DISCOUNT,
	RECEIPT_TOTAL_MISMATCH,
	RECEIPT_TOTAL_REQUIRED,
	RECEIPT_UNNAMED_TITLE
} from './messages';

/**
 * "Simpan" of a reviewed receipt (FN-15). The server reads every edited field again and never trusts the AI's
 * original numbers: amounts are the whole-rupiah form contract (`wholeAmountMinor`), reconciliation is re-run on
 * the edited figures, wallet and categories are looked up in the session's space only, and each row passes
 * FN-05's captured-row validator before FN-05's one insert path writes it with source `receipt` and the key
 * `receipt:<photo hash>:<row index>`.
 */

/** Field errors: `shop`, `occurredOn`, `walletId`, `categoryId`, `total`, `tax`, `service`, `discount`, `item.<i>`, `form`. */
export type ReceiptFieldErrors = Record<string, string>;

const COUNT = /^\d{1,3}$/;
const idValue = (form: FormData, name: string) => textField(form, name).slice(0, ID_MAX_LENGTH + 1);
const amountValue = (form: FormData, name: string) => textField(form, name).slice(0, 64);

export function receiptFormValues(form: FormData): ReceiptFormValues {
	const countText = textField(form, 'count');
	const count = Math.min(COUNT.test(countText) ? Number(countText) : 0, RECEIPT_ITEMS_MAX);
	const items: ReceiptItemValues[] = [];
	for (let i = 0; i < count; i++)
		items.push({
			name: textField(form, `itemName.${i}`).slice(0, TITLE_MAX_LENGTH * 4),
			amount: amountValue(form, `itemAmount.${i}`),
			categoryId: idValue(form, `itemCategory.${i}`)
		});
	return {
		mode: textField(form, 'mode') === 'split' ? 'split' : 'single',
		shop: textField(form, 'shop').slice(0, TITLE_MAX_LENGTH * 4),
		occurredOn: textField(form, 'occurredOn').slice(0, 16),
		walletId: idValue(form, 'walletId'),
		categoryId: idValue(form, 'categoryId'),
		paymentMethod: textField(form, 'paymentMethod').slice(0, RECEIPT_PAYMENT_MAX_LENGTH * 4),
		items,
		tax: amountValue(form, 'tax'),
		service: amountValue(form, 'service'),
		discount: amountValue(form, 'discount'),
		total: amountValue(form, 'total'),
		keepPhoto: textField(form, 'keepPhoto') === 'on',
		acceptMismatch: textField(form, 'acceptMismatch') === 'on',
		readTicket: textField(form, 'readTicket').slice(0, READ_TICKET_MAX_LENGTH)
	};
}

/** The reviewed receipt after shape checks, before its ids are looked up in the space. */
export interface ReceiptDraft {
	mode: ReceiptMode;
	title: string;
	shop: string;
	occurredOn: string;
	walletId: string;
	categoryId: string;
	paymentMethod: string | null;
	/** Item lines; an amount is null only on "Satu transaksi" (a split item always has one). */
	items: { name: string; amountMinor: number | null; categoryId: string }[];
	taxMinor: number | null;
	serviceMinor: number | null;
	discountMinor: number | null;
	totalMinor: number | null;
	keepPhoto: boolean;
}

/** A whole-rupiah amount field: null when blank, `invalid` when it is not a whole amount. */
function optionalAmount(text: string): number | null | 'invalid' {
	const minor = wholeAmountMinor(text, 'IDR');
	if (minor === null) return 'invalid';
	return minor === 0 ? null : minor;
}

/**
 * Shape checks of the review form (no database): a real date, whole-rupiah amounts, items with a name and an
 * amount, a total for "Satu transaksi", the discount within tax plus service for "Pisah per item", and the
 * figures reconciled on the edited values (or the user's explicit "save anyway"). Blank item rows are dropped.
 */
export function parseReceiptForm(
	values: ReceiptFormValues,
	t: Translator
): { ok: true; draft: ReceiptDraft } | { ok: false; errors: ReceiptFieldErrors } {
	const errors: ReceiptFieldErrors = {};
	if (!isDateString(values.occurredOn)) errors.occurredOn = DATE_INVALID;
	const figure = (name: 'tax' | 'service' | 'discount' | 'total') => {
		const v = optionalAmount(values[name]);
		if (v === 'invalid') {
			errors[name] = AMOUNT_INVALID;
			return null;
		}
		return v;
	};
	const taxMinor = figure('tax');
	const serviceMinor = figure('service');
	const discountMinor = figure('discount');
	const totalMinor = figure('total');
	const items: ReceiptDraft['items'] = [];
	values.items.forEach((item, i) => {
		const name = cleanText(item.name, TITLE_MAX_LENGTH);
		const amount = optionalAmount(item.amount);
		if (name === '' && amount === null) return;
		if (amount === 'invalid') errors[`item.${i}`] = AMOUNT_INVALID;
		else if (values.mode === 'split' && (name === '' || amount === null))
			errors[`item.${i}`] = RECEIPT_ITEMS_REQUIRED;
		items.push({
			name,
			amountMinor: amount === 'invalid' ? null : amount,
			categoryId: item.categoryId
		});
	});
	const figures = { taxMinor, serviceMinor, discountMinor };
	if (values.mode === 'single' && totalMinor === null && !errors.total)
		errors.total = RECEIPT_TOTAL_REQUIRED;
	if (values.mode === 'split') {
		if (items.length === 0) errors.form = RECEIPT_ITEMS_REQUIRED;
		else if (!canSplit(figures)) errors.form = RECEIPT_SPLIT_DISCOUNT;
	}
	const balance = reconcileReceipt({
		items: items.map((i) => i.amountMinor),
		...figures,
		totalMinor
	});
	if (Object.keys(errors).length === 0 && balance.status === 'mismatch' && !values.acceptMismatch)
		errors.form = RECEIPT_TOTAL_MISMATCH;
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	const shop = maskAccountNumbers(cleanText(values.shop, TITLE_MAX_LENGTH));
	return {
		ok: true,
		draft: {
			mode: values.mode,
			title: shop || t.tr(RECEIPT_UNNAMED_TITLE),
			shop,
			occurredOn: values.occurredOn,
			walletId: values.walletId,
			categoryId: values.categoryId,
			paymentMethod:
				maskAccountNumbers(cleanText(values.paymentMethod, RECEIPT_PAYMENT_MAX_LENGTH)) || null,
			items,
			taxMinor,
			serviceMinor,
			discountMinor,
			totalMinor,
			keepPhoto: values.keepPhoto
		}
	};
}

/**
 * The "Satu transaksi" note: every item and amount, then tax, service, discount and total as entered — plain
 * text in the user's language, one entry per " · " (a note is single-line: FN-05's validator folds line
 * breaks), cut to NOTE_MAX_LENGTH like every note.
 */
export function receiptNote(draft: ReceiptDraft, t: Translator): string {
	const money = (minor: number) => formatMoney(minor, 'IDR', 'auto', t.locale);
	const parts = draft.items.map(
		(i) => `${i.name || '—'} ${i.amountMinor === null ? '—' : money(i.amountMinor)}`
	);
	const extra: [string, number | null][] = [
		[RECEIPT_NOTE_TAX, draft.taxMinor],
		[RECEIPT_NOTE_SERVICE, draft.serviceMinor],
		[RECEIPT_NOTE_DISCOUNT, draft.discountMinor],
		[RECEIPT_NOTE_TOTAL, draft.totalMinor]
	];
	for (const [label, minor] of extra)
		if (minor !== null) parts.push(`${t.tr(label)} ${money(minor)}`);
	return cleanText(parts.join(' · '), NOTE_MAX_LENGTH);
}

/** One row to write: its dedupe index and the captured fields. */
interface PlannedRow {
	index: number;
	title: string;
	note: string | null;
	amountMinor: number;
	categoryId: string;
}

/**
 * The rows a draft becomes: "Satu transaksi" is one row (the total) at index 0; "Pisah per item" is one row per
 * item (index i) plus, when tax + service − discount is positive, one "Pajak & servis" row (index = item count),
 * so the rows add up to the receipt. The kept photo goes on the single row, else the "Pajak & servis" row, else
 * the first item (owner decision 6). Returns the rows and the index of the photo's row.
 */
export function plannedRows(
	draft: ReceiptDraft,
	t: Translator
): { rows: PlannedRow[]; photoIndex: number } {
	if (draft.mode === 'single')
		return {
			rows: [
				{
					index: 0,
					title: draft.title,
					note: receiptNote(draft, t) || null,
					amountMinor: draft.totalMinor ?? 0,
					categoryId: draft.categoryId
				}
			],
			photoIndex: 0
		};
	const note = draft.shop || null;
	const rows: PlannedRow[] = draft.items.map((item, index) => ({
		index,
		title: item.name,
		note,
		amountMinor: item.amountMinor ?? 0,
		// An item left on "Sama dengan struk" takes the receipt's category.
		categoryId: item.categoryId || draft.categoryId
	}));
	const adjustments = adjustmentsMinor(draft);
	if (adjustments > 0) {
		rows.push({
			index: rows.length,
			title: t.tr(RECEIPT_ADJUSTMENTS_TITLE),
			note,
			amountMinor: adjustments,
			categoryId: draft.categoryId
		});
		return { rows, photoIndex: rows.length - 1 };
	}
	return { rows, photoIndex: 0 };
}

/**
 * A refused row's messages on the review form (the first per field wins): a split item's category and amount on
 * that item (`item`: its index; null for the receipt's own row), the amount otherwise on the total, the rest on
 * their own fields.
 */
function addRowErrors(
	errors: ReceiptFieldErrors,
	rowErrors: FieldErrors,
	item: number | null
): void {
	const field = item === null ? null : `item.${item}`;
	for (const [name, message] of Object.entries(rowErrors)) {
		if (name === 'categoryId' && field) errors[field] ??= message;
		else if (name === 'amountMinor') errors[field ?? 'total'] ??= message;
		else errors[name] ??= message;
	}
}

/** Imported-style rows carry no printed time: noon WIB on their date, or the save instant for today's receipt. */
const RECEIPT_TIME = '12:00';

export type SaveReceiptResult =
	| { ok: true; ids: string[]; photoId: string | null }
	| { ok: false; reason: 'invalid'; errors: ReceiptFieldErrors }
	| { ok: false; reason: 'already' | 'gone' | 'limit' };

/**
 * Writes a reviewed receipt: every row or none, in one `db.batch`, only while no row of this photo exists yet in
 * the space (`photoAlreadySaved` inside the insert, so a resent or concurrent save writes nothing twice and a
 * deleted row is never recreated). With `photo` (already uploaded and reserved), the photo's row takes the key in
 * the same batch and the reservation is dropped only when it holds it (photos/store.ts `keepKey`).
 */
export async function saveReceiptTransactions(
	db: Db,
	scope: SpaceScope,
	draft: ReceiptDraft,
	keyPrefix: string,
	photo: StoredPhoto | null,
	t: Translator,
	now: number,
	today: string
): Promise<SaveReceiptResult> {
	const { spaceId } = scope;
	const [wallet, categories] = await Promise.all([
		getWallet(db, spaceId, draft.walletId),
		listCategories(db, spaceId)
	]);
	const visible = new Map(categories.map((c) => [c.id, c]));
	const { rows: planned, photoIndex } = plannedRows(draft, t);
	const errors: ReceiptFieldErrors = {};
	if (!wallet) errors.walletId = WALLET_NOT_FOUND;
	const occurredAt =
		draft.occurredOn === today ? now : wibInstantUtcMs(draft.occurredOn, RECEIPT_TIME);
	const rows: NewTransaction[] = [];
	for (const row of planned) {
		const category = visible.get(row.categoryId);
		const checked = capturedTransactionInput(
			{
				type: 'expense',
				amountMinor: row.amountMinor,
				currency: 'IDR',
				walletId: wallet?.id ?? null,
				categoryId: row.categoryId || null,
				title: row.title,
				note: row.note,
				occurredOn: draft.occurredOn
			},
			{
				wallet: wallet ? { id: wallet.id, currency: wallet.currency } : null,
				toWallet: null,
				category: category ? { id: category.id, kind: category.kind } : null
			}
		);
		if (!checked.ok) {
			const item = draft.mode === 'split' && row.index < draft.items.length ? row.index : null;
			addRowErrors(errors, checked.errors, item);
			continue;
		}
		rows.push({
			id: newId(),
			input: checked.value,
			origin: { source: 'receipt', dedupeKey: `${keyPrefix}${row.index}`, occurredAt },
			extras: { paymentMethod: draft.paymentMethod, recurrence: null, tag: null, reference: null }
		});
	}
	if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

	const photoId = photo ? (rows[photoIndex]?.id ?? null) : null;
	const ids = rows.map((r) => r.id);
	const allWritten = batchAssert(
		db,
		sql`(select count(*) from transactions t where t.space_id = ${spaceId}
			and t.id in (select value from json_each(${JSON.stringify(ids)}))) = ${rows.length}`
	);
	const insert = insertTransactions(
		db,
		scope,
		rows,
		now,
		() => sql`not ${photoAlreadySaved(spaceId, keyPrefix)}`
	);
	try {
		if (photo && photoId) {
			await db.batch([
				bumpSpaceSeq(db, spaceId),
				insert,
				allWritten,
				...attachPhoto(db, spaceId, photoId, photo, now)
			]);
		} else await db.batch([bumpSpaceSeq(db, spaceId), insert, allWritten]);
		return { ok: true, ids, photoId };
	} catch (e) {
		if (!isBatchAssertFailure(e) && !isUniqueViolation(e)) throw e;
	}
	// Nothing was written. Why: this photo was saved before, the space is full, or a wallet, category or the
	// membership went meanwhile.
	const [already] = await db.all<{ n: number }>(
		sql`select ${photoAlreadySaved(spaceId, keyPrefix)} as n`
	);
	if (already?.n) return { ok: false, reason: 'already' };
	if (await transactionCapReached(db, spaceId, rows.length)) return { ok: false, reason: 'limit' };
	return { ok: false, reason: 'gone' };
}
