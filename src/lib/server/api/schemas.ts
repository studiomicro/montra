import { z } from 'zod';
import { msg } from '#lib/shared/i18n';
import {
	ADJUSTMENT_DIRECTIONS,
	CATEGORY_KINDS,
	FORM_TRANSACTION_TYPES,
	SEARCH_MAX_LENGTH,
	TILE_KEYS,
	TRANSACTION_SOURCES,
	TRANSACTION_TYPES
} from '#lib/shared/transactions';
import { WALLET_TYPES } from '#lib/shared/wallets';
import { API_TOKEN_SCOPES } from '#lib/shared/api-tokens';
import { PAGE_SIZE } from '../transactions/aggregate';
import { MAX_AMOUNT_MINOR } from '../transactions/validation';

/**
 * FN-38 public API: every request and response shape, as zod schemas. The handlers parse queries and bodies
 * with these and type their answers with them; the OpenAPI document (openapi.ts) is generated from the very
 * same objects, so the spec cannot drift from the code. Descriptions are Indonesian `msg()` phrases: the docs
 * page shows them in the reader's language, `/api/v1/openapi.json` in English.
 *
 * Request bodies check JSON types only (string, integer, null); every value rule (amount range, ids in the
 * space, category kind, date, time) is the compose form's own (transactions/validation.ts), never a second one.
 */

const describe = (text: string) => ({ description: text });

const id = z.string().meta({ ...describe(msg('ID (UUID).')), format: 'uuid' });
const epochMs = z
	.int()
	.min(0)
	.meta(describe(msg('Waktu dalam milidetik sejak epoch Unix (UTC).')));
const minor = z
	.int()
	.meta(describe(msg('Jumlah dalam satuan terkecil mata uang (bilangan bulat).')));
const nullableMinor = minor
	.nullable()
	.meta(describe(msg('Jumlah dalam satuan terkecil; null bila terlalu besar untuk ditampilkan.')));
const currency = z
	.string()
	.meta({ ...describe(msg('Kode mata uang ISO 4217.')), pattern: '^[A-Z]{3}$' });
const wibDate = z
	.string()
	.meta({ ...describe(msg('Tanggal kalender WIB (YYYY-MM-DD).')), format: 'date' });

// ---------------------------------------------------------------------------------------------- queries

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PARAM = z.string().min(1).max(64);

export const spaceQuery = z.object({
	space_id: ID_PARAM.meta(describe(msg('Ruang yang dibaca atau diubah. Wajib.')))
});

export const transactionsQuery = spaceQuery.extend({
	cursor: z
		.string()
		.max(128)
		.optional()
		.meta(describe(msg('Nilai `next_cursor` dari halaman sebelumnya.'))),
	limit: z
		.string()
		.regex(/^\d{1,3}$/)
		.optional()
		.meta(describe(msg('Jumlah baris per halaman, 1 sampai 50. Bawaan 50.'))),
	type: z
		.enum(TRANSACTION_TYPES)
		.optional()
		.meta(describe(msg('Hanya baris jenis ini.'))),
	category_id: ID_PARAM.optional().meta(describe(msg('Hanya baris kategori ini.'))),
	wallet_id: ID_PARAM.optional().meta(
		describe(msg('Hanya baris yang dibayar dari, masuk ke, atau ditransfer dari/ke dompet ini.'))
	),
	from: z
		.string()
		.regex(DATE_PATTERN)
		.optional()
		.meta(describe(msg('Tanggal WIB pertama (YYYY-MM-DD). Bersama `to`; bawaan bulan ini.'))),
	to: z
		.string()
		.regex(DATE_PATTERN)
		.optional()
		.meta(describe(msg('Tanggal WIB terakhir (YYYY-MM-DD), paling jauh 366 hari dari `from`.'))),
	q: z
		.string()
		.max(SEARCH_MAX_LENGTH)
		.optional()
		.meta(describe(msg('Cari di judul atau catatan.')))
});

export const laporanQuery = spaceQuery.extend({
	bulan: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.optional()
		.meta(describe(msg('Bulan WIB (YYYY-MM), dari 2000-01 sampai bulan ini. Bawaan bulan ini.'))),
	arah: z
		.enum(['keluar', 'masuk'])
		.optional()
		.meta(describe(msg('Rincian kategori untuk uang keluar (bawaan) atau uang masuk.')))
});

export const deleteQuery = spaceQuery.extend({
	expected_updated_at: z
		.string()
		.regex(/^\d{1,16}$/)
		.meta(describe(msg('`updated_at` baris saat terakhir dibaca. Wajib.')))
});

