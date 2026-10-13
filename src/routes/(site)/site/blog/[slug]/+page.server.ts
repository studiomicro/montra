import { error } from '@sveltejs/kit';
import { getPost } from '#lib/server/content/blog';
import type { PageServerLoad } from './$types';

// Prerendered for every post the crawler reaches from /blog and /en/blog (route-level `entries` would be
// generated from the internal `/site/…` route id, which the site host never serves).

export const load: PageServerLoad = ({ params, locals }) => {
	const post = getPost(locals.locale, params.slug);
	if (!post) error(404);
	return { post };
};
