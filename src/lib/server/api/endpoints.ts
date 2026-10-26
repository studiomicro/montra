import type { z } from 'zod';
import type { ApiTokenScope } from '#lib/shared/api-tokens';
import { msg } from '#lib/shared/i18n';
import {
	budgetResponse,
	categoriesResponse,
	createTransactionBody,
	deletedResponse,
	deleteQuery,
	laporanQuery,
	laporanResponse,
	spaceQuery,
	spacesResponse,
	transactionResponse,
	transactionsQuery,
	transactionsResponse,
	updateTransactionBody,
	walletsResponse
} from './schemas';

/**
 * FN-38: the public API's routes as data. Each `+server.ts` under `src/routes/api/v1/` names its entry here
 * (`apiRoute(ENDPOINTS.x, …)`), so the handler parses with the same query/body schema the OpenAPI document
 * and the docs page describe. The most D1 statements one call may run is kept out of the public document (red
 * team L3) and asserted per route in test/integration/public-api.test.ts (D1_BUDGET), the hook's session
 * lookup included, far inside the 1,000-per-invocation limit.
 */
export interface ApiEndpoint {
	operationId: string;
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	/** OpenAPI path template (`{id}` for the transaction id). */
	path: string;
	summary: string;
	scope: ApiTokenScope;
	query?: z.ZodObject;
	body?: z.ZodObject;
	success: { status: 200 | 201; schema: z.ZodObject; description: string };
	/** Error statuses this route can answer besides 401, 429 and 500 (every route can). */
	errors: readonly number[];
}

export const ENDPOINTS = {
	listSpaces: {
		operationId: 'listSpaces',
		method: 'GET',
		path: '/api/v1/spaces',
		summary: msg('Daftar ruang tempat kamu menjadi anggota.'),
		scope: 'read',
		success: { status: 200, schema: spacesResponse, description: msg('Ruangmu.') },
		errors: []
	},
	listWallets: {
		operationId: 'listWallets',
		method: 'GET',
		path: '/api/v1/wallets',
		summary: msg('Dompet di satu ruang, termasuk yang diarsipkan (paling banyak 50).'),
		scope: 'read',
		query: spaceQuery,
		success: { status: 200, schema: walletsResponse, description: msg('Dompet ruang ini.') },
		errors: [400, 404]
	},
	listCategories: {
		operationId: 'listCategories',
		method: 'GET',
		path: '/api/v1/categories',
		summary: msg('Kategori di satu ruang, termasuk yang disembunyikan (paling banyak 100).'),
		scope: 'read',
		query: spaceQuery,
		success: { status: 200, schema: categoriesResponse, description: msg('Kategori ruang ini.') },
		errors: [400, 404]
	},
	listTransactions: {
		operationId: 'listTransactions',
		method: 'GET',
		path: '/api/v1/transactions',
		summary: msg(
			'Transaksi satu ruang, terbaru dulu, dengan filter dan total yang sama seperti Riwayat.'
		),
		scope: 'read',
		query: transactionsQuery,
		success: {
			status: 200,
			schema: transactionsResponse,
			description: msg('Satu halaman transaksi dan total filternya.')
		},
		errors: [400, 404]
	},
	getTransaction: {
		operationId: 'getTransaction',
		method: 'GET',
		path: '/api/v1/transactions/{id}',
		summary: msg(
			'Satu transaksi, dengan catatan dan `updated_at` untuk mengubah atau menghapusnya.'
		),
		scope: 'read',
		query: spaceQuery,
		success: { status: 200, schema: transactionResponse, description: msg('Transaksinya.') },
		errors: [400, 404]
	},
	createTransaction: {
		operationId: 'createTransaction',
		method: 'POST',
		path: '/api/v1/transactions',
		summary: msg(
			'Catat pengeluaran, pemasukan atau transfer. Aman dikirim ulang dengan `client_id` sama.'
		),
		scope: 'read_write',
		query: spaceQuery,
		body: createTransactionBody,
		success: {
			status: 201,
			schema: transactionResponse,
			description: msg('Transaksi tersimpan (atau yang sudah tersimpan dengan `client_id` ini).')
		},
		errors: [400, 403, 404, 409, 413, 415]
	},
	updateTransaction: {
		operationId: 'updateTransaction',
		method: 'PATCH',
		path: '/api/v1/transactions/{id}',
		summary: msg('Ubah transaksi. Kolom yang tidak dikirim tetap seperti semula.'),
		scope: 'read_write',
		query: spaceQuery,
		body: updateTransactionBody,
		success: {
			status: 200,
			schema: transactionResponse,
			description: msg('Transaksi setelah diubah.')
		},
		errors: [400, 403, 404, 409, 413, 415]
	},
	deleteTransaction: {
		operationId: 'deleteTransaction',
		method: 'DELETE',
		path: '/api/v1/transactions/{id}',
		summary: msg('Hapus transaksi.'),
		scope: 'read_write',
		query: deleteQuery,
		success: { status: 200, schema: deletedResponse, description: msg('Transaksi dihapus.') },
		errors: [400, 403, 404, 409]
	},
	getBudget: {
		operationId: 'getBudget',
		method: 'GET',
		path: '/api/v1/budgets',
		summary: msg('Anggaran bulanan ruang ini, atau null bila belum diatur.'),
		scope: 'read',
		query: spaceQuery,
		success: { status: 200, schema: budgetResponse, description: msg('Anggaran ruang ini.') },
		errors: [400, 404]
	},
	laporanSummary: {
		operationId: 'laporanSummary',
		method: 'GET',
		path: '/api/v1/laporan/ringkasan',
		summary: msg(
			'Ringkasan Laporan satu bulan: uang masuk dan keluar, per kategori, dan perbandingan.'
		),
		scope: 'read',
		query: laporanQuery,
		success: { status: 200, schema: laporanResponse, description: msg('Ringkasan bulan itu.') },
		errors: [400, 404]
	}
} as const satisfies Record<string, ApiEndpoint>;
