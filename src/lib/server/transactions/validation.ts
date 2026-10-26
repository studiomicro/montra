import { z } from 'zod';
import { isDateString, isTimeString } from '#lib/shared/dates';
import type { Locale } from '#lib/shared/i18n';
import { MAX_AMOUNT_MINOR } from '#lib/shared/money-parse';
import { cleanText } from '#lib/shared/text';
import {
	FORM_TRANSACTION_TYPES,
	NOTE_MAX_LENGTH,
	TITLE_MAX_LENGTH,
	type AdjustmentDirection,
	type AdjustmentFormValues,
	type CategoryKind,
	type TransactionFormValues,
	type TransactionType
} from '#lib/shared/transactions';
import { amountMinorFromText, amountRefusal, textField } from '../forms';
import {
	ADJUSTMENT_SAME,
	ADJUSTMENT_TOO_LARGE,
	AMOUNT_INVALID,
	AMOUNT_INVALID_CENTS,
	BALANCE_INVALID,
	AMOUNT_TOO_LARGE,
	CATEGORY_KIND_MISMATCH,
	CATEGORY_NOT_FOUND,
	CATEGORY_REQUIRED,
	CURRENCY_MISMATCH,
	DATE_INVALID,
	TIME_INVALID,
	TRANSFER_CURRENCY,
	TRANSFER_SAME_WALLET,
	TRANSFER_TO_REQUIRED,
	TYPE_INVALID,
	WALLET_NOT_FOUND,
	WALLET_REQUIRED
} from './messages';

/** Longest id read from a form; ids are UUIDs, anything longer cannot match. */
export const ID_MAX_LENGTH = 64;
// The bound lives with the shared money parser so statement rows (FN-16a) use the same one.
export { MAX_AMOUNT_MINOR };
/**
 * What a typed amount may contain before its wallet (and so its currency) is known: digits, `.`/`,` separators
 * and spaces, with at least one non-zero digit. `composeAmountMinor` reads it once the currency is known.
 */
const AMOUNT_TEXT = /^[\d., ]*$/;
/**
 * A compose/edit (and recurring, voice) form's typed amount → positive minor units of `currency`, or null when
 * it is not one. Every currency follows the shared amount contract (`amountMinorFromText`): IDR and JPY take
 * plain digits or `.` grouping in exact groups of three (`25000`, `1.250.000`), at most 13 digits; a currency
 * with cents reads `locale`'s separators with at most two fraction digits, never rounded. Red team FN-47 L2:
 * `.` is no longer dropped anywhere in a whole-unit amount, so an en `12.50` reaching an IDR or JPY wallet (a
 * no-JS wallet switch, a queued create) is refused, never stored ×100. Never `parseFloat`.
 */
export function composeAmountMinor(text: string, currency: string, locale: Locale): number | null {
	return amountMinorFromText(text, currency, locale) || null;
}

const id = z.string().max(ID_MAX_LENGTH);

/**
 * A transaction's fields after shape checks, before its ids are looked up in the space. The form adds the typed
 * amount (`draftSchema`); a stored capture (`capturedTransactionInput`) brings its exact minor amount instead.
 */
const fieldsSchema = z.object({
	// A balance adjustment has its own form and entry point (FN-37): never written through this one.
	type: z.enum(FORM_TRANSACTION_TYPES, { error: TYPE_INVALID }),
	walletId: id.min(1, WALLET_REQUIRED),
	transferToWalletId: id.nullable(),
	categoryId: id.nullable(),
	title: z.string().max(TITLE_MAX_LENGTH).nullable(),
	note: z.string().max(NOTE_MAX_LENGTH).nullable(),
	occurredOn: z.string().refine(isDateString, DATE_INVALID),
	occurredTime: z.string().refine(isTimeString, TIME_INVALID).nullable()
});

/** The form after shape checks, before its ids are looked up in the space. */
const draftSchema = fieldsSchema.extend({
	amountText: z.string().regex(AMOUNT_TEXT, AMOUNT_INVALID).regex(/[1-9]/, AMOUNT_INVALID)
});
/**
 * `amountText`: the typed amount, read with the wallet's currency and the form's `locale` once the wallet is
 * known (FN-47). `exactAmountMinor`: set only by the public API (FN-38), which sends the amount as integer
 * minor units of the wallet's currency; it then replaces the typed amount (`amountText` is '' and never read).
 */
