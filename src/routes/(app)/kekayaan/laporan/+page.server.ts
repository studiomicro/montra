import { getEnv } from '#lib/server/env';
import {
	liveNetWorth,
	netWorthPeriodReport,
	NW_REPORT_LOAD_FAILED
} from '#lib/server/net-worth/period';
import { readPriceBook } from '#lib/server/net-worth/prices';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { errorLabel } from '#lib/server/util';
import { wibTodayString } from '#lib/shared/dates';
import { parseReportPeriod, periodDates } from '#lib/shared/report-period';
import type { PageServerLoad } from './$types';

// Laporan kekayaan (FN-53): read-only, no form action. Works on the session's current space (locals.space),
// re-checked through requireSpaceAccess on every load (currentSpaceScope); no space id is read from the URL. The
// current quarter (so far) is the default. Only a period containing today reads the price cache and the wallets
// (its closing value is the live total, the Kekayaan hero's figure); a past period reads two snapshot queries.

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const now = Date.now();
	const today = wibTodayString(now);
	const period = parseReportPeriod(url.searchParams, today, 'kuartal');
	try {
		const live = periodDates(period, today).partial
			? await liveNetWorth(locals.db, spaceId, await readPriceBook(getEnv().CACHE, now), now)
			: null;
		const report = await netWorthPeriodReport(locals.db, spaceId, period, today, live);
		return { today, period, report, loadError: null };
	} catch (e) {
		// Never the error's message: a D1 error carries SQL text and bound values.
		console.error('kekayaan-laporan: report failed', errorLabel(e));
		return { today, period, report: null, loadError: NW_REPORT_LOAD_FAILED };
	}
};
