import { z } from 'zod';
import { WALLET_CURRENCIES } from '#lib/shared/wallets';
import type { Locale } from '#lib/shared/i18n';
import { amountMinorFromText, amountRefusal, textField } from '../forms';
import { MAX_AMOUNT_MINOR } from '../transactions/validation';
import {
	BUDGET_AMOUNT_INVALID,
	BUDGET_AMOUNT_INVALID_CENTS,
	BUDGET_CURRENCY_INVALID,
	BUDGET_TOO_LARGE
} from './messages';

/** An `updated_at` (epoch ms) as the form carries it. */
const UPDATED_AT = /^\d{1,15}$/;

export const budgetInputSchema = z.object({
	amountMinor: z
		.number()
		.int(BUDGET_AMOUNT_INVALID)
		.positive(BUDGET_AMOUNT_INVALID)
		// One cap for every amount a person types: a budget is never larger than one transaction may be.
		.max(MAX_AMOUNT_MINOR, BUDGET_TOO_LARGE),
	currency: z.enum(WALLET_CURRENCIES, { error: BUDGET_CURRENCY_INVALID })
});
export type BudgetInput = z.infer<typeof budgetInputSchema>;

export type ParsedBudgetForm = { ok: true; value: BudgetInput } | { ok: false; error: string };

/**
 * The budget form (`amount`, `currency`) → a validated budget, or the one error to show. The amount follows
 * the shared amount contract (`amountMinorFromText`: `locale`'s separators, cents for every currency but IDR
 * and JPY, never parseFloat) in the posted currency's exponent and the 10^13 cap. The currency only passes the allow-list
 * here; the action then checks it against the space's own wallets (`isBudgetCurrency`), never trusting the
 * hidden field.
 */
export function parseBudgetForm(form: FormData, locale: Locale): ParsedBudgetForm {
	const amount = textField(form, 'amount').slice(0, 64);
	const currency = textField(form, 'currency').slice(0, 8);
	const known = (WALLET_CURRENCIES as readonly string[]).includes(currency);
	const parsed = budgetInputSchema.safeParse({
		amountMinor: amountMinorFromText(amount, known ? currency : 'IDR', locale) ?? 0,
		currency
	});
	if (!parsed.success) {
		const paths = parsed.error.issues.map((i) => i.path[0]);
		if (paths.includes('currency')) return { ok: false, error: BUDGET_CURRENCY_INVALID };
		const error = parsed.error.issues[0]?.message ?? BUDGET_AMOUNT_INVALID;
		// FN-47: a currency with cents is told about its two fraction digits, not "tanpa sen".
		return {
			ok: false,
			error:
				error === BUDGET_AMOUNT_INVALID
					? amountRefusal(currency, BUDGET_AMOUNT_INVALID, BUDGET_AMOUNT_INVALID_CENTS)
					: error
		};
	}
	return { ok: true, value: parsed.data };
}

/**
 * The `updated_at` the form was loaded with: null when the form showed no budget (a create), -1 (matches
 * nothing, so "changed meanwhile") when malformed.
 */
export function expectedUpdatedAt(form: FormData): number | null {
	const value = textField(form, 'updatedAt');
	if (value === '') return null;
	return UPDATED_AT.test(value) ? Number(value) : -1;
}