export type TransactionDraft = z.infer<typeof draftSchema> & {
	locale: Locale;
	exactAmountMinor?: number;
};
type TransactionField = Exclude<keyof TransactionDraft, 'locale'> | 'amountMinor';
export type FieldErrors = Partial<Record<TransactionField, string>>;

export type ParsedTransactionForm =
	| { ok: true; draft: TransactionDraft; values: TransactionFormValues }
	| { ok: false; errors: FieldErrors; values: TransactionFormValues };

/** The form's fields as typed, each cut to a bounded length before any work. */
export function transactionFormValues(form: FormData): TransactionFormValues {
	return {
		type: textField(form, 'type').slice(0, 16),
		amount: textField(form, 'amount').slice(0, 64),
		walletId: textField(form, 'walletId').slice(0, ID_MAX_LENGTH + 1),
		transferToWalletId: textField(form, 'transferToWalletId').slice(0, ID_MAX_LENGTH + 1),
		categoryId: textField(form, 'categoryId').slice(0, ID_MAX_LENGTH + 1),
		title: textField(form, 'title').slice(0, TITLE_MAX_LENGTH * 4),
		note: textField(form, 'note').slice(0, NOTE_MAX_LENGTH * 4),
		occurredOn: textField(form, 'occurredOn').slice(0, 16),
		occurredTime: textField(form, 'occurredTime').trim().slice(0, 8)
	};
}

/**
 * Shape checks of the compose/edit form: type, an amount of digits and separators (read with the wallet's
 * currency and `locale` by resolveTransactionInput; never `parseFloat`), ids of bounded length, title/note stripped of control and zero-width characters and capped (80/500), a real WIB date and
 * an optional `HH:MM` time. Fields that do not apply to the type (a category on a transfer, a destination on
 * an expense) are dropped, not refused, because the form keeps them in the page while hidden.
 */
export function parseTransactionForm(
	form: FormData,
	locale: Locale,
	exactAmountMinor?: number
): ParsedTransactionForm {
	const values = transactionFormValues(form);
	const errors: FieldErrors = {};
	const exact = exactAmountMinor !== undefined;
	if (exact) {
		const amountError = exactAmountError(exactAmountMinor);
		if (amountError) errors.amountMinor = amountError;
	}
	const isTransfer = values.type === 'transfer';
	const parsed = (
		exact ? fieldsSchema.extend({ amountText: z.literal('') }) : draftSchema
	).safeParse({
		type: values.type,
		amountText: exact ? '' : values.amount,
		walletId: values.walletId,
		transferToWalletId: isTransfer ? values.transferToWalletId || null : null,
		categoryId: isTransfer ? null : values.categoryId || null,
		title: cleanText(values.title, TITLE_MAX_LENGTH) || null,
		note: cleanText(values.note, NOTE_MAX_LENGTH) || null,
		occurredOn: values.occurredOn,
		occurredTime: values.occurredTime || null
	});
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const key = issue.path[0] as Exclude<TransactionField, 'amountMinor'>;
			const field: TransactionField = key === 'amountText' ? 'amountMinor' : key;
			errors[field] ??= issue.message;
		}
	}
	if (parsed.success && isTransfer && !parsed.data.transferToWalletId)
		errors.transferToWalletId = TRANSFER_TO_REQUIRED;
	if (parsed.success && !isTransfer && !parsed.data.categoryId)
		errors.categoryId = CATEGORY_REQUIRED;
	if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors, values };
	return {
		ok: true,
		draft: exact ? { ...parsed.data, locale, exactAmountMinor } : { ...parsed.data, locale },
		values
	};
}

/**
 * The rule for an amount given exactly in minor units (a stored capture, FN-11; a public-API write, FN-38):
 * a safe integer from 1 to MAX_AMOUNT_MINOR. Sen are kept, never re-read from whole units. Null when it holds.
 */
