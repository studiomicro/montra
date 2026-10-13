import { SPLITS_LOAD_FAILED } from '#lib/server/patungan/messages';
import { listSplits, owedToViewer } from '#lib/server/patungan/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { takeSplitSavedNotice } from '#lib/server/transactions/saved-notice';
import type { PageServerLoad } from './$types';

// FN-49 Patungan: the current space's splits. Every load and action of /patungan/* passes the session's space
// through requireSpaceAccess (currentSpaceScope); ids are only looked up inside it.
export const load: PageServerLoad = async ({ locals, url, cookies }) => {
	const scope = await currentSpaceScope(locals);
	const saved = takeSplitSavedNotice(cookies, locals.secure, url.searchParams.get('saved'));
	try {
		const [splits, owed] = await Promise.all([
			listSplits(locals.db, scope),
			owedToViewer(locals.db, scope)
		]);
		return { splits, owed, saved, loadError: null };
	} catch (e) {
		console.error('patungan: list failed', e instanceof Error ? e.name : 'unknown');
		return { splits: [], owed: [], saved, loadError: SPLITS_LOAD_FAILED };
	}
};
