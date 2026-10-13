import { sql } from 'drizzle-orm';
import {
	CSV_MAX_ROWS,
	readCsv,
	type CsvFormat,
	type CsvParseError,
	type MappedRow,
	type RawCsvTransaction
} from '#lib/shared/csv';
import { importCategoryFromTitle } from '#lib/shared/category-keywords';
import { wibInstantUtcMs } from '#lib/shared/dates';
import { cleanDescriptor } from '#lib/shared/merchants/clean';
import { layerKey } from '#lib/shared/merchants/resolve';
import { asciiLowerKey, cleanText, maskAccountNumbers } from '#lib/shared/text';
import {
	CATEGORY_NAME_MAX_LENGTH,
	FALLBACK_EXPENSE_CATEGORY,
	TITLE_MAX_LENGTH,
	type CategoryKind,
	type CategorySource,
	type TileKey
} from '#lib/shared/transactions';
import { WALLET_NAME_MAX_LENGTH } from '#lib/shared/wallets';
import type { AiGatewayEnv } from '../ai-keys/anthropic';
import type { AiKeysEnv } from '../ai-keys/crypto';
import {
	categoryNameKey,
	ensurePresetCategories,
	insertImportedCategories,
	listCategories,
	MAX_CATEGORIES_PER_SPACE,
	type CategorySummary
} from '../categories/repo';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import type { SpaceScope } from '../spaces/access';
import { bumpSpaceSeq } from '../sync/seq';
import {
	insertTransactions,
	MAX_TRANSACTIONS_PER_SPACE,
	type NewTransaction
} from '../transactions/repo';
import { resolveMerchants, type ResolveRequestItem } from '../merchants/resolve';
import { capturedTransactionInput } from '../transactions/validation';
import { isUniqueViolation, newId, sha256Hex } from '../util';
import {
	getWallet,
	insertImportedWallets,
	listWallets,
	MAX_WALLETS_PER_SPACE,
	type WalletRef
} from '../wallets/repo';
import { createImportBatch, type StatementFigures } from './repo';

/** Rows per insert statement: keeps each statement's one JSON parameter far below D1's 2 MB value limit. */
const INSERT_CHUNK = 250;
/** Most "Mungkin duplikat" rows a preview lists (the count covers all of them). */
export const PREVIEW_DUPLICATES_MAX = 20;
/**
 * Attempts when a concurrent import won a race: it wrote some of this file's rows first (unique dedupe key) or
 * created a wallet or category of the same name first (this import's planned one is then not written).
 */
const MAX_ATTEMPTS = 3;
/** Rows without a category go to FALLBACK_EXPENSE_CATEGORY (expense) or the "Pemasukan Lain" preset (income). */
const FALLBACK_INCOME_CATEGORY = 'Pemasukan Lain';
/** Longest payment method, recurrence, tag or reference kept from a cell. */
const EXTRA_MAX_LENGTH = 100;
/** Imported rows carry no time: noon WIB on their date, so they sort inside their day without a fake time. */
const IMPORTED_TIME = '12:00';

export type CsvRefusal = CsvParseError | 'format_mismatch' | 'format_unknown';

/** What an import or preview found, all computed on the server from the raw text. */
export interface CsvCounts {
	/** Non-blank records read (at most CSV_MAX_ROWS). */
	rows: number;
	/** Written now (import) or ready to write (preview). */
	imported: number;
	/** Transfers, unreadable dates/amounts, rows without a wallet, rows the validator refused, possible duplicates left out. */
	skipped: number;
	/** Non-IDR rows (owner decision D), reported apart from `skipped`. */
	foreignCurrency: number;
	/** Rows of this very file already imported earlier (same dedupe key). */
	already: number;
	/** Rows matching a live transaction of the space by date, type, amount and title ("Mungkin duplikat"). */
	possibleDuplicates: number;
	/** Records past CSV_MAX_ROWS, not processed in this request. */
	notProcessed: number;
}

export interface PossibleDuplicate {
	/** Record number in the file (1 = the first row after the header). */
	line: number;
	date: string;
	type: CategoryKind;
	title: string;
	amountMinor: number;
}

/** The sources an import writes through this module: FN-18 CSV files, FN-16a statements, FN-17 spreadsheets. */
export type ImportRowSource = 'csv' | 'statement' | 'spreadsheet';

