import { redirect } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { PRIVACY_LOAD_FAILED } from '#lib/server/privacy/messages';
import {
	listConsentRecords,
	setUsageStatsEnabled,
	usageStatsEnabled,
	type ConsentRecord
} from '#lib/server/privacy/repo';
import { siteOriginForApp } from '#lib/shared/hosts';
import { EXPORT_REFUSALS, isExportRefusal } from '#lib/shared/privacy';
import type { Actions, PageServerLoad } from './$types';

// Privacy data belongs to the signed-in person (locals.user), never to a space and never to an id from the
// request. hooks.server.ts answers signed-out requests first; the checks below only narrow the type.

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user;
	if (!user) redirect(303, '/masuk?next=%2Fpengaturan%2Fprivasi');
	const refusal = url.searchParams.get('ekspor');
	const base = {
		siteOrigin: siteOriginForApp(url.hostname, url.port, url.protocol),
		exportError: isExportRefusal(refusal) ? EXPORT_REFUSALS[refusal] : null
	};
	try {
		const [statsEnabled, consent] = await Promise.all([
			usageStatsEnabled(locals.db, user.id),
			listConsentRecords(locals.db, user.id)
		]);
		return { ...base, statsEnabled, consent, loadError: null };
	} catch (e) {
		console.error('pengaturan/privasi: load failed', e instanceof Error ? e.name : 'unknown');
		return {
			...base,
			statsEnabled: true,
			consent: [] as ConsentRecord[],
			loadError: PRIVACY_LOAD_FAILED
		};
	}
};

export const actions: Actions = {
	/** The usage-statistics switch: `enabled=on` keeps counting, a missing `enabled` (unchecked) stops it. */
	setStats: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = locals.user;
		if (!user) redirect(303, '/masuk');
		const enabled = textField(form, 'enabled') === 'on';
		await setUsageStatsEnabled(locals.db, user.id, enabled, Date.now());
		return { savedStats: true, enabled };
	}
};
