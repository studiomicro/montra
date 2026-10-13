import { isMonthString, monthOf } from './dates.ts';
import { LAPORAN_MIN_YEAR, stepPeriod } from './laporan-query.ts';
import { riwayatHref } from './riwayat-query.ts';

/**
 * The month /alur-uang (FN-35) shows, as the URL says it (`?p=YYYY-MM`, Laporan's month parameter): a future
 * month, an unparsable one or one outside 2000–2099 (LAPORAN_MIN_YEAR is the floor) means this WIB month.
 * Never throws.
 */
export function parseFlowMonth(params: URLSearchParams, today: string): string {
	const p = params.get('p') ?? '';
	const thisMonth = monthOf(today);
	return isMonthString(p) && p <= thisMonth && p >= `${LAPORAN_MIN_YEAR}-01` ? p : thisMonth;
}

/** `/alur-uang?p=…` for `month`; this month is plain `/alur-uang`. */
export function alurUangHref(month: string, today: string): string {
	return month === monthOf(today) ? '/alur-uang' : `/alur-uang?p=${month}`;
}

/** The month before or after `month` (Laporan's stepping rule); null in the future or before the floor. */
export function stepFlowMonth(month: string, delta: -1 | 1, today: string): string | null {
	const next = stepPeriod({ mode: 'bulan', month, direction: 'keluar' }, delta, today);
	return next?.mode === 'bulan' ? next.month : null;
}

/**
 * The Riwayat list a flow figure is the sum of: the same month, plus the type, category and wallet the node or
 * link stands for (a figure equals the list it links to). Null when the figure covers rows without a category,
 * which Riwayat cannot filter on alone.
 */
export function flowRiwayatHref(
	month: string,
	pick: {
		type: 'income' | 'expense' | null;
		categoryId?: string | null;
		walletId?: string | null;
	}
): string | null {
	if (pick.categoryId === '') return null;
	return riwayatHref({
		type: pick.type,
		period: 'month',
		month,
		from: '',
		to: '',
		categoryId: pick.categoryId ?? null,
		walletId: pick.walletId ?? null,
		q: '',
		recurring: false
	});
}