/**
 * A file read into mapped rows on the server: the CSV reader below, or a statement parser (FN-16a). Every row
 * is keyed `<keyPrefix><row index>`; the prefix is `<source>:<file hash>:`.
 */
export interface PreparedRows {
	source: ImportRowSource;
	/** The CSV template (FN-18); null for a statement or a spreadsheet (`import_batches.format` holds CSV shapes only). */
	format: CsvFormat | null;
	rows: MappedRow[];
	notProcessed: number;
	keyPrefix: string;
	/**
	 * Per row index, the row's own dedupe key, when it is not `<keyPrefix><index>`: on-device OCR rows (FN-16g)
	 * are keyed by what they say, because the server never sees the image's bytes.
	 */
	keys?: ReadonlyMap<number, string>;
}

/** Dedupe key of a record: `<source>:<file hash>:<record index>` (checklist › Idempotent capture). */
const dedupeKey = (prefix: string, index: number) => `${prefix}${index}`;

/** Re-parses the raw text with the same shared functions as the device preview (never a client row list). */
async function prepare(
	text: string,
	format: CsvFormat | null
): Promise<
	{ ok: true; value: PreparedRows & { format: CsvFormat } } | { ok: false; error: CsvRefusal }
> {
	const read = readCsv(text, format);
	if (!read.ok) return read;
	const chosen = format ?? read.reading.detected;
	if (!chosen) return { ok: false, error: 'format_unknown' };
	// 128 bits of the SHA-256 of the exact text: the same file always gives the same keys.
	const hash = (await sha256Hex(text)).slice(0, 32);
	return {
		ok: true,
		value: {
			source: 'csv',
			format: chosen,
			rows: read.reading.rows.slice(0, CSV_MAX_ROWS),
			notProcessed: read.reading.notProcessed,
			keyPrefix: `csv:${hash}:`
		}
	};
}

/** Indexes of this file's records already written to the space (live or tombstoned), one indexed range scan. */
async function alreadyImported(
	db: Db,
	spaceId: string,
	source: ImportRowSource,
	prefix: string,
	keys?: ReadonlyMap<number, string>
): Promise<Set<number>> {
	if (keys) {
		// Own keys (at most CSV_MAX_ROWS), bound once as JSON: one indexed lookup each.
		const indexOf = new Map([...keys].map(([i, k]) => [k, i]));
		const found = await db.all<{ k: string }>(sql`select dedupe_key as k from transactions
			where space_id = ${spaceId} and source = ${source}
			and dedupe_key in (select value from json_each(${JSON.stringify([...keys.values()])}))`);
		return new Set(
			found.flatMap((r) => {
				const i = indexOf.get(r.k);
				return i === undefined ? [] : [i];
			})
		);
	}
	// Keys are `<prefix><digits>`; ':' sorts right after '9', so the range holds exactly this file's keys.
	const upper = prefix.slice(0, -1) + ';';
	const rows = await db.all<{ k: string }>(sql`select dedupe_key as k from transactions
		where space_id = ${spaceId} and source = ${source} and dedupe_key > ${prefix} and dedupe_key < ${upper}
		limit ${CSV_MAX_ROWS + 1}`);
	return new Set(rows.map((r) => Number(r.k.slice(prefix.length))));
}

/** The title as stored (cleaned, capped), lower-cased like SQLite `lower()` for the duplicate match. */
const cleanTitle = (title: string) => cleanText(title, TITLE_MAX_LENGTH);

/**
 * Indexes of `rows` that look like a live, real IDR transaction of the space: same WIB date, type, amount and
 * title (case-insensitive). One query, the rows bound once as JSON.
 */
async function possibleDuplicates(
	db: Db,
	spaceId: string,
	rows: readonly { index: number; value: RawCsvTransaction }[]
): Promise<Set<number>> {
	if (rows.length === 0) return new Set();
	const json = JSON.stringify(
		rows.map((r) => ({
			i: r.index,
			d: r.value.date,
			y: r.value.type,
			a: r.value.amountMinor,
			t: asciiLowerKey(cleanTitle(r.value.title))
		}))
	);
	const found = await db.all<{ i: number }>(sql`select json_extract(j.value, '$.i') as i
		from json_each(${json}) j
		where exists (select 1 from transactions t where t.space_id = ${spaceId} and t.deleted_at is null
			and t.occurred_on = json_extract(j.value, '$.d') and t.type = json_extract(j.value, '$.y')
			and t.amount_minor = json_extract(j.value, '$.a') and t.currency = 'IDR' and t.is_demo = 0
			and lower(coalesce(t.title, '')) = json_extract(j.value, '$.t'))`);
	return new Set(found.map((r) => r.i));
}

