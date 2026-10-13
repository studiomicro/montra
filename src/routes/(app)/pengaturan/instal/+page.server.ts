import { siteOriginForApp } from '#lib/shared/hosts';
import { localizedSitePath } from '#lib/shared/site-locale';
import type { PageServerLoad } from './$types';

// Works signed out too (auth/gate.ts PUBLIC_APP_ROUTES): installing is a browser capability, not an account
// feature. Nothing here reads or writes account data.

export const load: PageServerLoad = ({ url, locals }) => {
	// The step-by-step guide and its QR code live on the public site's /pasang (FN-32), one copy only.
	const site = siteOriginForApp(url.hostname, url.port, url.protocol);
	return { guideUrl: site ? `${site}${localizedSitePath(locals.locale, '/pasang')}` : null };
};