function exactAmountError(amount: number): string | null {
	if (!Number.isSafeInteger(amount) || amount <= 0) return AMOUNT_INVALID;
	if (amount > MAX_AMOUNT_MINOR) return AMOUNT_TOO_LARGE;
	return null;
}

/** A validated transaction, its ids resolved inside the space and its amount in the wallet's minor units. */
export interface TransactionInput {
	type: TransactionType;
	amountMinor: number;
	currency: string;
	walletId: string;
	transferToWalletId: string | null;
	categoryId: string | null;
	/** Only on a balance adjustment (FN-37), which carries its sign here; absent or null otherwise. */
	adjustmentDirection?: AdjustmentDirection | null;
	title: string | null;
	note: string | null;
	occurredOn: string;
	/** WIB `HH:MM`, or null: keep the stored instant (edit) or use the save time (create, owner decision F). */
	occurredTime: string | null;
}

/** What the action found for the draft's ids in the current space (null: not there, or not allowed). */
export interface DraftRefs {
	wallet: { id: string; currency: string } | null;
	toWallet: { id: string; currency: string } | null;
	category: { id: string; kind: CategoryKind } | null;
}

/** What is wrong with the ids a transaction names, given what they point at in the space. */
function refErrors(
	draft: Pick<TransactionDraft, 'type' | 'walletId' | 'transferToWalletId'>,
	refs: DraftRefs
): FieldErrors {
	const errors: FieldErrors = {};
	const { wallet, toWallet, category } = refs;
	if (!wallet) errors.walletId = WALLET_NOT_FOUND;
	if (draft.type === 'transfer') {
		if (draft.transferToWalletId === draft.walletId)
			errors.transferToWalletId = TRANSFER_SAME_WALLET;
		else if (!toWallet) errors.transferToWalletId = WALLET_NOT_FOUND;
		else if (wallet && toWallet.currency !== wallet.currency)
			errors.transferToWalletId = TRANSFER_CURRENCY;
	} else if (!category) errors.categoryId = CATEGORY_NOT_FOUND;
	else if (category.kind !== draft.type) errors.categoryId = CATEGORY_KIND_MISMATCH;
	return errors;
}

/** A stored capture (an FN-11 draft) as `capturedTransactionInput` reads it. */
export interface CapturedFields {
	type: CategoryKind;
	amountMinor: number;
	currency: string;
	walletId: string | null;
	categoryId: string | null;
	title: string | null;
	note: string | null;
	occurredOn: string;
}

/**
 * A captured row checked by the same schema and id rules as the compose form (never a second schema): an
 * expense or income with a wallet and a category of its kind, title/note cleaned and capped, a real date. The
 * amount is the capture's exact minor amount (sen kept, never re-read from whole-unit digits), 1 … MAX, in the
 * wallet's own currency. `occurredTime` is null: the caller stores the captured instant verbatim.
 */
export function capturedTransactionInput(
	captured: CapturedFields,
	refs: DraftRefs,
	/**
	 * `allowNoCategory` (FN-17 spreadsheet rows only): a row with no category id and no category ref is accepted
	 * as "Tanpa kategori" (`category_id` null, schema.ts); a category that is named must still exist and match.
	 */
	opts: { allowNoCategory?: boolean } = {}
): { ok: true; value: TransactionInput } | { ok: false; errors: FieldErrors } {
	const errors: FieldErrors = {};
	const noCategory = opts.allowNoCategory === true && !captured.categoryId && !refs.category;
	const parsed = fieldsSchema.safeParse({
		type: captured.type,
		walletId: captured.walletId ?? '',
		transferToWalletId: null,
		categoryId: captured.categoryId,
		title: cleanText(captured.title ?? '', TITLE_MAX_LENGTH) || null,
		note: cleanText(captured.note ?? '', NOTE_MAX_LENGTH) || null,
		occurredOn: captured.occurredOn,
		occurredTime: null
	});
	if (!parsed.success) {
		for (const issue of parsed.error.issues)
			errors[issue.path[0] as TransactionField] ??= issue.message;
	}
	if (!captured.categoryId && !noCategory) errors.categoryId ??= CATEGORY_REQUIRED;
	const amount = captured.amountMinor;
	const amountError = exactAmountError(amount);
	if (amountError) errors.amountMinor = amountError;
	if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors };
	const refErr = refErrors(parsed.data, refs);
	if (noCategory) delete refErr.categoryId;
	const { wallet, category } = refs;
	if (wallet && wallet.currency !== captured.currency) refErr.walletId = CURRENCY_MISMATCH;
	if (!wallet || (!category && !noCategory) || Object.keys(refErr).length > 0)
		return { ok: false, errors: refErr };
	return {
		ok: true,
		value: {
			type: captured.type,
			amountMinor: amount,
			currency: wallet.currency,
			walletId: wallet.id,
			transferToWalletId: null,
			categoryId: category?.id ?? null,
			title: parsed.data.title,
			note: parsed.data.note,
			occurredOn: parsed.data.occurredOn,
			occurredTime: null
		}
	};
}

