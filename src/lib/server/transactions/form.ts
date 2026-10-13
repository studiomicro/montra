import type { Locale } from '#lib/shared/i18n';
import type { TransactionFormValues } from '#lib/shared/transactions';
import { getCategory } from '../categories/repo';
import type { Db } from '../db';
import { getWallet } from '../wallets/repo';
import type { TransactionDetail } from './repo';
import {
	parseTransactionForm,
	resolveTransactionInput,
	type DraftRefs,
	type FieldErrors,
	type TransactionDraft,
	type TransactionInput
} from './validation';

/**
 * The draft's ids looked up inside `spaceId` only (another space's id finds nothing, like an unknown one).
 * A new choice must be a live wallet and a visible category; the archived wallet or hidden category an edited
 * transaction already uses stays allowed for that transaction (FN-06 criterion 6).
 */
async function loadDraftRefs(
	db: Db,
	spaceId: string,
	draft: TransactionDraft,
	current: TransactionDetail | null
): Promise<DraftRefs> {
	const usable = async (id: string | null) => {
		if (!id) return null;
		const w = await getWallet(db, spaceId, id, { includeArchived: true });
		if (!w) return null;
		const kept = current && (current.walletId === id || current.transferToWalletId === id);
		return !w.archived || kept ? { id: w.id, currency: w.currency } : null;
	};
	const [wallet, toWallet, category] = await Promise.all([
		usable(draft.walletId),
		draft.type === 'transfer' ? usable(draft.transferToWalletId) : null,
		draft.categoryId ? getCategory(db, spaceId, draft.categoryId) : null
	]);
	const categoryOk = category && (!category.isHidden || current?.categoryId === category.id);
	return {
		wallet,
		toWallet,
		category: categoryOk ? { id: category.id, kind: category.kind } : null
	};
}

export type ReadTransactionForm =
	| { ok: true; input: TransactionInput }
	| { ok: false; errors: FieldErrors; values: TransactionFormValues };

/**
 * The compose/edit form → a transaction input whose every id is checked inside the space, or field errors.
 * The typed amount is read with `locale`'s separators (FN-47); `exactAmountMinor` (the public API, FN-38)
 * replaces it.
 */
export async function readTransactionForm(
	db: Db,
	spaceId: string,
	form: FormData,
	locale: Locale,
	current: TransactionDetail | null = null,
	exactAmountMinor?: number
): Promise<ReadTransactionForm> {
	const parsed = parseTransactionForm(form, locale, exactAmountMinor);
	if (!parsed.ok) return parsed;
	const refs = await loadDraftRefs(db, spaceId, parsed.draft, current);
	const resolved = resolveTransactionInput(parsed.draft, refs);
	if (!resolved.ok) return { ok: false, errors: resolved.errors, values: parsed.values };
	return { ok: true, input: resolved.value };
}
