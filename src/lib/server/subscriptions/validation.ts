import { isDateString } from '#lib/shared/dates';
import type { Locale } from '#lib/shared/i18n';
import {
	BILLING_CYCLES,
	isValidSchedule,
	REMINDER_DAYS_DEFAULT,
	REMINDER_DAYS_MAX,
	SUBSCRIPTION_NAME_MAX_LENGTH,
	type BillingCycle,
	type BillingSchedule,
	type SubscriptionFormValues
} from '#lib/shared/subscriptions';
import {
	catalogueEntry,
	isSubscriptionCategory,
	type SubscriptionCategory
} from '#lib/shared/subscriptions-catalogue';
import { cleanText } from '#lib/shared/text';
import { WALLET_CURRENCIES } from '#lib/shared/wallets';
import { amountMinorFromText, amountRefusal, textField } from '../forms';
import { MAX_AMOUNT_MINOR } from '../transactions/validation';
import {
	AMOUNT_INVALID,
	AMOUNT_INVALID_CENTS,
	AMOUNT_TOO_LARGE,
	CATALOGUE_INVALID,
	CATEGORY_INVALID,
	CURRENCY_INVALID,
	CYCLE_INVALID,
	DAY_INVALID,
	MONTH_INVALID,
	NAME_INVALID,
	PAY_MODE_INVALID,
	REMINDER_INVALID,
	WEEKDAY_INVALID
} from './messages';

/** Longest id read from a form; ids are UUIDs (catalogue ids are shorter), anything longer cannot match. */
export const ID_MAX_LENGTH = 64;
/** An `updated_at` (epoch ms) as the form carries it. */
const UPDATED_AT = /^\d{1,15}$/;
/** A small whole number as a select posts it (`1`–`31`). */
const SMALL_INT = /^\d{1,2}$/;

/** A validated subscription, before its wallet is checked inside the space. */
export interface SubscriptionInput {
	catalogueId: string | null;
	name: string;
	category: SubscriptionCategory;
	amountMinor: number;
	currency: string;
	schedule: BillingSchedule;
	walletId: string | null;
	reminderDaysBefore: number;
}

export type SubscriptionField =
	| 'catalogueId'
	| 'name'
	| 'category'
	| 'amountMinor'
	| 'currency'
	| 'cycle'
	| 'day'
	| 'weekday'
	| 'month'
	| 'walletId'
	| 'reminderDays';
export type SubscriptionErrors = Partial<Record<SubscriptionField, string>>;

export type ParsedSubscriptionForm =
	| { ok: true; value: SubscriptionInput; values: SubscriptionFormValues }
	| { ok: false; errors: SubscriptionErrors; values: SubscriptionFormValues };

/** The form's fields as typed, each cut to a bounded length before any work (echoed back when refused). */
export function subscriptionFormValues(form: FormData): SubscriptionFormValues {
	return {
		catalogueId: textField(form, 'catalogueId').slice(0, ID_MAX_LENGTH + 1),
		name: textField(form, 'name').slice(0, SUBSCRIPTION_NAME_MAX_LENGTH * 4),
		category: textField(form, 'category').slice(0, 32),
		amount: textField(form, 'amount').slice(0, 64),
		currency: textField(form, 'currency').slice(0, 8) || 'IDR',
		cycle: textField(form, 'cycle').slice(0, 16),
		day: textField(form, 'day').slice(0, 4),
		weekday: textField(form, 'weekday').slice(0, 4),
		month: textField(form, 'month').slice(0, 4),
		walletId: textField(form, 'walletId').slice(0, ID_MAX_LENGTH + 1),
		reminderDays: textField(form, 'reminderDays').slice(0, 4)
	};
}

const smallInt = (text: string) => (SMALL_INT.test(text) ? Number(text) : null);

/**
 * The add/edit subscription form → a validated subscription, or field errors (msg() phrases). A catalogue id
 * must be one of ours (`SUBSCRIPTION_CATALOGUE`); a blank name or category then falls back to the entry's.
 * The name is stripped of control and zero-width characters, 1–60 characters. The amount follows the shared
 * amount contract (`amountMinorFromText`: `locale`'s separators, cents for every currency but IDR and JPY, never
 * parseFloat) in the chosen currency, 1 … MAX_AMOUNT_MINOR. Only the day field of the chosen cycle is read: day of month (monthly),
 * ISO weekday (weekly), month + day (yearly; 29 February allowed, clamped in other years). Blank reminder days
 * = REMINDER_DAYS_DEFAULT.
 */
