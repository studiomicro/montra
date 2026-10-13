import { redirect } from '@sveltejs/kit';
import { listAllReleaseNotes } from '#lib/server/content/release-notes';
import { getEnv } from '#lib/server/env';
import type { PageServerLoad } from './$types';

// FN-42b "Catatan rilis": every bundled release note in the reader's language, newest first, and the running
// version (its card says "Versi kamu"). Repo content only, no space or account data. Signed-in only, like every
// Pengaturan page; never on the marketing site (owner decision D1).

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, '/masuk');
	return {
		version: String(getEnv().APP_VERSION),
		notes: listAllReleaseNotes(locals.locale)
	};
};
