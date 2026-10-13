import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const prerender = false;

/** Unknown site-host paths 404 inside the site layout, so `(site)/site/+error.svelte` renders with header and footer. */
export const load: PageServerLoad = () => {
	error(404);
};
