import { redirect } from '@sveltejs/kit';
import { exportTransactionsCsv } from '#lib/server/imports/csv-export';
import { parseExportRange } from '#lib/server/imports/validation';
import { currentSpaceScope } from '#lib/server/spaces/current';
import type { RequestHandler } from './$types';

/**
 * "Ekspor CSV" (owner decision E): a plain GET, so the browser downloads it with or without JavaScript. The space
 * is the session's current one, checked through `requireSpaceAccess`. A missing or reversed range goes back to
 * /impor with a message; a range longer than a year goes back with the range cut to a year, to download again.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const scope = await currentSpaceScope(locals);
	const range = parseExportRange(url.searchParams);
	if (!range.ok) redirect(303, '/impor?ekspor=salah#ekspor');
	if (range.truncated) {
		const back = new URLSearchParams({ ekspor: 'dipotong', from: range.from, to: range.to });
		redirect(303, `/impor?${back.toString()}#ekspor`);
	}
	return new Response(exportTransactionsCsv(locals.db, scope, range.from, range.to), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="montra-${range.from}-${range.to}.csv"`,
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
