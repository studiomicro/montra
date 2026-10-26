import { z } from 'zod';
import {
	CONTRIBUTION_NOTE_MAX_LENGTH,
	GOAL_NAME_MAX_LENGTH,
	type ContributionFormValues,
	type GoalFormValues
} from '#lib/shared/goals';
import { cleanText } from '#lib/shared/text';
import { textField, wholeAmountMinor } from '../forms';
import { AMOUNT_INVALID, GOAL_NAME_INVALID, NOTE_INVALID, TARGET_INVALID } from './messages';

/** Goals hold IDR this pass (no per-goal currency picker, PRD out of scope). */
export const GOAL_CURRENCY = 'IDR';

/** Length in code points, so a cap of 60 means 60 characters, emoji included. */
const codePoints = (text: string) => Array.from(text).length;

const positiveMinor = (message: string) =>
	z.number().int(message).positive(message).refine(Number.isSafeInteger, message);

const goalInputSchema = z.object({
	name: z
		.string()
		.min(1, GOAL_NAME_INVALID)
		.refine((s) => codePoints(s) <= GOAL_NAME_MAX_LENGTH, GOAL_NAME_INVALID),
	targetAmountMinor: positiveMinor(TARGET_INVALID)
});
export type GoalInput = z.infer<typeof goalInputSchema>;
export type GoalField = keyof GoalInput;

const contributionInputSchema = z.object({
	amountMinor: positiveMinor(AMOUNT_INVALID),
	note: z
		.string()
		.refine((s) => codePoints(s) <= CONTRIBUTION_NOTE_MAX_LENGTH, NOTE_INVALID)
		.nullable()
});
export type ContributionInput = z.infer<typeof contributionInputSchema>;
export type ContributionField = keyof ContributionInput;

type Parsed<T, F extends string, V> =
	{ ok: true; value: T } | { ok: false; errors: Partial<Record<F, string>>; values: V };

/**
 * Untrusted text cleaned for storage, one code point past `max` kept so an over-long value is refused by the
 * schema (never silently cut).
 */
const cleaned = (text: string, max: number) => cleanText(text, max + 1);

function collect<F extends string>(issues: readonly z.core.$ZodIssue[]) {
	const errors: Partial<Record<F, string>> = {};
	for (const issue of issues) errors[issue.path[0] as F] ??= issue.message;
	return errors;
}

/**
 * The add/edit goal form → a validated goal, or field errors (msg() phrases). The name is stripped of control
 * and zero-width characters (empty after that is refused); longer than 60 characters is refused. The target is
 * whole IDR units (`1.250.000`), positive; decimals, signs and exponents are refused, never reinterpreted.
 */
export function parseGoalForm(form: FormData): Parsed<GoalInput, GoalField, GoalFormValues> {
	const values: GoalFormValues = {
		name: textField(form, 'name').slice(0, GOAL_NAME_MAX_LENGTH * 4),
		target: textField(form, 'target').slice(0, 64)
	};
	const minor = wholeAmountMinor(values.target, GOAL_CURRENCY);
	const name = cleaned(values.name, GOAL_NAME_MAX_LENGTH);
	const parsed = goalInputSchema.safeParse({
		name,
		targetAmountMinor: minor ?? 0
	});
	if (!parsed.success)
		return { ok: false, errors: collect<GoalField>(parsed.error.issues), values };
	return { ok: true, value: parsed.data };
}

/**
 * The add-contribution form → a validated contribution, or field errors. The amount is whole IDR units and
 * positive (Owner decision B: no negative contributions; the only way down is deleting a logged one). The note
 * is optional, cleaned like the goal name, at most 200 characters.
 */
export function parseContributionForm(
	form: FormData
): Parsed<ContributionInput, ContributionField, ContributionFormValues> {
	const values: ContributionFormValues = {
		amount: textField(form, 'amount').slice(0, 64),
		note: textField(form, 'note').slice(0, CONTRIBUTION_NOTE_MAX_LENGTH * 4)
	};
	const minor = wholeAmountMinor(values.amount, GOAL_CURRENCY);
	const note = cleaned(values.note, CONTRIBUTION_NOTE_MAX_LENGTH);
	const parsed = contributionInputSchema.safeParse({
		amountMinor: minor ?? 0,
		note: note === '' ? null : note
	});
	if (!parsed.success)
		return { ok: false, errors: collect<ContributionField>(parsed.error.issues), values };
	return { ok: true, value: parsed.data };
}
