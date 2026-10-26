import { FLOW_LOAD_FAILED, moneyFlowReport } from '#lib/server/reports/money-flow';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { errorLabel } from '#lib/server/util';
import { wibTodayString } from '#lib/shared/dates';
import { parseReportPeriod } from '#lib/shared/report-period';
import type { PageServerLoad } from './$types';

// Alur uang (FN-35; Bulan | Kuartal | Tahun since FN-53) is read-only and works on the session's current space
// (locals.space), re-checked through requireSpaceAccess on every load (currentSpaceScope), like Laporan. No space
// id is ever read from the URL; `?p=`, `?k=`, `?y=` and `?m=` only name the period (this WIB month by default).

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	const period = parseReportPeriod(url.searchParams, today, 'bulan');
	try {
		const report = await moneyFlowReport(locals.db, spaceId, period, today);
		return { today, period, report, loadError: null };
	} catch (e) {
		// Never the error's message: a D1 error carries SQL text and bound values.
		console.error('alur-uang: report failed', errorLabel(e));
		return { today, period, report: null, loadError: FLOW_LOAD_FAILED };
	}
};