interface Classified {
	counts: CsvCounts;
	/** Ready rows, not yet imported, in file order. */
	fresh: { index: number; value: RawCsvTransaction }[];
	flagged: Set<number>;
}

async function classify(db: Db, spaceId: string, prepared: PreparedRows): Promise<Classified> {
	const done = await alreadyImported(
		db,
		spaceId,
		prepared.source,
		prepared.keyPrefix,
		prepared.keys
	);
	const counts: CsvCounts = {
		rows: prepared.rows.length,
		imported: 0,
		skipped: 0,
		foreignCurrency: 0,
		already: 0,
		possibleDuplicates: 0,
		notProcessed: prepared.notProcessed
	};
	const fresh: Classified['fresh'] = [];
	for (const r of prepared.rows) {
		if (done.has(r.index)) counts.already++;
		else if (r.ok) fresh.push({ index: r.index, value: r.value });
		else if (r.reason === 'unsupported_currency') counts.foreignCurrency++;
		else counts.skipped++;
	}
	const flagged = await possibleDuplicates(db, spaceId, fresh);
	counts.possibleDuplicates = flagged.size;
	return { counts, fresh, flagged };
}

export type PreviewCsvResult =
	| {
			ok: true;
			format: CsvFormat;
			counts: CsvCounts;
			duplicates: PossibleDuplicate[];
	  }
	| { ok: false; error: CsvRefusal };

/** "Pratinjau": what an import of this file would do now, with the possible duplicates listed. Writes nothing. */
export async function previewCsv(
	db: Db,
	spaceId: string,
	input: { fileText: string; format: CsvFormat | null }
): Promise<PreviewCsvResult> {
	const prepared = await prepare(input.fileText, input.format);
	if (!prepared.ok) return prepared;
	const { counts, duplicates } = await previewRows(db, spaceId, prepared.value);
	return { ok: true, format: prepared.value.format, counts, duplicates };
}

/** What importing prepared rows would do now (counts and the listed possible duplicates). Writes nothing. */
export async function previewRows(
	db: Db,
	spaceId: string,
	prepared: PreparedRows
): Promise<{ counts: CsvCounts; duplicates: PossibleDuplicate[] }> {
	const { counts, fresh, flagged } = await classify(db, spaceId, prepared);
	counts.imported = fresh.length;
	const duplicates = fresh
		.filter((r) => flagged.has(r.index))
		.slice(0, PREVIEW_DUPLICATES_MAX)
		.map((r) => ({
			line: r.index + 1,
			date: r.value.date,
			type: r.value.type,
			title: cleanTitle(r.value.title),
			amountMinor: r.value.amountMinor
		}));
	return { counts, duplicates };
}

export interface ImportCsvInput {
	fileText: string;
	filename: string | null;
	format: CsvFormat | null;
	defaultWalletId: string | null;
	skipPossibleDuplicates: boolean;
	/** FN-20: the app's bindings, so rows without a category cell may use the AI step (the user's own key). */
	merchantEnv?: MerchantEnv;
}

/** The bindings FN-20's resolver reads for its AI step. */
export type MerchantEnv = AiKeysEnv & AiGatewayEnv;

export type ImportCsvResult =
	| { ok: true; batchId: string | null; counts: CsvCounts }
	| { ok: false; error: CsvRefusal | ImportRowsFailure };

/** Why prepared rows were not written (nothing was). */
export type ImportRowsFailure = 'wallet_not_found' | 'gone' | 'limit' | 'busy';

export type ImportRowsResult =
	| { ok: true; batchId: string | null; counts: CsvCounts }
	| { ok: false; error: Exclude<ImportRowsFailure, 'wallet_not_found'> };

/**
 * The wallet rows that name none go to: null when none was chosen; `wallet_not_found` for an id that is not a
 * wallet of this space (another space's id gets the same answer). Checked before the file is read.
 */
