import { amountFractionDigits } from './amount-input.ts';
import { msg } from './i18n.ts';
import { currencyExponent } from './money-format.ts';
import { MAX_AMOUNT_MINOR } from './money-parse.ts';

/**
 * FN-49 Patungan (split bill): the split modes and the rounding engine, shared by the server (which decides) and
 * the form (which previews). Pure: no database, no floats on money (BigInt sums), every result adds up to the
 * total exactly or is refused. Pass 1 builds `equal` and `exact`; `items` and `percentage` are stored modes the
 * table already allows (pass 2 adds their engine).
 */

export const PATUNGAN_MODES = ['equal', 'exact', 'items', 'percentage'] as const;
export type PatunganMode = (typeof PATUNGAN_MODES)[number];

/** The modes the create and edit forms offer now. */
export const FORM_MODES = ['equal', 'exact'] as const;
export type FormMode = (typeof FORM_MODES)[number];

export const MODE_LABELS: Record<FormMode, string> = {
	equal: msg('Bagi rata'),
	exact: msg('Jumlah pasti')
};

export function isFormMode(value: string): value is FormMode {
	return (FORM_MODES as readonly string[]).includes(value);
}

export const PATUNGAN_PARTICIPANT_KINDS = ['member', 'guest'] as const;

/** The payer and at least one other person: a "split" of one is not a split. */
const MIN_PARTICIPANTS = 2;
/** Most people on one bill, the payer included (bounds every form, query and batch). */
export const MAX_PARTICIPANTS = 20;

type SharesRefusal =
	/** Fewer than MIN_PARTICIPANTS or more than MAX_PARTICIPANTS people. */
	| 'count'
	/** `equal`: the total is smaller than the number of people (someone's share would be 0). */
	| 'total_too_small'
	/** `exact`: an amount is missing, not a whole number of minor units, or outside 1 … MAX_AMOUNT_MINOR. */
	| 'share_invalid'
	/** `exact`: the amounts do not add up to the total. */
	| 'sum_mismatch';

export type SharesResult = { ok: true; shares: number[] } | { ok: false; reason: SharesRefusal };

const validAmount = (n: number | null | undefined): n is number =>
	typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_AMOUNT_MINOR;

/** Throws unless the shares add up to `total` exactly: a failed check is a bug, never a user-facing error. */
function assertSum(shares: readonly number[], total: number): number[] {
	const sum = shares.reduce((acc, s) => acc + BigInt(s), 0n);
	if (sum !== BigInt(total) || shares.some((s) => !validAmount(s)))
		throw new Error('patungan shares do not add up to the total');
	return [...shares];
}

/**
 * Minor units in the smallest amount a person types in `currency`: 100 for IDR (stored in sen, typed in whole
 * rupiah, FN-47), 1 for a currency typed with its cents (USD) or without a minor unit (JPY). Equal shares are
 * whole multiples of it, so nobody is asked for "Rp 33.333,33".
 */
export function typedUnitMinor(currency: string): number {
	return 10 ** (currencyExponent(currency) - amountFractionDigits(currency));
}

/**
 * `equal`: the total divided by the number of people (the payer included), rounded down to a whole `unit`
 * (`typedUnitMinor`); every leftover minor unit goes to the payer's share (owner decision). Rp 100.000 among 3 →
 * 33.333, 33.333 and 33.334 (payer); 100 cents among 3 → 33, 33 and 34 (payer).
 */
export function equalShares(
	total: number,
	count: number,
	payerIndex: number,
	unit = 1
): SharesResult {
	if (!Number.isInteger(count) || count < MIN_PARTICIPANTS || count > MAX_PARTICIPANTS)
		return { ok: false, reason: 'count' };
	if (!Number.isInteger(payerIndex) || payerIndex < 0 || payerIndex >= count)
		throw new RangeError('payer index out of range');
	if (!validAmount(total)) throw new RangeError('total out of range');
	if (!Number.isSafeInteger(unit) || unit < 1) throw new RangeError('unit out of range');
	const step = BigInt(unit);
	const base = (BigInt(total) / (BigInt(count) * step)) * step;
	if (base === 0n) return { ok: false, reason: 'total_too_small' };
	const remainder = BigInt(total) - base * BigInt(count);
	const shares = Array.from({ length: count }, (_, i) =>
		Number(i === payerIndex ? base + remainder : base)
	);
	return { ok: true, shares: assertSum(shares, total) };
}

/**
 * `exact`: every person's amount typed (the payer's included); refused unless each is 1 … MAX_AMOUNT_MINOR and
 * their exact sum is the total. Never fills in or moves a remainder.
 */
export function exactShares(total: number, amounts: readonly (number | null)[]): SharesResult {
	if (amounts.length < MIN_PARTICIPANTS || amounts.length > MAX_PARTICIPANTS)
		return { ok: false, reason: 'count' };
	if (!validAmount(total)) throw new RangeError('total out of range');
	if (!amounts.every(validAmount)) return { ok: false, reason: 'share_invalid' };
	const sum = amounts.reduce((acc, a) => acc + BigInt(a), 0n);
	if (sum !== BigInt(total)) return { ok: false, reason: 'sum_mismatch' };
	return { ok: true, shares: assertSum(amounts, total) };
}

/** The sum of typed amounts (exact, BigInt), for the "Rp X lagi" / "lebih Rp X" hint beside an exact split. */
export function sharesDifference(total: number, amounts: readonly (number | null)[]): bigint {
	return (
		amounts.reduce<bigint>((acc, a) => acc + BigInt(validAmount(a) ? a : 0), 0n) - BigInt(total)
	);
}

/** A participant as the lock rule reads it. */
export interface PaidState {
	isPayer: boolean;
	paidAmountMinor: number;
}

/**
 * Locked once any person other than the payer has paid something: from then on the mode, the people and every
 * share are fixed (the server refuses the write); title, note and date stay editable, settling still works.
 */
export function isLocked(participants: readonly PaidState[]): boolean {
	return participants.some((p) => !p.isPayer && p.paidAmountMinor > 0);
}

/** Most characters of a split's title and of a person's name (the table's CHECK). */
export const SPLIT_TITLE_MAX = 80;
export const PERSON_NAME_MAX = 80;
export const SPLIT_NOTE_MAX = 500;

/** The create/edit form as typed, echoed back with a refusal (every field a string, as posted). */
export interface PatunganFormValues {
	title: string;
	occurredOn: string;
	note: string;
	mode: string;
	/** The total as typed (ignored when the total is fixed by a linked bill). */
	amount: string;
	/** The payer's own row: the typed amount in `exact` mode. */
	payerShare: string;
	/** Space members picked (account ids, never the payer's). */
	members: string[];
	/** Each picked member's typed amount in `exact` mode, by account id. */
	memberShares: Record<string, string>;
	/** Guests by name, with their typed amount in `exact` mode. */
	guests: { name: string; share: string }[];
	/** Standalone splits only: where the payer's own share is paid from, and its category. */
	walletId: string;
	categoryId: string;
}