/**
 * The draft checked against what its ids point at: the wallet (and, for a transfer, the different destination
 * wallet of the same currency, owner decision E) and a category of the type's kind. The amount is read with
 * the wallet's currency exponent; `currency` is always the wallet's.
 */
export function resolveTransactionInput(
	draft: TransactionDraft,
	refs: DraftRefs
): { ok: true; value: TransactionInput } | { ok: false; errors: FieldErrors } {
	const errors = refErrors(draft, refs);
	const { wallet, toWallet, category } = refs;
	if (!wallet || Object.keys(errors).length > 0) return { ok: false, errors };
	const amountMinor =
		draft.exactAmountMinor ?? composeAmountMinor(draft.amountText, wallet.currency, draft.locale);
	if (amountMinor === null || amountMinor <= 0 || !Number.isSafeInteger(amountMinor)) {
		const refusal = amountRefusal(wallet.currency, AMOUNT_INVALID, AMOUNT_INVALID_CENTS);
		return { ok: false, errors: { amountMinor: refusal } };
	}
	if (amountMinor > MAX_AMOUNT_MINOR)
		return { ok: false, errors: { amountMinor: AMOUNT_TOO_LARGE } };
	return {
		ok: true,
		value: {
			type: draft.type,
			amountMinor,
			currency: wallet.currency,
			walletId: wallet.id,
			transferToWalletId: draft.type === 'transfer' ? (toWallet?.id ?? null) : null,
			categoryId: draft.type === 'transfer' ? null : (category?.id ?? null),
			title: draft.title,
			note: draft.note,
			occurredOn: draft.occurredOn,
			occurredTime: draft.occurredTime
		}
	};
}

/** The fields an adjustment keeps editable (FN-37 owner decision A: amount, direction and wallet are fixed). */
const adjustmentEditSchema = fieldsSchema.pick({
	title: true,
	note: true,
	occurredOn: true,
	occurredTime: true
});
/** The adjustment form after shape checks: the edit fields plus the wallet and the stated balance. */
const adjustmentSchema = adjustmentEditSchema.extend({ walletId: fieldsSchema.shape.walletId });

export type AdjustmentEdit = z.infer<typeof adjustmentEditSchema>;
/** `balance`: the typed text, read with the wallet's currency and `locale` once the wallet is known. */
export type AdjustmentDraft = z.infer<typeof adjustmentSchema> & {
	balance: string;
	negative: boolean;
	locale: Locale;
};

/** The adjustment form's fields as typed, each cut to a bounded length before any work. */
function adjustmentFormValues(form: FormData): AdjustmentFormValues {
	return {
		walletId: textField(form, 'walletId').slice(0, ID_MAX_LENGTH + 1),
		balance: textField(form, 'balance').slice(0, 64),
		negative: textField(form, 'negative') === 'on',
		title: textField(form, 'title').slice(0, TITLE_MAX_LENGTH * 4),
		note: textField(form, 'note').slice(0, NOTE_MAX_LENGTH * 4),
		occurredOn: textField(form, 'occurredOn').slice(0, 16),
		occurredTime: textField(form, 'occurredTime').trim().slice(0, 8)
	};
}

