import { z } from 'zod';
import { isDateString } from '#lib/shared/dates';
import type { Locale } from '#lib/shared/i18n';
import {
	isValidRecurringSchedule,
	RECURRING_FREQUENCIES,
	RECURRING_TYPES,
	restartRunOn,
	type RecurringFormValues,
	type RecurringSchedule,
	type RecurringType
} from '#lib/shared/recurring';
import { cleanText } from '#lib/shared/text';
import { NOTE_MAX_LENGTH, TITLE_MAX_LENGTH } from '#lib/shared/transactions';
import { getCategory } from '../categories/repo';
import type { Db } from '../db';
import { amountRefusal, textField } from '../forms';
import {
	AMOUNT_INVALID,
	AMOUNT_INVALID_CENTS,
	AMOUNT_TOO_LARGE,
	CATEGORY_KIND_MISMATCH,
	CATEGORY_NOT_FOUND,
	CATEGORY_REQUIRED,
	WALLET_NOT_FOUND,
	WALLET_REQUIRED
} from '../transactions/messages';
import { composeAmountMinor, ID_MAX_LENGTH, MAX_AMOUNT_MINOR } from '../transactions/validation';
import { getWallet } from '../wallets/repo';
import {
	DAY_INVALID,
	END_BEFORE_FIRST,
	END_INVALID,
	FREQUENCY_INVALID,
	START_INVALID,
	TYPE_INVALID,
	WEEKDAY_INVALID
} from './messages';

/**
 * What a typed amount may contain before its wallet (and so its currency) is known: digits, `.`/`,` separators
 * and spaces, with a non-zero digit. `composeAmountMinor` reads it once the currency is known (FN-47).
 */
const AMOUNT_TEXT = /^[\d., ]*$/;
/** A small whole number as a select posts it. */
const SMALL_INT = /^\d{1,2}$/;
/** An `updated_at` (epoch ms) as the form carries it. */
const UPDATED_AT = /^\d{1,15}$/;

const id = z.string().max(ID_MAX_LENGTH);

/** The series form after shape checks, before its ids are looked up in the space (FN-36). */
const draftSchema = z
	.object({
		type: z.enum(RECURRING_TYPES, { error: TYPE_INVALID }),
		amountText: z.string().regex(AMOUNT_TEXT, AMOUNT_INVALID).regex(/[1-9]/, AMOUNT_INVALID),
		walletId: id.min(1, WALLET_REQUIRED),
		categoryId: id.min(1, CATEGORY_REQUIRED),
		title: z.string().max(TITLE_MAX_LENGTH).nullable(),
		note: z.string().max(NOTE_MAX_LENGTH).nullable(),
		frequency: z.enum(RECURRING_FREQUENCIES, { error: FREQUENCY_INVALID }),
		day: z.number().int(),
		startOn: z.string().refine(isDateString, START_INVALID),
		endOn: z.string().refine(isDateString, END_INVALID).nullable()
	})
	.superRefine((d, ctx) => {
		if (!isValidRecurringSchedule({ frequency: d.frequency, day: d.day }))
			ctx.addIssue({
				code: 'custom',
				path: ['day'],
				message: d.frequency === 'weekly' ? WEEKDAY_INVALID : DAY_INVALID
			});
	});
/** `locale`: the UI language the form was shown in, whose separators the amount is read with (FN-47). */
export type RecurringDraft = z.infer<typeof draftSchema> & { locale: Locale };
type RecurringField = Exclude<keyof RecurringDraft, 'locale'> | 'amountMinor';
export type RecurringErrors = Partial<Record<RecurringField, string>>;

/** A validated series template and schedule, its ids resolved inside the space. */
export interface RecurringInput {
	type: RecurringType;
	amountMinor: number;
	currency: string;
	walletId: string;
	categoryId: string;
	title: string | null;
	note: string | null;
	schedule: RecurringSchedule;
	startOn: string;
	endOn: string | null;
}

/** The form's fields as typed, each cut to a bounded length before any work. */
function recurringFormValues(form: FormData): RecurringFormValues {
	return {
		type: textField(form, 'type').slice(0, 16),
		amount: textField(form, 'amount').slice(0, 64),
		walletId: textField(form, 'walletId').slice(0, ID_MAX_LENGTH + 1),
		categoryId: textField(form, 'categoryId').slice(0, ID_MAX_LENGTH + 1),
		title: textField(form, 'title').slice(0, TITLE_MAX_LENGTH * 4),
		note: textField(form, 'note').slice(0, NOTE_MAX_LENGTH * 4),
		frequency: textField(form, 'frequency').slice(0, 16),
		day: textField(form, 'day').slice(0, 4),
		weekday: textField(form, 'weekday').slice(0, 4),
		startOn: textField(form, 'startOn').slice(0, 16),
		endOn: textField(form, 'endOn').slice(0, 16)
	};
}

