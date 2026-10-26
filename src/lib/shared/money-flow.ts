import { reportPeriodHref } from './report-period.ts';
import { riwayatHref } from './riwayat-query.ts';

/** Node id of a folded "Lainnya" / "Dompet lainnya" node (FN-53): no single category or wallet stands behind it. */
export const FOLDED_ID = '*';

/** `/alur-uang?p=…` for `month` (Laporan's "Lihat alur uang"); this month is plain `/alur-uang`. */
export function alurUangHref(month: string, today: string): string {
	return reportPeriodHref('/alur-uang', { kind: 'bulan', month }, today, 'bulan');
}

/**
 * The Riwayat list a flow figure is the sum of: the same month (`YYYY-MM`) or, for a quarter or year, the same
 * WIB date range, plus the type, category and wallet the node or link stands for (a figure equals the list it
 * links to). Null when the figure covers rows without a category, which Riwayat cannot filter on alone, or a
 * folded node, which no filter can express.
 */
export function flowRiwayatHref(
	period: string | { from: string; to: string },
	pick: {
		type: 'income' | 'expense' | null;
		categoryId?: string | null;
		walletId?: string | null;
	}
): string | null {
	if (pick.categoryId === '' || pick.categoryId === FOLDED_ID || pick.walletId === FOLDED_ID)
		return null;
	const range = typeof period === 'string' ? null : period;
	return riwayatHref({
		type: pick.type,
		period: range ? 'range' : 'month',
		month: typeof period === 'string' ? period : '',
		from: range?.from ?? '',
		to: range?.to ?? '',
		categoryId: pick.categoryId ?? null,
		walletId: pick.walletId ?? null,
		q: '',
		recurring: false
	});
}
