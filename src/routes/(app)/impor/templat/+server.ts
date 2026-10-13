import { csvLine, TEMPLATE_COLUMNS } from '#lib/shared/csv';
import type { RequestHandler } from './$types';

/** The empty template (header plus one fictional example row), built from the one column list export uses. */
export const GET: RequestHandler = () =>
	new Response(
		'\uFEFF' +
			csvLine(TEMPLATE_COLUMNS) +
			csvLine([
				'2026-10-01',
				'expense',
				'Kopi Contoh',
				'28000',
				'IDR',
				'Kopi',
				'QRIS',
				'',
				'',
				'',
				'Tunai',
				''
			]),
		{
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': 'attachment; filename="montra-templat.csv"',
				'x-content-type-options': 'nosniff'
			}
		}
	);