// ---------------------------------------------------------------------------------------------- bodies

const optionalText = z.string().nullable().optional();

/** The compose form's fields, JSON-typed. Values are checked by transactions/validation.ts. */
const transactionFields = {
	type: z.string().meta({
		...describe(msg('Jenis transaksi. Penyesuaian saldo tidak bisa dibuat lewat API.')),
		enum: [...FORM_TRANSACTION_TYPES]
	}),
	amount_minor: z.int().meta({
		...describe(msg('Jumlah dalam satuan terkecil mata uang dompet, bilangan bulat positif.')),
		minimum: 1,
		maximum: MAX_AMOUNT_MINOR
	}),
	wallet_id: z.string().meta(describe(msg('Dompet asal (dompet aktif di ruang ini).'))),
	transfer_to_wallet_id: optionalText.meta(
		describe(msg('Dompet tujuan, hanya untuk transfer (mata uang sama).'))
	),
	category_id: optionalText.meta(
		describe(msg('Kategori sesuai jenis, wajib untuk pengeluaran dan pemasukan.'))
	),
	title: optionalText.meta(describe(msg('Judul, paling banyak 80 karakter.'))),
	note: optionalText.meta(describe(msg('Catatan, paling banyak 500 karakter.'))),
	occurred_on: z
		.string()
		.meta({ ...describe(msg('Tanggal kalender WIB (YYYY-MM-DD).')), format: 'date' }),
	occurred_time: optionalText.meta({
		...describe(
			msg('Jam WIB (HH:MM). Tanpa jam: waktu simpan (baru) atau waktu tersimpan (ubah).')
		),
		pattern: '^\\d{2}:\\d{2}$'
	})
};

export const createTransactionBody = z.object({
	client_id: z.string().meta({
		...describe(
			msg(
				'UUID buatanmu untuk transaksi ini. Kirim ulang dengan nilai sama tidak membuat baris kedua.'
			)
		),
		format: 'uuid'
	}),
	...transactionFields
});
export type CreateTransactionBody = z.infer<typeof createTransactionBody>;

export const updateTransactionBody = z.object({
	expected_updated_at: z
		.int()
		.min(0)
		.meta(describe(msg('`updated_at` baris saat terakhir dibaca. Bila sudah berubah: 409.'))),
	type: transactionFields.type.optional(),
	amount_minor: transactionFields.amount_minor.optional(),
	wallet_id: transactionFields.wallet_id.optional(),
	transfer_to_wallet_id: transactionFields.transfer_to_wallet_id,
	category_id: transactionFields.category_id,
	title: transactionFields.title,
	note: transactionFields.note,
	occurred_on: transactionFields.occurred_on.optional(),
	occurred_time: transactionFields.occurred_time
});
export type UpdateTransactionBody = z.infer<typeof updateTransactionBody>;

// ---------------------------------------------------------------------------------------------- responses

export const apiSpace = z.object({
	id,
	kind: z.enum(['personal', 'shared']),
	name: z.string(),
	role: z.enum(['owner', 'member'])
});

export const apiWallet = z.object({
	id,
	name: z.string(),
	type: z.enum(WALLET_TYPES),
	currency,
	opening_balance_minor: minor,
	is_favourite: z.boolean(),
	last_four: z
		.string()
		.nullable()
		.meta(describe(msg('Empat digit terakhir nomor rekening atau kartu.'))),
	archived: z.boolean(),
	created_at: epochMs,
	updated_at: epochMs
});

export const apiCategory = z.object({
	id,
	kind: z.enum(CATEGORY_KINDS),
	name: z.string(),
	tile_key: z.enum(TILE_KEYS),
	is_preset: z.boolean(),
	is_hidden: z.boolean()
});

const ref = z.object({ id, name: z.string() });

/** FN-49: the split a row is the bill (or the payer's own share) of; null for every other row. */
const patunganLink = z
	.object({
		split_id: id,
		effective_amount_minor: minor.meta(
			describe(msg('Bagian pembayar sendiri: jumlah yang dihitung baris ini di setiap total.'))
		)
	})
	.nullable()
	.meta(
		describe(
			msg(
				'Patungan: amount_minor tetap jumlah yang tercatat, tetapi setiap total (termasuk totals di sini dan /laporan/ringkasan) hanya menghitung effective_amount_minor. Menjumlahkan amount_minor sendiri akan lebih besar dari total itu.'
			)
		)
	);

