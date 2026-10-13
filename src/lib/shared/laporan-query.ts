import { isMonthString, monthOf, monthRange, shiftMonth } from './dates.ts';

/**
 * Which direction the report shows: money out (default) or money in. The income/expense totals are always
 * shown; the direction picks what the hero, charts and lists break down.
 */
export type LaporanDirection = 'keluar' | 'masuk';

/** Earliest year Laporan steps back to: every period stays bounded and every date valid. */
export const LAPORAN_MIN_YEAR = 2000;

/**
 * What /laporan shows, as the URL says it: `?p=YYYY-MM` (one month, the default) or `?y=YYYY` (one year), plus
 * `arah=masuk`. Plain links, so stepping periods works without JavaScript.
 */
export type LaporanView =
	| { mode: 'bulan'; month: string; direction: LaporanDirection }
	| { mode: 'tahun'; year: string; direction: LaporanDirection };

const YEAR = /^\d{4}$/;

/**
 * The view a URL asks for on the WIB date `today`. `y` wins over `p`; a future period becomes the current one,
 * one before LAPORAN_MIN_YEAR the earliest; anything unparsable means this month. The old `period=bulan-lalu`
 * and `period=tahun-ini` links still open their period; `m=bulan|tahun` then switches the mode. Never throws.
 */
export function parseLaporanQuery(params: URLSearchParams, today: string): LaporanView {
	const view = parsePeriod(params, today);
	// `m` is the Bulanan/Tahunan switch's form field (a plain GET form without JavaScript): it switches the
	// period the other fields name into the other mode.
	const mode = params.get('m');
	return mode === 'bulan' || mode === 'tahun' ? switchMode(view, mode, today) : view;
}

function parsePeriod(params: URLSearchParams, today: string): LaporanView {
	const direction: LaporanDirection = params.get('arah') === 'masuk' ? 'masuk' : 'keluar';
	const thisMonth = monthOf(today);
	const thisYear = today.slice(0, 4);
	const y = params.get('y') ?? '';
	const p = params.get('p') ?? '';
	const legacy = params.get('period');
	if (YEAR.test(y) || legacy === 'tahun-ini') {
		const year = YEAR.test(y) ? y : thisYear;
		return { mode: 'tahun', year: clampYear(year, thisYear), direction };
	}
	if (isMonthString(p)) {
		const month =
			p > thisMonth ? thisMonth : p < `${LAPORAN_MIN_YEAR}-01` ? `${LAPORAN_MIN_YEAR}-01` : p;
		return { mode: 'bulan', month, direction };
	}
	const month = legacy === 'bulan-lalu' ? shiftMonth(thisMonth, -1) : thisMonth;
	return { mode: 'bulan', month, direction };
}

function clampYear(year: string, thisYear: string): string {
	if (year > thisYear) return thisYear;
	if (Number(year) < LAPORAN_MIN_YEAR) return String(LAPORAN_MIN_YEAR);
	return year;
}

/** `/laporan?…` for `view`; this month with money out is plain `/laporan`. */
export function laporanHref(view: LaporanView, today: string): string {
	const params = new URLSearchParams();
	if (view.mode === 'tahun') params.set('y', view.year);
	else if (view.month !== monthOf(today)) params.set('p', view.month);
	if (view.direction === 'masuk') params.set('arah', 'masuk');
	const query = params.toString();
	return query ? `/laporan?${query}` : '/laporan';
}

/** The inclusive WIB dates the view sums: a whole month, a whole past year, or this year through today. */
export function periodRange(view: LaporanView, today: string): { from: string; to: string } {
	if (view.mode === 'bulan') return monthRange(view.month);
	const to = view.year === today.slice(0, 4) ? today : `${view.year}-12-31`;
	return { from: `${view.year}-01-01`, to };
}

/** The period before and after `view` (same mode); null when it would be in the future or before the floor. */
export function stepPeriod(view: LaporanView, delta: -1 | 1, today: string): LaporanView | null {
	if (view.mode === 'bulan') {
		const month = shiftMonth(view.month, delta);
		if (month > monthOf(today) || month < `${LAPORAN_MIN_YEAR}-01`) return null;
		return { ...view, month };
	}
	const year = String(Number(view.year) + delta);
	if (year > today.slice(0, 4) || Number(year) < LAPORAN_MIN_YEAR) return null;
	return { ...view, year };
}

/** The same direction in the other mode: a month opens its year; a year opens its last month so far. */
export function switchMode(
	view: LaporanView,
	mode: LaporanView['mode'],
	today: string
): LaporanView {
	if (mode === view.mode) return view;
	if (view.mode === 'bulan')
		return { mode: 'tahun', year: view.month.slice(0, 4), direction: view.direction };
	const month = view.year === today.slice(0, 4) ? monthOf(today) : `${view.year}-12`;
	return { mode: 'bulan', month, direction: view.direction };
}

/**
 * The Riwayat list a Laporan figure is the total of: the same dates and direction, optionally one category (a
 * figure equals the list it links to). `categoryId` '' (rows without a category) has no filter, so no link.
 */
export function laporanRiwayatHref(
	range: { from: string; to: string },
	direction: LaporanDirection,
	categoryId?: string
): string {
	const params = new URLSearchParams({
		type: direction === 'masuk' ? 'income' : 'expense',
		period: 'range',
		from: range.from,
		to: range.to
	});
	if (categoryId) params.set('category', categoryId);
	return `/riwayat?${params.toString()}`;
}
