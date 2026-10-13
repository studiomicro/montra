import { redirect } from '@sveltejs/kit';
import { apiReference } from '#lib/server/api/reference';
import { createTranslator } from '#lib/shared/i18n';
import type { PageServerLoad } from './$types';

// FN-38 docs page: the OpenAPI document (generated from the handlers' own schemas) as plain data for a
// hand-built reference, in the reader's language. Behind sign-in like every Settings page (owner decision 6).
export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, '/masuk');
	return { reference: apiReference(createTranslator(locals.locale)), origin: url.origin };
};
