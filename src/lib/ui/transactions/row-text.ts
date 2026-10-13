import { formatShortDay, rowTimeLabel } from '#lib/shared/dates';
import type { Translator } from '#lib/shared/i18n';
import { formatMoney } from '#lib/shared/money-format';
import {
	categoryLabel,
	type AdjustmentDirection,
	type TransactionType
} from '#lib/shared/transactions';

/** The fields of a listed transaction (Riwayat's and Beranda's rows) the two list lines need. */
export interface ListedRow {
	type: TransactionType;
	amountMinor: number;
	/** Set on a balance adjustment (FN-37). */
	adjustmentDirection?: AdjustmentDirection | null;
	title: string | null;
	occurredOn: string;
	occurredAt: number;
	category: { name: string; isPreset: boolean } | null;
	wallet: { name: string };
	toWallet: { name: string } | null;
}

/** First line: the title, else "Transfer", "Penyesuaian saldo" or the category name. */
export function rowTitle(row: ListedRow, { tr }: Pick<Translator, 'tr'>): string {
	if (row.title) return row.title;
	if (row.type === 'transfer') return tr('Transfer');
	if (row.type === 'adjustment') return tr('Penyesuaian saldo');
	return row.category ? categoryLabel(row.category, tr) : tr('Tanpa kategori');
}

/**
 * Second line (APP_PARITY § 3): "16.32 · Makan & Minum · Tunai", a transfer "16.32 · BCA → Tunai", a balance
 * adjustment "16.32 · Saldo disesuaikan · BCA" (no category, FN-37). `withDate`
 * (Beranda's Terbaru) leads with the day: "7 Okt, 16.32 · …". The time shows only when the row has one.
 */
export function rowMeta(
	row: ListedRow,
	t: Pick<Translator, 'tr' | 'locale'>,
	opts: { withDate?: boolean } = {}
): string {
	const time = rowTimeLabel(row.occurredOn, row.occurredAt, t.locale);
	const day = opts.withDate ? formatShortDay(row.occurredOn, t.locale) : null;
	const when = [day, time].filter(Boolean).join(', ');
	const what =
		row.type === 'transfer'
			? `${row.wallet.name} → ${row.toWallet?.name ?? ''}`
			: row.type === 'adjustment'
				? `${t.tr('Saldo disesuaikan')} · ${row.wallet.name}`
				: `${row.category ? categoryLabel(row.category, t.tr) : t.tr('Tanpa kategori')} · ${row.wallet.name}`;
	return when ? `${when} · ${what}` : what;
}

/**
 * The amount a row shows: negative for an expense and a decreasing balance adjustment, the magnitude otherwise
 * (TransactionRow signs it; an adjustment is signed but never coloured as income or expense).
 */
export const signedAmount = (
	row: Pick<ListedRow, 'type' | 'amountMinor' | 'adjustmentDirection'>
) =>
	row.type === 'expense' || (row.type === 'adjustment' && row.adjustmentDirection === 'decrease')
		? -row.amountMinor
		: row.amountMinor;

/** The small grey word over a row's amount on a phone: "Pengeluaran", "Pemasukan" or "Transfer" (none for an adjustment). */
export function rowKindLabel(
	row: Pick<ListedRow, 'type'>,
	{ tr }: Pick<Translator, 'tr'>
): string | undefined {
	return row.type === 'expense'
		? tr('Pengeluaran')
		: row.type === 'income'
			? tr('Pemasukan')
			: row.type === 'transfer'
				? tr('Transfer')
				: undefined;
}

/**
 * FN-49: the line under a row's amount when it is linked to a split. A bill (its full amount stays shown) says
 * what it counts in every total: "patungan: bagianmu Rp 100.000"; the payer's own-share row (its amount already
 * is the share) only says "Patungan". None for any other row.
 */
export function rowShare(
	row: {
		amountMinor: number;
		currency: string;
		patungan: { effectiveAmountMinor: number } | null;
	},
	{ tr, trf, locale }: Pick<Translator, 'tr' | 'trf' | 'locale'>
): string | undefined {
	if (!row.patungan) return undefined;
	return row.patungan.effectiveAmountMinor < row.amountMinor
		? trf('patungan: bagianmu {amount}', {
				amount: formatMoney(row.patungan.effectiveAmountMinor, row.currency, 'auto', locale)
			})
		: tr('Patungan');
}
