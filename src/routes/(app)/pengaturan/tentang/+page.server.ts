import { redirect } from '@sveltejs/kit';
import { listReleaseNotes, releaseDateOf } from '#lib/server/content/release-notes';
import { getEnv } from '#lib/server/env';
import type { PageServerLoad } from './$types';

// FN-42 "Tentang Montra". Nothing here is space or account data: the running version is the Worker's
// APP_VERSION (the value /api/v1/health reports), the notes are bundled repo content. Signed-in only, like
// every Pengaturan page.

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/masuk');
	const env = getEnv();
	const version = String(env.APP_VERSION);
	// AGPL-3.0 section 13: every hosted instance offers its source to users. Only an http(s) URL is linked.
	const sourceUrl = /^https?:\/\//i.test(env.SOURCE_URL?.trim() ?? '')
		? env.SOURCE_URL!.trim()
		: null;
	return {
		version,
		sourceUrl,
		releasedOn: releaseDateOf(version),
		notes: listReleaseNotes(locals.locale)
	};
};
