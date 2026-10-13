import { redirect } from '@sveltejs/kit';
import { appOriginForSite } from '#lib/shared/hosts';
import type { RequestHandler } from './$types';

/**
 * "Mulai gratis" (FN-32): the prerendered pages cannot know which app host and port answer this site host, so
 * they link here and this per-request redirect names the paired app host (src/lib/shared/hosts.ts). The target
 * is never taken from the request beyond its own host, port and scheme.
 */
export const prerender = false;

export const GET: RequestHandler = ({ url }) => {
	const app = appOriginForSite(url.hostname, url.port, url.protocol);
	// Kit 3 refuses an off-origin redirect unless that origin is allowed explicitly: exactly the app's.
	redirect(303, `${app}/daftar`, { external: [app] });
};
