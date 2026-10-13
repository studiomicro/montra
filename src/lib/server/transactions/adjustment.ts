import { sql } from 'drizzle-orm';
import type { Db } from '../db';
import { amountRefusal } from '../forms';
import type { SpaceScope } from '../spaces/access';
import { getWallet } from '../wallets/repo';
import {
	ADJUSTMENT_CHANGED,
	BALANCE_INVALID,
	BALANCE_INVALID_CENTS,
	REFS_GONE,
	TRANSACTION_LIMIT,
	WALLET_NOT_FOUND
} from './messages';
import { createTransaction, MANUAL, type TransactionDetail } from './repo';
import {
	adjustmentFor,
	statedBalanceMinor,
	type AdjustmentDraft,
	type AdjustmentEdit,
	type FieldErrors,
	type TransactionInput
} from './validation';
import { readWalletBalance, walletBalanceSql } from './wallet-sum';

/** Reads of the balance before giving up when other writes keep moving it (each one is a fresh read). */
const ATTEMPTS = 3;

export type AdjustmentResult =
	| { ok: true; id: string }
	/** `errors`: a field message for the form; `error`: a banner message (both msg() phrases). */
	| { ok: false; status: 400 | 409; errors?: FieldErrors; error?: string };

/**
 * "Penyesuaian saldo" (FN-37): records the difference between the stated balance and the wallet's balance as
 * one adjustment row, so the wallet then shows exactly the stated balance. The wallet must be live in the
 * space; the balance is read on the server at submit time (never a figure the page showed earlier), and the
 * insert only goes through while the wallet's balance is still exactly what was read (checked inside the
 * guarded insert), so two tabs submitting the same balance write one row: the second re-reads, finds the
 * balance already equal and writes nothing. No difference is refused (never a zero-amount row).
 */
export async function createBalanceAdjustment(
	db: Db,
	scope: SpaceScope,
	draft: AdjustmentDraft,
	now: number
): Promise<AdjustmentResult> {
	const { spaceId } = scope;
	const wallet = await getWallet(db, spaceId, draft.walletId);
	if (!wallet) return { ok: false, status: 400, errors: { walletId: WALLET_NOT_FOUND } };
	const stated = statedBalanceMinor(draft, wallet.currency);
	if (stated === null) {
		const refusal = amountRefusal(wallet.currency, BALANCE_INVALID, BALANCE_INVALID_CENTS);
		return { ok: false, status: 400, errors: { amountMinor: refusal } };
	}
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const current = await readWalletBalance(db, spaceId, wallet.id);
		if (current === null) return { ok: false, status: 409, error: REFS_GONE };
		const diff = adjustmentFor(stated, current);
		if (!diff.ok) return { ok: false, status: 400, errors: { amountMinor: diff.error } };
		const input: TransactionInput = {
			type: 'adjustment',
			amountMinor: diff.amountMinor,
			currency: wallet.currency,
			walletId: wallet.id,
			transferToWalletId: null,
			categoryId: null,
			adjustmentDirection: diff.direction,
			title: draft.title,
			note: draft.note,
			occurredOn: draft.occurredOn,
			occurredTime: draft.occurredTime
		};
		// `current` is an exact SQLite integer; bound as text and compared as an integer, nothing is rounded.
		const unchanged = sql`${walletBalanceSql(spaceId, wallet.id)} = cast(${current.toString()} as integer)`;
		const created = await createTransaction(db, scope, input, now, MANUAL, unchanged);
		if (created.ok) return { ok: true, id: created.id };
		if (created.reason === 'limit') return { ok: false, status: 409, error: TRANSACTION_LIMIT };
		// Nothing was written. A moved balance is read again; anything else (membership, wallet) is gone.
		if ((await readWalletBalance(db, spaceId, wallet.id)) === current)
			return { ok: false, status: 409, error: REFS_GONE };
	}
	return { ok: false, status: 409, error: ADJUSTMENT_CHANGED };
}

/**
 * An adjustment's edit (owner decision A): the stored amount, direction, wallet and currency are kept as they
 * are; only title, note, date and time come from the form.
 */
export function adjustmentEditInput(
	current: TransactionDetail,
	edit: AdjustmentEdit
): TransactionInput {
	return {
		type: 'adjustment',
		amountMinor: current.amountMinor,
		currency: current.currency,
		walletId: current.walletId,
		transferToWalletId: null,
		categoryId: null,
		adjustmentDirection: current.adjustmentDirection,
		title: edit.title,
		note: edit.note,
		occurredOn: edit.occurredOn,
		occurredTime: edit.occurredTime
	};
}
