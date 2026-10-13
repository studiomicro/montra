import { z } from 'zod';
import {
	API_REQUESTS_PER_WINDOW,
	API_TOKEN_LIFETIME_DAYS,
	API_TOKEN_MAX_PER_USER
} from '#lib/shared/api-tokens';
import { msg, type Translator } from '#lib/shared/i18n';
import { ENDPOINTS, type ApiEndpoint } from './endpoints';
import { API_AUTH_FAILURES_PER_WINDOW } from './http';
import { apiError } from './schemas';

/**
 * FN-38: the OpenAPI 3.1 document of the public API, built from ENDPOINTS and their zod schemas (the ones the
 * handlers parse with), never written by hand. `/api/v1/openapi.json` serves it in English; the docs page
 * (`/pengaturan/api/dokumentasi`) renders the same document in the reader's language. Every `description` and
 * `summary` is a msg() phrase translated by `t`.
 */

export const API_INTRO = msg(
	'API Montra untuk skrip dan aplikasimu sendiri: baca ruang, dompet, kategori, transaksi, anggaran dan ringkasan Laporan, lalu catat, ubah atau hapus transaksi. Uang selalu bilangan bulat dalam satuan terkecil (amount_minor) dengan kode mata uangnya.'
);
export const AUTH_TEXT = msg(
	'Kirim token di header Authorization: Bearer <token>. Buat token di Pengaturan → API; token hanya ditampilkan sekali. Cookie sesi tidak pernah diterima di sini.'
);
export const ERROR_TEXT = msg(
	'Setiap kesalahan berbentuk { "error": { "code", "message", "fields" } }. 401: token tidak dikenal, dicabut atau kedaluwarsa. 403: token hanya baca. 404: tidak ditemukan atau bukan ruangmu. 409: data berubah atau sudah tidak ada. 429: terlalu banyak permintaan.'
);
export const LIMITS_TEXT = msg(
	'Paling banyak {n} permintaan per token setiap 10 menit, dan {gagal} permintaan tanpa token yang sah per klien (lalu 429 dengan Retry-After). Paling banyak {max} token aktif per akun, berlaku {days} hari. Mengganti kata sandi mencabut semua token.'
);

const STATUS_TEXT: Record<number, string> = {
	400: msg('Permintaan tidak valid.'),
	401: msg('Token tidak dikenal, dicabut atau kedaluwarsa.'),
	403: msg('Token ini hanya bisa membaca.'),
	404: msg('Tidak ditemukan, atau bukan ruang yang bisa dibuka token ini.'),
	409: msg('Data sudah berubah, sudah dihapus, atau batas tercapai. Tidak ada yang ditulis.'),
	413: msg('Isi permintaan terlalu besar.'),
	415: msg('Kirim isi sebagai application/json.'),
	429: msg(
		'Terlalu banyak permintaan untuk token ini, atau terlalu banyak permintaan gagal dari klien ini.'
	),
	500: msg('Kesalahan server.')
};

/** Translates every `description` and `summary` string of a JSON Schema / OpenAPI fragment. */
function translated<T>(value: T, t: Translator): T {
	if (Array.isArray(value)) return value.map((v) => translated(v, t)) as T;
	if (value === null || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value))
		out[key] =
			(key === 'description' || key === 'summary') && typeof v === 'string'
				? t.tr(v)
				: translated(v, t);
	return out as T;
}

/** A zod schema as a plain JSON Schema 2020-12 node (OpenAPI 3.1's dialect), without `$schema`. */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
	const out = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
	delete out.$schema;
	return out;
}

function parameters(e: ApiEndpoint) {
	const path = e.path.includes('{id}')
		? [
				{
					name: 'id',
					in: 'path',
					required: true,
					description: msg('ID transaksi.'),
					schema: { type: 'string', format: 'uuid' }
				}
			]
		: [];
	const query = e.query
		? Object.entries(e.query.shape).map(([name, field]) => {
				const schema = jsonSchema(field as z.ZodType, 'input');
				const { description, ...rest } = schema;
				return {
					name,
					in: 'query',
					required: !(field as z.ZodType).safeParse(undefined).success,
					...(typeof description === 'string' ? { description } : {}),
					schema: rest
				};
			})
		: [];
	return [...path, ...query];
}

function operation(e: ApiEndpoint) {
	const errorRef = { $ref: '#/components/schemas/Error' };
	const statuses = [...e.errors, 401, 429, 500].sort((a, b) => a - b);
	return {
		operationId: e.operationId,
		summary: e.summary,
		security: [{ bearerToken: [] }],
		'x-montra-scope': e.scope,
		parameters: parameters(e),
		...(e.body
			? {
					requestBody: {
						required: true,
						content: { 'application/json': { schema: jsonSchema(e.body, 'input') } }
					}
				}
			: {}),
		responses: {
			[String(e.success.status)]: {
				description: e.success.description,
				content: { 'application/json': { schema: jsonSchema(e.success.schema, 'output') } }
			},
			...Object.fromEntries(
				statuses.map((s) => [
					String(s),
					{
						description: STATUS_TEXT[s] ?? '',
						content: { 'application/json': { schema: errorRef } },
						...(s === 429
							? {
									headers: {
										'Retry-After': {
											description: msg('Detik sampai jendela berikutnya.'),
											schema: { type: 'integer' }
										}
									}
								}
							: {})
					}
				])
			)
		}
	};
}

/** The API's version: `/api/v1`; the document's own version moves with it. */
const API_VERSION = '1.0.0';

/** The whole document in `t`'s language. */
export function openApiDocument(t: Translator) {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const e of Object.values(ENDPOINTS) as ApiEndpoint[]) {
		paths[e.path] ??= {};
		(paths[e.path] as Record<string, unknown>)[e.method.toLowerCase()] = operation(e);
	}
	const limits = t.trf(LIMITS_TEXT, {
		n: API_REQUESTS_PER_WINDOW,
		gagal: API_AUTH_FAILURES_PER_WINDOW,
		max: API_TOKEN_MAX_PER_USER,
		days: API_TOKEN_LIFETIME_DAYS.join('/')
	});
	return translated(
		{
			openapi: '3.1.0',
			info: {
				title: 'Montra API',
				version: API_VERSION,
				description: `${t.tr(API_INTRO)}\n\n${t.tr(ERROR_TEXT)}\n\n${limits}`
			},
			servers: [{ url: '/' }],
			paths,
			components: {
				securitySchemes: {
					bearerToken: { type: 'http', scheme: 'bearer', description: AUTH_TEXT }
				},
				schemas: { Error: jsonSchema(apiError, 'output') }
			}
		},
		t
	);
}