export async function fallbackWalletOf(
	db: Db,
	spaceId: string,
	walletId: string | null
): Promise<{ ok: true; wallet: WalletRef | null } | { ok: false; error: 'wallet_not_found' }> {
	if (!walletId) return { ok: true, wallet: null };
	const w = await getWallet(db, spaceId, walletId);
	if (!w) return { ok: false, error: 'wallet_not_found' };
	return { ok: true, wallet: { id: w.id, currency: w.currency } };
}

export interface ImportRowsOptions {
	filename: string | null;
	fallbackWallet: WalletRef | null;
	skipPossibleDuplicates: boolean;
	/**
	 * Whether rows may create the wallets and categories they name (default true: CSV and statements). FN-17
	 * spreadsheets pass false: every row goes to `fallbackWallet` and to a visible category of the space
	 * (`matchVisibleCategory`), else to none ("Tanpa kategori"); nothing is created.
	 */
	createMissing?: boolean;
	/** FN-20: given, the resolver may ask AI for rows no deterministic layer names (else deterministic only). */
	merchantEnv?: MerchantEnv;
	/**
	 * FN-48 Part B: a statement's row dates and printed balances, recorded on the batch with `fallbackWallet`
	 * (every statement row goes there: statement rows name no wallet). Ignored without a fallback wallet.
	 */
	statement?: Omit<StatementFigures, 'walletId'> | null;
}

/** A free-text extra as stored: cleaned, capped, account and card numbers cut to the last 4 digits. */
const optional = (value: string, max: number) => maskAccountNumbers(cleanText(value, max)) || null;

/**
 * Imports a CSV file into the space (FN-18): the wallet checked, the raw text re-parsed here with the shared
 * reader, then written by `importRows`.
 */
export async function importCsv(
	db: Db,
	scope: SpaceScope,
	input: ImportCsvInput,
	now: number
): Promise<ImportCsvResult> {
	const fallback = await fallbackWalletOf(db, scope.spaceId, input.defaultWalletId);
	if (!fallback.ok) return fallback;
	const prepared = await prepare(input.fileText, input.format);
	if (!prepared.ok) return prepared;
	return importRows(
		db,
		scope,
		prepared.value,
		{
			filename: input.filename,
			fallbackWallet: fallback.wallet,
			skipPossibleDuplicates: input.skipPossibleDuplicates,
			merchantEnv: input.merchantEnv
		},
		now
	);
}

/**
 * The category name a row goes to: its own category cell (explicit data beats a guess, FN-20 owner decision
 * 10); else the name of the category FN-20's resolver found for its description (`resolvedName`); else, for an
 * expense whose description names a ride-hailing or food-delivery service (FN-39), the space's visible preset
 * with that tile under its current name (so it matches by name like any cell); else the kind's fallback.
 */
export function categoryNameOf(
	r: Pick<RawCsvTransaction, 'categoryName' | 'title' | 'type'>,
	presetOf: (tileKey: TileKey) => { name: string } | undefined,
	resolvedName?: (r: Pick<RawCsvTransaction, 'title' | 'type'>) => string | undefined
): string {
	const named = cleanText(r.categoryName, CATEGORY_NAME_MAX_LENGTH);
	if (named) return named;
	const resolved = resolvedName?.(r);
	if (resolved) return resolved;
	if (r.type !== 'expense') return FALLBACK_INCOME_CATEGORY;
	const tileKey = importCategoryFromTitle(cleanText(r.title, TITLE_MAX_LENGTH));
	const preset = tileKey === undefined ? undefined : presetOf(tileKey);
	return preset?.name ?? FALLBACK_EXPENSE_CATEGORY;
}

/** A space's categories as the import matches them: the visible ones by kind + name, and its visible presets. */
export function visibleCategoryIndex(
	categories: readonly {
		id: string;
		kind: CategoryKind;
		name: string;
		isHidden: boolean;
		isPreset: boolean;
		tileKey: TileKey | null;
	}[]
) {
	const byName = new Map<string, string>();
	for (const c of categories) {
		const key = categoryNameKey(c.kind, c.name);
		if (!c.isHidden && !byName.has(key)) byName.set(key, c.id);
	}
	const presetOf = (tileKey: TileKey) =>
		categories.find((c) => c.isPreset && !c.isHidden && c.tileKey === tileKey);
	return { byName, presetOf };
}

