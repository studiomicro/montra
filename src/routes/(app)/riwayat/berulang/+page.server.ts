import { SERIES_LOAD_FAILED } from '#lib/server/recurring/messages';
import { listSeries } from '#lib/server/recurring/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { takeSeriesSavedNotice } from '#lib/server/transactions/saved-notice';
import type { PageServerLoad } from './$types';

// FN-36 "Transaksi berulang": the current space's series. Every load and action of /riwayat/berulang/* passes
// the session's space through requireSpaceAccess (currentSpaceScope); ids are only looked up inside it.
export const load: PageServerLoad = async ({ locals, url, cookies }) => {
	const { spaceId } = await currentSpaceScope(locals);
	// What a finished write tells the list: shown only with the one-shot notice the write set (as FN-44 L1 for
	// Riwayat), so a crafted or reloaded `?saved=` shows no success.
	const saved = takeSeriesSavedNotice(cookies, locals.secure, url.searchParams.get('saved'));
	try {
		return { series: await listSeries(locals.db, spaceId), saved, loadError: null };
	} catch (e) {
		console.error('riwayat/berulang: list failed', e instanceof Error ? e.name : 'unknown');
		return { series: [], saved, loadError: SERIES_LOAD_FAILED };
	}
};