export function parseSubscriptionForm(form: FormData, locale: Locale): ParsedSubscriptionForm {
	const values = subscriptionFormValues(form);
	const errors: SubscriptionErrors = {};

	let catalogueId: string | null = null;
	const entry = values.catalogueId === '' ? null : catalogueEntry(values.catalogueId);
	if (values.catalogueId !== '' && !entry) errors.catalogueId = CATALOGUE_INVALID;
	else if (entry) catalogueId = entry.id;

	// One code point past the cap is kept, so an over-long name is refused, never silently cut.
	const typed = cleanText(values.name, SUBSCRIPTION_NAME_MAX_LENGTH + 1);
	const name = typed === '' && entry ? entry.name : typed;
	if (name === '' || Array.from(name).length > SUBSCRIPTION_NAME_MAX_LENGTH)
		errors.name = NAME_INVALID;

	const categoryText = values.category === '' && entry ? entry.category : values.category;
	const category = isSubscriptionCategory(categoryText) ? categoryText : null;
	if (!category) errors.category = CATEGORY_INVALID;

	const currencyOk = (WALLET_CURRENCIES as readonly string[]).includes(values.currency);
	if (!currencyOk) errors.currency = CURRENCY_INVALID;
	const amountMinor = amountMinorFromText(
		values.amount,
		currencyOk ? values.currency : 'IDR',
		locale
	);
	if (amountMinor === null || amountMinor <= 0)
		errors.amountMinor = currencyOk
			? amountRefusal(values.currency, AMOUNT_INVALID, AMOUNT_INVALID_CENTS)
			: AMOUNT_INVALID;
	else if (amountMinor > MAX_AMOUNT_MINOR) errors.amountMinor = AMOUNT_TOO_LARGE;

	let schedule: BillingSchedule | null = null;
	if (!(BILLING_CYCLES as readonly string[]).includes(values.cycle)) errors.cycle = CYCLE_INVALID;
	else {
		const cycle = values.cycle as BillingCycle;
		const day = smallInt(cycle === 'weekly' ? values.weekday : values.day);
		const month = cycle === 'yearly' ? smallInt(values.month) : null;
		if (cycle === 'yearly' && (month === null || month < 1 || month > 12))
			errors.month = MONTH_INVALID;
		else if (day !== null && isValidSchedule({ cycle, day, month }))
			schedule = { cycle, day, month };
		else if (cycle === 'weekly') errors.weekday = WEEKDAY_INVALID;
		else errors.day = DAY_INVALID;
	}

	const reminder =
		values.reminderDays === '' ? REMINDER_DAYS_DEFAULT : smallInt(values.reminderDays);
	if (reminder === null || reminder > REMINDER_DAYS_MAX) errors.reminderDays = REMINDER_INVALID;

	if (
		Object.keys(errors).length > 0 ||
		!category ||
		!schedule ||
		amountMinor === null ||
		reminder === null
	)
		return { ok: false, errors, values };
	return {
		ok: true,
		values,
		value: {
			catalogueId,
			name,
			category,
			amountMinor,
			currency: values.currency,
			schedule,
			// Longer than an id cannot match; the action looks it up inside the space.
			walletId: values.walletId === '' ? null : values.walletId.slice(0, ID_MAX_LENGTH),
			reminderDaysBefore: reminder
		}
	};
}

/** The `updated_at` the form was loaded with; -1 (matches nothing, so "changed meanwhile") when malformed. */
export function expectedUpdatedAt(form: FormData): number {
	const value = textField(form, 'updatedAt');
	return UPDATED_AT.test(value) ? Number(value) : -1;
}

/** An id field (subscription, wallet, category, transaction): '' when over-long (matches nothing). */
export function idField(form: FormData, name: string): string {
	const id = textField(form, name);
	return id.length > ID_MAX_LENGTH ? '' : id;
}

/** "Tandai sudah dibayar": record a new expense, or link an existing one. */
export type PayChoice =
	| { mode: 'new'; walletId: string; categoryId: string; occurredOn: string }
	| { mode: 'link'; transactionId: string };

/**
 * The mark-paid form → which way it was paid. `new` needs a wallet, a category and a real WIB date (the
 * transaction itself is then checked by FN-05's own rules); `link` needs a transaction id. The ids are only
 * shapes here: the action looks each one up inside the space.
 */
export function parsePayForm(
	form: FormData
): { ok: true; value: PayChoice } | { ok: false; error: string } {
	const mode = textField(form, 'mode');
	if (mode === 'link') {
		const transactionId = idField(form, 'transactionId');
		return transactionId === ''
			? { ok: false, error: PAY_MODE_INVALID }
			: { ok: true, value: { mode, transactionId } };
	}
	if (mode !== 'new') return { ok: false, error: PAY_MODE_INVALID };
	const occurredOn = textField(form, 'occurredOn').slice(0, 16);
	return {
		ok: true,
		value: {
			mode,
			walletId: idField(form, 'walletId'),
			categoryId: idField(form, 'categoryId'),
			occurredOn: isDateString(occurredOn) ? occurredOn : ''
		}
	};
}