/**
 * FN-17: a row's category among the space's visible ones only — its category cell by exact normalised name
 * (`categoryNameKey`), else FN-20's resolver pick (`resolvedName`), else, for an expense, the preset its description names (FN-39 keywords) — or null
 * ("Tanpa kategori"). A hidden category is never a target and nothing is created.
 */
export function matchVisibleCategory(
	r: Pick<RawCsvTransaction, 'categoryName' | 'title' | 'type'>,
	index: ReturnType<typeof visibleCategoryIndex>,
	resolvedName?: (r: Pick<RawCsvTransaction, 'title' | 'type'>) => string | undefined
): string | null {
	const named = cleanText(r.categoryName, CATEGORY_NAME_MAX_LENGTH);
	const byName = named ? index.byName.get(categoryNameKey(r.type, named)) : undefined;
	if (byName) return byName;
	// FN-20: with no category cell, the resolver's pick, still only among the visible categories.
	const resolved = named ? undefined : resolvedName?.(r);
	const byResolved = resolved ? index.byName.get(categoryNameKey(r.type, resolved)) : undefined;
	if (byResolved) return byResolved;
	if (r.type !== 'expense') return null;
	const tileKey = importCategoryFromTitle(cleanText(r.title, TITLE_MAX_LENGTH));
	const preset = tileKey === undefined ? undefined : index.presetOf(tileKey);
	return preset && preset.kind === 'expense' ? preset.id : null;
}

/**
 * FN-48: who chose an imported row's category. A category cell is the user's own choice made elsewhere (`user`);
 * anything this import guessed or fell back to is `auto`, so "Rapikan kategori" may propose a better one later.
 */
export const categorySourceOf = (r: Pick<RawCsvTransaction, 'categoryName'>): CategorySource =>
	cleanText(r.categoryName, CATEGORY_NAME_MAX_LENGTH) ? 'user' : 'auto';

/** The resolver's lookup key of an imported row: its kind and cleaned description. */
const rowKey = (r: Pick<RawCsvTransaction, 'title' | 'type'>) =>
	layerKey(r.type, cleanDescriptor(r.title).key);

/**
 * FN-20: the category names the resolver finds for the rows that have no category cell, by `rowKey`. Distinct
 * descriptions only (at most the resolver's batch cap); a failed lookup resolves nothing and the import goes on
 * with FN-39's fallback, exactly as before FN-20.
 */
async function resolvedCategoryNames(
	db: Db,
	scope: SpaceScope,
	rows: readonly { value: RawCsvTransaction }[],
	categories: readonly CategorySummary[],
	env: MerchantEnv | undefined,
	now: number
): Promise<Map<string, string>> {
	const wanted = new Map<string, ResolveRequestItem>();
	for (const { value } of rows) {
		if (cleanText(value.categoryName, CATEGORY_NAME_MAX_LENGTH)) continue;
		const key = rowKey(value);
		if (!wanted.has(key)) wanted.set(key, { rawText: value.title, type: value.type });
	}
	const names = new Map<string, string>();
	if (wanted.size === 0) return names;
	try {
		const { items } = await resolveMerchants(db, scope, [...wanted.values()], {
			userId: scope.userId,
			allowAi: env !== undefined,
			env,
			now
		});
		const keys = [...wanted.keys()];
		items.forEach((item, i) => {
			const name = categories.find((c) => c.id === item.categoryId)?.name;
			if (name && keys[i]) names.set(keys[i], name);
		});
	} catch (e) {
		console.error('import: merchant lookup failed', e instanceof Error ? e.message : 'unknown');
	}
	return names;
}

/**
 * Imports rows the server prepared from a file (FN-18 CSV, FN-16a statements). Each ready
 * row's wallet (its name, else its payment method, else `defaultWalletId`) and category (`categoryNameOf`) are
 * looked up in the space or planned as new ones, then the row is checked by FN-05's
 * validator for captured rows (`capturedTransactionInput`). Only rows that pass are written, through FN-05's one
 * insert path with source `csv` and the dedupe key `csv:<file hash>:<record index>`; only the new wallets and
 * categories those rows use are created. Rows already imported from this file are counted, never written again.
 * New wallets and categories, the batch row and every transaction are one `db.batch` that asserts every row was
 * written (all or nothing: nothing is created when nothing is imported). A concurrent import that won a race is
 * answered by planning again.
 */
