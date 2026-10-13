import { ApiError, apiRoute } from '#lib/server/api/http';
import { ENDPOINTS } from '#lib/server/api/endpoints';
import { laporanOut } from '#lib/server/api/serialize';
import { laporanReport } from '#lib/server/reports/laporan';
import { isMonthString, monthOf, wibTodayString } from '#lib/shared/dates';
import { LAPORAN_MIN_YEAR } from '#lib/shared/laporan-query';

// FN-38 public API. Bearer-token authenticated only (apiRoute); `space_id` admitted by requireSpaceAccess.
// One month of Laporan (FN-09) through `laporanReport` itself, so the figures equal the Laporan page's.

export const GET = apiRoute(ENDPOINTS.laporanSummary, async ({ db, access, query, now }) => {
	const today = wibTodayString(now);
	const month = query.bulan ?? monthOf(today);
	if (!isMonthString(month) || month > monthOf(today) || month < `${LAPORAN_MIN_YEAR}-01`)
		throw new ApiError(
			400,
			'invalid_request',
			`Use a month from ${LAPORAN_MIN_YEAR}-01 to this month.`,
			{
				bulan: 'Invalid value.'
			}
		);
	const report = await laporanReport(db, access!.space.id, today, {
		mode: 'bulan',
		month,
		direction: query.arah ?? 'keluar'
	});
	return { data: laporanOut(report) };
});
