import { dev } from '$app/env';
import { error } from '@sveltejs/kit';
import { devRoutesEnabled } from '#lib/server/dev';
import { getEnv } from '#lib/server/env';
import type { PageServerLoad } from './$types';

// Gallery of the Laporan charts with fixed fictional figures (badged "Data demo"); dev routes only.
export const load: PageServerLoad = async () => {
	if (!devRoutesEnabled(getEnv() as { DEV_ROUTES?: string }, dev)) error(404);
	return {};
};