export type ParsedRecurringForm =
	| { ok: true; draft: RecurringDraft; values: RecurringFormValues }
	| { ok: false; errors: RecurringErrors; values: RecurringFormValues };

/**
 * Shape checks of the add/edit series form: expense or income, an amount of digits and separators (read with
 * the wallet's currency and `locale` by resolveRecurringInput; never `parseFloat`),
 * ids of bounded length, title/note stripped of control and zero-width characters and capped (80/500, as a
 * transaction), monthly with a day 1–31 or weekly with an ISO weekday 1–7 (only the chosen frequency's field is
 * read), a real start date and an optional end date that is not before the first run on or after `today`.
 */
export function parseRecurringForm(
	form: FormData,
	today: string,
	locale: Locale
): ParsedRecurringForm {
	const values = recurringFormValues(form);
	const errors: RecurringErrors = {};
	const dayText = values.frequency === 'weekly' ? values.weekday : values.day;
	const parsed = draftSchema.safeParse({
		type: values.type,
		amountText: values.amount,
		walletId: values.walletId,
		categoryId: values.categoryId,
		title: cleanText(values.title, TITLE_MAX_LENGTH) || null,
		note: cleanText(values.note, NOTE_MAX_LENGTH) || null,
		frequency: values.frequency,
		day: SMALL_INT.test(dayText) ? Number(dayText) : 0,
		startOn: values.startOn,
		endOn: values.endOn || null
	});
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const key = issue.path[0] as Exclude<RecurringField, 'amountMinor'>;
			errors[key === 'amountText' ? 'amountMinor' : key] ??= issue.message;
		}
		return { ok: false, errors, values };
	}
	const d = { ...parsed.data, locale };
	if (
		d.endOn !== null &&
		d.endOn < restartRunOn({ frequency: d.frequency, day: d.day }, d.startOn, today)
	)
		errors.endOn = END_BEFORE_FIRST;
	if (Object.keys(errors).length > 0) return { ok: false, errors, values };
	return { ok: true, draft: d, values };
}

/** What the action found for the draft's ids in the space: a live wallet, a visible category. */
export interface RecurringRefs {
	wallet: { id: string; currency: string } | null;
	category: { id: string; kind: 'expense' | 'income' } | null;
}

/** The draft checked against its ids; the amount read with the wallet's currency (cents or not, FN-47). */
export function resolveRecurringInput(
	draft: RecurringDraft,
	refs: RecurringRefs
): { ok: true; value: RecurringInput } | { ok: false; errors: RecurringErrors } {
	const errors: RecurringErrors = {};
	const { wallet, category } = refs;
	if (!wallet) errors.walletId = WALLET_NOT_FOUND;
	if (!category) errors.categoryId = CATEGORY_NOT_FOUND;
	else if (category.kind !== draft.type) errors.categoryId = CATEGORY_KIND_MISMATCH;
	if (!wallet || !category || Object.keys(errors).length > 0) return { ok: false, errors };
	const amountMinor = composeAmountMinor(draft.amountText, wallet.currency, draft.locale);
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
			categoryId: category.id,
			title: draft.title,
			note: draft.note,
			schedule: { frequency: draft.frequency, day: draft.day },
			startOn: draft.startOn,
			endOn: draft.endOn
		}
	};
}

/**
 * The series form → an input whose ids are looked up inside `spaceId` only (another space's id finds nothing,
 * like an unknown one): a live wallet and a visible category, since the cron could not write with anything else.
 */
export async function readRecurringForm(
	db: Db,
	spaceId: string,
	form: FormData,
	today: string,
	locale: Locale
): Promise<
	| { ok: true; input: RecurringInput }
	| { ok: false; errors: RecurringErrors; values: RecurringFormValues }
> {
	const parsed = parseRecurringForm(form, today, locale);
	if (!parsed.ok) return parsed;
	const [wallet, category] = await Promise.all([
		getWallet(db, spaceId, parsed.draft.walletId),
		getCategory(db, spaceId, parsed.draft.categoryId)
	]);
	const resolved = resolveRecurringInput(parsed.draft, {
		wallet: wallet ? { id: wallet.id, currency: wallet.currency } : null,
		category: category && !category.isHidden ? { id: category.id, kind: category.kind } : null
	});
	return resolved.ok
		? { ok: true, input: resolved.value }
		: { ok: false, errors: resolved.errors, values: parsed.values };
}

/** The `updated_at` the form was loaded with; -1 (matches nothing, so "changed meanwhile") when malformed. */
export function expectedUpdatedAt(form: FormData): number {
	const value = textField(form, 'updatedAt');
	return UPDATED_AT.test(value) ? Number(value) : -1;
}

/** An id from a route or field: '' when over-long (matches nothing). */
export const boundedId = (value: string) => (value.length > ID_MAX_LENGTH ? '' : value);