/** What a stated balance may contain before the wallet's currency is known (blank is 0). */
const BALANCE_TEXT = /^[\d., ]*$/;

function issuesToErrors(issues: readonly z.core.$ZodIssue[]): FieldErrors {
	const errors: FieldErrors = {};
	for (const issue of issues) errors[issue.path[0] as TransactionField] ??= issue.message;
	return errors;
}

function editFields(
	values: Pick<AdjustmentFormValues, 'title' | 'note' | 'occurredOn' | 'occurredTime'>
) {
	return {
		title: cleanText(values.title, TITLE_MAX_LENGTH) || null,
		note: cleanText(values.note, NOTE_MAX_LENGTH) || null,
		occurredOn: values.occurredOn,
		occurredTime: values.occurredTime || null
	};
}

/**
 * Shape checks of the "Penyesuaian saldo" form (FN-37): a wallet id, the new balance as digits and separators
 * (read with the wallet's currency and `locale` by statedBalanceMinor; an empty field is 0, like the wallet's
 * "Saldo awal"; negative when `negative` is ticked; never `parseFloat`), title/note cleaned and capped, a real
 * WIB date and an optional `HH:MM` time. The wallet's balance is not read here.
 */
export function parseAdjustmentForm(
	form: FormData,
	locale: Locale
):
	| { ok: true; draft: AdjustmentDraft; values: AdjustmentFormValues }
	| { ok: false; errors: FieldErrors; values: AdjustmentFormValues } {
	const values = adjustmentFormValues(form);
	const parsed = adjustmentSchema.safeParse({ walletId: values.walletId, ...editFields(values) });
	const errors = parsed.success ? {} : issuesToErrors(parsed.error.issues);
	// Only the shape is checked here; the wallet's own currency decides the reading (cents or not) later.
	if (!BALANCE_TEXT.test(values.balance)) errors.amountMinor = BALANCE_INVALID;
	if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors, values };
	return {
		ok: true,
		draft: { ...parsed.data, balance: values.balance, negative: values.negative, locale },
		values
	};
}

/** Shape checks of an adjustment's edit form: only title, note, date and time are read (owner decision A). */
export function parseAdjustmentEdit(
	form: FormData
):
	| { ok: true; edit: AdjustmentEdit }
	| { ok: false; errors: FieldErrors; values: AdjustmentFormValues } {
	const values = adjustmentFormValues(form);
	const parsed = adjustmentEditSchema.safeParse(editFields(values));
	return parsed.success
		? { ok: true, edit: parsed.data }
		: { ok: false, errors: issuesToErrors(parsed.error.issues), values };
}

/** The stated balance in the wallet's minor units (signed); null when the text is not an amount of it. */
export function statedBalanceMinor(
	draft: Pick<AdjustmentDraft, 'balance' | 'negative' | 'locale'>,
	currency: string
) {
	const minor = amountMinorFromText(draft.balance, currency, draft.locale);
	return draft.negative && minor !== null && minor > 0 ? -minor : minor;
}

/**
 * The adjustment that takes a wallet from `currentMinor` (its balance read at submit time, exact) to
 * `statedMinor`: the difference as a positive magnitude and its direction. `same` when there is no
 * difference (no row is ever written for 0), `too_large` past MAX_AMOUNT_MINOR (the row's own bound).
 */
export function adjustmentFor(
	statedMinor: number,
	currentMinor: bigint
):
	| { ok: true; amountMinor: number; direction: AdjustmentDirection }
	| { ok: false; error: typeof ADJUSTMENT_SAME | typeof ADJUSTMENT_TOO_LARGE } {
	const diff = BigInt(statedMinor) - currentMinor;
	if (diff === 0n) return { ok: false, error: ADJUSTMENT_SAME };
	const magnitude = diff < 0n ? -diff : diff;
	if (magnitude > BigInt(MAX_AMOUNT_MINOR)) return { ok: false, error: ADJUSTMENT_TOO_LARGE };
	return {
		ok: true,
		amountMinor: Number(magnitude),
		direction: diff > 0n ? 'increase' : 'decrease'
	};
}
