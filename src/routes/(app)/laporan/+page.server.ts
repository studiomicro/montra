import { LAPORAN_LOAD_FAILED, laporanReport } from '#lib/server/reports/laporan';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { wibTodayString } from '#lib/shared/dates';
import { parseLaporanQuery } from '#lib/shared/laporan-query';
import type { PageServerLoad } from './$types';

// Laporan is read-only and works on the session's current space (locals.space), re-checked through
// requireSpaceAccess on every load (currentSpaceScope). No space id is ever read from the URL.

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	const view = parseLaporanQuery(url.searchParams, today);
	try {
		const report = await laporanReport(locals.db, spaceId, today, view);
		return { today, view, report, loadError: null };
	} catch (e) {
		// Never the error object or its message: a D1 error carries SQL text. Only its name and code.
		const code = e instanceof Error && 'code' in e ? String(e.code).slice(0, 40) : '';
		console.error('laporan: report failed', e instanceof Error ? e.name : 'unknown', code);
		return { today, view, report: null, loadError: LAPORAN_LOAD_FAILED };
	}
};