export const apiTransactionRow = z.object({
	id,
	type: z.enum(TRANSACTION_TYPES),
	amount_minor: minor,
	currency,
	title: z.string().nullable(),
	occurred_on: wibDate,
	occurred_at: epochMs,
	source: z.enum(TRANSACTION_SOURCES),
	is_demo: z
		.boolean()
		.meta(describe(msg('Data demo: ditampilkan, tetapi tidak pernah dihitung dalam total.'))),
	category: ref.extend({ tile_key: z.enum(TILE_KEYS) }).nullable(),
	wallet: ref,
	transfer_to_wallet: ref.nullable(),
	adjustment_direction: z.enum(ADJUSTMENT_DIRECTIONS).nullable(),
	recurring_series_id: z.string().nullable(),
	patungan: patunganLink
});

export const apiTransaction = z.object({
	id,
	type: z.enum(TRANSACTION_TYPES),
	amount_minor: minor,
	currency,
	wallet_id: z.string(),
	transfer_to_wallet_id: z.string().nullable(),
	category_id: z.string().nullable(),
	adjustment_direction: z.enum(ADJUSTMENT_DIRECTIONS).nullable(),
	title: z.string().nullable(),
	note: z.string().nullable(),
	occurred_on: wibDate,
	occurred_at: epochMs,
	source: z.enum(TRANSACTION_SOURCES),
	is_demo: z.boolean(),
	recurring_series_id: z.string().nullable(),
	patungan: patunganLink,
	updated_at: epochMs
});

const currencyTotals = z.object({ currency, in_minor: nullableMinor, out_minor: nullableMinor });

export const apiTotals = z
	.object({
		count: z.int(),
		expense_count: z.int(),
		income_count: z.int(),
		transfer_count: z.int(),
		adjustment_count: z.int(),
		by_currency: z.array(currencyTotals)
	})
	.meta(
		describe(
			msg(
				'Total semua baris yang cocok dengan filter (bukan hanya halaman ini), per mata uang, tanpa Data demo.'
			)
		)
	);

export const apiBudget = z.object({ amount_minor: minor, currency, updated_at: epochMs });

export const apiLaporanSummary = z.object({
	month: z.string(),
	from: wibDate,
	to: wibDate,
	direction: z.enum(['keluar', 'masuk']),
	currency: currency.meta(describe(msg('Mata uang rincian: mata uang dompet favorit, atau IDR.'))),
	totals: z.array(currencyTotals.extend({ net_minor: nullableMinor })),
	direction_total_minor: nullableMinor,
	categories: z.array(
		z.object({
			category_id: z.string().nullable(),
			name: z.string().nullable(),
			tile_key: z.enum(TILE_KEYS),
			amount_minor: nullableMinor,
			percent: z.int().nullable()
		})
	),
	comparison: z.object({
		previous_month: z.string(),
		diff_minor: nullableMinor.meta(
			describe(msg('Selisih dengan bulan sebelumnya pada hari yang sama.'))
		)
	}),
	other_currencies: z.array(currency)
});

export const ERROR_CODES = [
	'invalid_request',
	'invalid_json',
	'validation_failed',
	'unauthorized',
	'insufficient_scope',
	'not_found',
	'stale',
	'limit_reached',
	'gone',
	// FN-49: the edit would change the amount, currency or type of a split's bill (unlink in the app first).
	'linked',
	'payload_too_large',
	'unsupported_media_type',
	'rate_limited',
	'internal_error'
] as const;
export type ApiErrorCode = (typeof ERROR_CODES)[number];

export const apiError = z.object({
	error: z.object({
		code: z.enum(ERROR_CODES),
		message: z.string(),
		fields: z
			.record(z.string(), z.string())
			.optional()
			.meta(describe(msg('Pesan per kolom yang ditolak.')))
	})
});
export type ApiErrorBody = z.infer<typeof apiError>;

const list = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

export const spacesResponse = list(apiSpace);
export const walletsResponse = list(apiWallet);
export const categoriesResponse = list(apiCategory);
export const transactionsResponse = z.object({
	data: z.array(apiTransactionRow),
	next_cursor: z
		.string()
		.nullable()
		.meta(describe(msg('Untuk halaman berikutnya; null di halaman terakhir.'))),
	totals: apiTotals
});
export const transactionResponse = z.object({ data: apiTransaction });
export const budgetResponse = z.object({ data: apiBudget.nullable() });
export const laporanResponse = z.object({ data: apiLaporanSummary });
export const deletedResponse = z.object({ data: z.object({ id, deleted: z.literal(true) }) });

/** The scopes a token can carry, for the security scheme's description. */
export const SCOPES = API_TOKEN_SCOPES;
/** Rows per page of `GET /transactions` (Riwayat's own page size). */
export const API_PAGE_SIZE = PAGE_SIZE;