export async function importRows(
	db: Db,
	scope: SpaceScope,
	prepared: PreparedRows,
	input: ImportRowsOptions,
	now: number
): Promise<ImportRowsResult> {
	const { spaceId } = scope;
	const { fallbackWallet } = input;
	const createMissing = input.createMissing ?? true;
	const { source, format, keyPrefix, keys } = prepared;
	const walletNameOf = (r: RawCsvTransaction) =>
		maskAccountNumbers(cleanText(r.walletName, WALLET_NAME_MAX_LENGTH));

	let resolvedNames: Map<string, string> | null = null;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const { counts, fresh, flagged } = await classify(db, spaceId, prepared);
		const wanted = fresh.filter((r) => !(input.skipPossibleDuplicates && flagged.has(r.index)));
		counts.skipped += fresh.length - wanted.length;
		if (wanted.length === 0) return { ok: true, batchId: null, counts };

		await ensurePresetCategories(db, spaceId, now);
		const [allWallets, allCategories] = await Promise.all([
			listWallets(db, spaceId, { includeArchived: true }),
			listCategories(db, spaceId, { includeHidden: true })
		]);
		const liveWallets = new Map<string, WalletRef>();
		for (const w of allWallets) {
			const key = asciiLowerKey(w.name);
			if (!w.archived && !liveWallets.has(key))
				liveWallets.set(key, { id: w.id, currency: w.currency });
		}
		const categoryIndex = visibleCategoryIndex(allCategories);
		const visibleCategories = categoryIndex.byName;
		// Resolved once per import (a retried attempt reuses it: no second AI call).
		resolvedNames ??= await resolvedCategoryNames(
			db,
			scope,
			wanted,
			allCategories.filter((c) => !c.isHidden),
			input.merchantEnv,
			now
		);
		const names = resolvedNames;
		const resolvedName = (row: Pick<RawCsvTransaction, 'title' | 'type'>) => names.get(rowKey(row));
		const categoryOf = (r: RawCsvTransaction) =>
			categoryNameOf(r, categoryIndex.presetOf, resolvedName);
		// New names get an id once; they are created only when a row that passed the validator uses them.
		const planned = new Map<string, string>();
		const plannedId = (key: string) => planned.get(key) ?? planned.set(key, newId()).get(key)!;
		const newWallets = new Map<string, { id: string; name: string }>();
		const newCategories = new Map<string, { id: string; kind: CategoryKind; name: string }>();
		let walletRoom = MAX_WALLETS_PER_SPACE - allWallets.length;
		let categoryRoom = MAX_CATEGORIES_PER_SPACE - allCategories.length;

		const batchId = newId();
		const rows: NewTransaction[] = [];
		for (const { index, value } of wanted) {
			if (!createMissing) {
				// FN-17: the chosen wallet and a visible category, or none; never a new wallet or category.
				const categoryId = matchVisibleCategory(value, categoryIndex, resolvedName);
				const checked = capturedTransactionInput(
					{
						type: value.type,
						amountMinor: value.amountMinor,
						currency: value.currency,
						walletId: fallbackWallet?.id ?? null,
						categoryId,
						title: value.title,
						note: value.notes,
						occurredOn: value.date
					},
					{
						wallet: fallbackWallet,
						toWallet: null,
						category: categoryId ? { id: categoryId, kind: value.type } : null
					},
					{ allowNoCategory: true }
				);
				if (!checked.ok) {
					counts.skipped++;
					continue;
				}
				rows.push({
					id: newId(),
					input: checked.value,
					origin: {
						source,
						dedupeKey: dedupeKey(keyPrefix, index),
						occurredAt: wibInstantUtcMs(value.date, IMPORTED_TIME),
						categorySource: categorySourceOf(value)
					},
					importBatchId: batchId,
					extras: { paymentMethod: null, recurrence: null, tag: null, reference: null },
					allowNoCategory: categoryId === null
				});
				continue;
			}
			const name = walletNameOf(value);
			const walletKey = asciiLowerKey(name);
			const existingWallet = name ? (liveWallets.get(walletKey) ?? null) : fallbackWallet;
			const wallet = existingWallet ?? { id: plannedId(`w:${walletKey}`), currency: 'IDR' };
			const categoryName = categoryOf(value);
			const categoryKey = categoryNameKey(value.type, categoryName);
			const categoryId = visibleCategories.get(categoryKey) ?? plannedId(`c:${categoryKey}`);
			const checked = capturedTransactionInput(
				{
					type: value.type,
					amountMinor: value.amountMinor,
					currency: value.currency,
					walletId: name || existingWallet ? wallet.id : null,
					categoryId,
					title: value.title,
					note: value.notes,
					occurredOn: value.date
				},
				{
					wallet: name || existingWallet ? wallet : null,
					toWallet: null,
					category: { id: categoryId, kind: value.type }
				}
			);
			const needsWallet = !existingWallet && !newWallets.has(walletKey);
			const needsCategory = !visibleCategories.has(categoryKey) && !newCategories.has(categoryKey);
			if (!checked.ok || (needsWallet && walletRoom < 1) || (needsCategory && categoryRoom < 1)) {
				counts.skipped++;
				continue;
			}
			if (needsWallet) {
				newWallets.set(walletKey, { id: wallet.id, name });
				walletRoom--;
			}
			if (needsCategory) {
				newCategories.set(categoryKey, { id: categoryId, kind: value.type, name: categoryName });
				categoryRoom--;
			}
			rows.push({
				id: newId(),
				input: checked.value,
				origin: {
					source,
					dedupeKey: keys?.get(index) ?? dedupeKey(keyPrefix, index),
					occurredAt: wibInstantUtcMs(value.date, IMPORTED_TIME),
					categorySource: categorySourceOf(value)
				},
				importBatchId: batchId,
				extras: {
					paymentMethod: optional(value.paymentMethod, EXTRA_MAX_LENGTH),
					recurrence: optional(value.recurrence, EXTRA_MAX_LENGTH),
					tag: optional(value.tag, EXTRA_MAX_LENGTH),
					reference: optional(value.reference, EXTRA_MAX_LENGTH)
				}
			});
		}
		counts.imported = rows.length;
		if (rows.length === 0) return { ok: true, batchId: null, counts };

		const chunks: NewTransaction[][] = [];
		for (let i = 0; i < rows.length; i += INSERT_CHUNK)
			chunks.push(rows.slice(i, i + INSERT_CHUNK));
		const batchExists = () => sql`exists (select 1 from import_batches b where b.id = ${batchId})`;
		try {
			await db.batch([
				bumpSpaceSeq(db, spaceId),
				...(newWallets.size > 0
					? insertImportedWallets(db, scope, [...newWallets.values()], now)
					: []),
				...(newCategories.size > 0
					? [insertImportedCategories(db, scope, [...newCategories.values()], now)]
					: []),
				createImportBatch(
					db,
					scope,
					{
						id: batchId,
						source,
						format,
						filename: input.filename,
						rowCount: counts.rows,
						importedCount: counts.imported,
						skippedCount: counts.skipped + counts.foreignCurrency,
						alreadyImportedCount: counts.already,
						statement:
							input.statement && fallbackWallet
								? { walletId: fallbackWallet.id, ...input.statement }
								: null
					},
					now
				),
				...chunks.map((chunk) => insertTransactions(db, scope, chunk, now, batchExists)),
				batchAssert(
					db,
					sql`(select count(*) from transactions t where t.space_id = ${spaceId}
						and t.import_batch_id = ${batchId}) = ${rows.length}`
				)
			]);
			return { ok: true, batchId, counts };
		} catch (e) {
			// Another request imported (some of) this file first: count again, write only what is left.
			if (isUniqueViolation(e)) continue;
			if (!isBatchAssertFailure(e)) throw e;
		}
		const [live] = await db.all<{ n: number }>(
			sql`select count(*) as n from transactions where space_id = ${spaceId} and deleted_at is null`
		);
		if ((live?.n ?? 0) + rows.length > MAX_TRANSACTIONS_PER_SPACE)
			return { ok: false, error: 'limit' };
		// A wallet or category of the same name may have been created meanwhile: plan again, then give up.
		if (attempt === MAX_ATTEMPTS - 1) return { ok: false, error: 'gone' };
	}
	return { ok: false, error: 'busy' };
}
