import { manifestBody, MANIFEST_CONTENT_TYPE } from '#lib/server/pwa/manifest';
import type { RequestHandler } from './$types';

// FN-46: the manifest follows the plan hooks.server.ts derived for this session (`locals.plan`, from
// billing/gate.ts planOf), never a client value. Account-dependent, so never stored by a shared cache; the
// service worker does not precache it either (it is no longer in static/).
export const prerender = false;

export const GET: RequestHandler = ({ locals }) =>
	new Response(manifestBody(locals.plan), {
		headers: {
			'content-type': MANIFEST_CONTENT_TYPE,
			'cache-control': 'private, no-store'
		}
	});
