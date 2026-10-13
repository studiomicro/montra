import type { Reroute } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { prerenderRoute, routeFor } from '#lib/shared/hosts';

// The prerender crawler (FN-32) requests the public site's paths from its own placeholder origin; they are
// resolved exactly as on the site host. `building` is never true in the deployed Worker or the browser.
export const reroute: Reroute = ({ url }) => (building ? prerenderRoute(url) : routeFor(url));
