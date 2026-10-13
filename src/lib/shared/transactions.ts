import { msg } from './i18n.ts';

/**
 * Transaction kinds (FN-05). Sign convention, decided once: `amount_minor` is always a positive magnitude and the
 * direction comes from `type` — income adds, expense subtracts, a transfer moves money between two wallets of
 * the same space and never counts as income or expense. A balance adjustment (FN-37, "Penyesuaian saldo")
 * carries its sign in `adjustment_direction`: it moves its wallet's balance and, like a transfer, never counts
 * as income, expense, a budget or a report figure.
 */
export const TRANSACTION_TYPES = ['expense', 'income', 'transfer', 'adjustment'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/** The types the compose/edit form writes; an adjustment has its own form (FN-37). */
export const FORM_TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;

/** Which way a balance adjustment (FN-37) moved its wallet. */
export const ADJUSTMENT_DIRECTIONS = ['increase', 'decrease'] as const;
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

/** Category kinds (FN-06): every expense or income row points at a category of its own kind. */
export const CATEGORY_KINDS = ['expense', 'income'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/** Where a row came from. Only `manual` is written this pass; the rest are schema-ready for captures. */
export const TRANSACTION_SOURCES = [
	'manual',
	'gmail',
	'voice',
	'receipt',
	'statement',
	'spreadsheet',
	'csv',
	'slack'
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

/** Who chose a row's category (FN-48): a capture or import unseen (`auto`), or a person (`user`). */
export const CATEGORY_SOURCES = ['auto', 'user'] as const;
export type CategorySource = (typeof CATEGORY_SOURCES)[number];

export const TRANSACTION_TYPE_LABELS: Readonly<Record<TransactionType, string>> = {
	expense: msg('Pengeluaran'),
	income: msg('Pemasukan'),
	transfer: msg('Transfer'),
	adjustment: msg('Penyesuaian saldo')
};

export const CATEGORY_KIND_LABELS: Readonly<Record<CategoryKind, string>> = {
	expense: msg('Pengeluaran'),
	income: msg('Pemasukan')
};

export const TITLE_MAX_LENGTH = 80;
export const NOTE_MAX_LENGTH = 500;
export const CATEGORY_NAME_MAX_LENGTH = 40;
/** Longest search term kept (after cleaning); longer input is cut, never an error. */
export const SEARCH_MAX_LENGTH = 100;

/** The "Penyesuaian saldo" form's fields as typed (FN-37; a refused no-JavaScript form echoes them back). */
export interface AdjustmentFormValues {
	walletId: string;
	/** The wallet's new balance in whole units, grouped as typed (`1.500.000`); empty is 0. */
	balance: string;
	/** The new balance is below zero (a credit card or an overdraft). */
	negative: boolean;
	title: string;
	note: string;
	/** WIB date `YYYY-MM-DD`. */
	occurredOn: string;
	/** Optional WIB time `HH:MM` ('' when not given). */
	occurredTime: string;
}

/** The compose/edit form's fields as typed (a refused no-JavaScript form echoes them back; never stored). */
export interface TransactionFormValues {
	type: string;
	/** Whole units, grouped as typed (`25.000`). */
	amount: string;
	walletId: string;
	transferToWalletId: string;
	categoryId: string;
	title: string;
	note: string;
	/** WIB date `YYYY-MM-DD`. */
	occurredOn: string;
	/** Optional WIB time `HH:MM` ('' when not given). */
	occurredTime: string;
}

/**
 * The 24 preset categories (FEATURES.md FN-06 mirror list, in that order, plus FN-39's "Ojek Online" and "Pesan
 * Antar Makanan" right after "Transportasi", plus FN-48's bank-statement tiles), one per tile slot except
 * the transfer tile, which has an expense ("Transfer keluar") and an income ("Transfer masuk") row, named apart
 * from the transaction type "Transfer" (owner decision 2026-10-11). Names are stored as Indonesian text and shown
 * through tr() while unchanged (see `categoryLabel`). A space seeded before FN-39 or FN-48 gets the later ones on
 * its next category load (`ensurePresetCategories`).
 */
export const PRESET_CATEGORIES = [
	{ tileKey: 'kopi', kind: 'expense', name: msg('Kopi') },
	{ tileKey: 'makan', kind: 'expense', name: msg('Makan & Minum') },
	{ tileKey: 'belanja-harian', kind: 'expense', name: msg('Belanja Harian') },
	{ tileKey: 'belanja', kind: 'expense', name: msg('Belanja') },
	{ tileKey: 'transportasi', kind: 'expense', name: msg('Transportasi') },
	{ tileKey: 'ojek-online', kind: 'expense', name: msg('Ojek Online') },
	{ tileKey: 'pesan-antar-makanan', kind: 'expense', name: msg('Pesan Antar Makanan') },
	{ tileKey: 'tagihan', kind: 'expense', name: msg('Tagihan') },
	{ tileKey: 'kesehatan', kind: 'expense', name: msg('Kesehatan') },
	{ tileKey: 'hiburan', kind: 'expense', name: msg('Hiburan') },
	{ tileKey: 'pendidikan', kind: 'expense', name: msg('Pendidikan') },
	{ tileKey: 'tempat-tinggal', kind: 'expense', name: msg('Tempat Tinggal') },
	{ tileKey: 'biaya-bank', kind: 'expense', name: msg('Biaya Bank') },
	{ tileKey: 'pajak', kind: 'expense', name: msg('Pajak') },
	{ tileKey: 'tarik-tunai', kind: 'expense', name: msg('Tarik Tunai') },
	{ tileKey: 'kartu-kredit', kind: 'expense', name: msg('Kartu Kredit') },
	{ tileKey: 'transfer', kind: 'expense', name: msg('Transfer keluar') },
	{ tileKey: 'gaji', kind: 'income', name: msg('Gaji') },
	{ tileKey: 'bonus', kind: 'income', name: msg('Bonus') },
	{ tileKey: 'freelance', kind: 'income', name: msg('Freelance') },
	{ tileKey: 'hadiah', kind: 'income', name: msg('Hadiah') },
	{ tileKey: 'bunga', kind: 'income', name: msg('Bunga') },
	{ tileKey: 'transfer', kind: 'income', name: msg('Transfer masuk') },
	{ tileKey: 'lain', kind: 'income', name: msg('Pemasukan Lain') }
] as const satisfies readonly { tileKey: TileKey; kind: CategoryKind; name: string }[];

/**
 * The 23 tile slots a category may use: exactly the kit's `CategoryKey`s (a test locks the two lists together,
 * and the `categories_tile_key_check` constraint, last rebuilt by migration 0037, repeats them).
 */
export const TILE_KEYS = [
	'kopi',
	'makan',
	'belanja-harian',
	'belanja',
	'transportasi',
	'ojek-online',
	'pesan-antar-makanan',
	'tagihan',
	'kesehatan',
	'hiburan',
	'pendidikan',
	'tempat-tinggal',
	'biaya-bank',
	'pajak',
	'tarik-tunai',
	'kartu-kredit',
	'transfer',
	'gaji',
	'bonus',
	'freelance',
	'hadiah',
	'bunga',
	'lain'
] as const;
export type TileKey = (typeof TILE_KEYS)[number];

/** FN-48: the presets added after spaces were already seeded (topped up on the next category load). */
export const FN48_TILES: ReadonlySet<TileKey> = new Set([
	'biaya-bank',
	'pajak',
	'tarik-tunai',
	'kartu-kredit',
	'transfer',
	'bunga'
]);

/** Name of the expense category an import creates for rows nothing names (FN-18), on the `lain` tile. */
export const FALLBACK_EXPENSE_CATEGORY = msg('Lainnya');

/**
 * FN-48: a fallback category, i.e. "no real category yet": the `lain` preset ("Pemasukan Lain", whatever it is
 * called now) or the "Lainnya" expense category an import creates on the `lain` tile. A custom category the user
 * named on the `lain` tile is a real choice, not a fallback. `cleanup.ts` repeats this rule in SQL.
 */
export function isFallbackCategory(c: {
	tileKey: string;
	isPreset: boolean;
	name: string;
}): boolean {
	return (
		c.tileKey === 'lain' &&
		(c.isPreset || c.name.trim().toLowerCase() === FALLBACK_EXPENSE_CATEGORY.toLowerCase())
	);
}

const PRESET_NAMES: ReadonlySet<string> = new Set(PRESET_CATEGORIES.map((p) => p.name));

/**
 * A category's display name: a preset still carrying its seeded name is translated; anything the user typed is
 * shown exactly as typed (never looked up in the translation table).
 */
export function categoryLabel(
	category: { name: string; isPreset: boolean },
	tr: (phrase: string) => string
): string {
	return category.isPreset && PRESET_NAMES.has(category.name) ? tr(category.name) : category.name;
}
