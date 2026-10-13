import { isPlausibleEmail } from '#lib/server/auth/password';
import { getEnv } from '#lib/server/env';
import { appOriginForSite } from '#lib/shared/hosts';
import type { PageServerLoad } from './$types';

/** Reads SUPPORT_EMAIL and the app host of this request, so it is rendered per request, not prerendered (FN-32). */
export const prerender = false;

/**
 * Owner decision B (2026-10-07): until an e-mail provider exists, the public page explains the in-app path
 * and offers a mailto request to the support address. Without SUPPORT_EMAIL the request link shows
 * "Belum dikonfigurasi" instead of a guessed address. When wired to real deletion it must call
 * `deleteAccount` (src/lib/server/auth/delete-account.ts), never a second implementation.
 */
export const load: PageServerLoad = ({ url }) => {
	const address = getEnv().SUPPORT_EMAIL?.trim() ?? '';
	return {
		supportEmail: isPlausibleEmail(address) ? address : null,
		appOrigin: appOriginForSite(url.hostname, url.port, url.protocol)
	};
};
