import { FLOW_LOAD_FAILED, moneyFlowReport } from '#lib/server/reports/money-flow';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { errorLabel } from '#lib/server/util';
import { wibTodayString } from '#lib/shared/dates';
import { parseFlowMonth } from '#lib/shared/money-flow';
import type { PageServerLoad } from './$types';

// Alur uang (FN-35) is read-only and works on the session's current space (locals.space), re-checked through
// requireSpaceAccess on every load (currentSpaceScope), like Laporan. No space id is ever read from the URL.

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const today = wibTodayString();
	const month = parseFlowMonth(url.searchParams, today);
	try {
		const report = await moneyFlowReport(locals.db, spaceId, month);
		return { today, month, report, loadError: null };
	} catch (e) {
		// Never the error's message: a D1 error carries SQL text and bound values.
		console.error('alur-uang: report failed', errorLabel(e));
		return { today, month, report: null, loadError: FLOW_LOAD_FAILED };
	}
};
