import { redirect } from '@sveltejs/kit';
import { trackContext, trackEvent } from '#lib/server/analytics/track';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { ACCOUNT_EXPORT_MAX_PER_WINDOW, exportAccount } from '#lib/server/export/account-export';
import { getEnv } from '#lib/server/env';
import { readFormBody } from '#lib/server/forms';
import type { ExportRefusal } from '#lib/shared/privacy';
import { wibTodayString } from '#lib/shared/dates';
import type { RequestHandler } from './$types';

function refuse(code: ExportRefusal): never {
	redirect(303, `/pengaturan/privasi?ekspor=${code}#ekspor`);
}

/**
 * "Ekspor semua data" (FN-31): a form POST (so SvelteKit's same-origin check applies and it works without
 * JavaScript) answered with the ZIP as an attachment. Only `locals.user.id`'s own data: nothing in the request
 * names an account or a space. A refusal goes back to the page with a reason.
 */
export const POST: RequestHandler = async (event) => {
	const { request, locals } = event;
	await readFormBody(request);
	const user = locals.user;
	if (!user) redirect(303, '/masuk?next=%2Fpengaturan%2Fprivasi');
	const now = Date.now();
	if (
		await overUserAttemptLimit(
			locals.db,
			user.id,
			now,
			'account-export',
			ACCOUNT_EXPORT_MAX_PER_WINDOW
		)
	)
		refuse('terlalu-sering');
	const result = await exportAccount(locals.db, user.id, { files: getEnv().FILES });
	if (!result.ok)
		refuse(result.reason === 'photos_too_large' ? 'foto-terlalu-besar' : 'terlalu-besar');
	await trackEvent(trackContext(event), { screen: 'privasi', action: 'export_account' });
	return new Response(result.stream, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="montra-ekspor-${wibTodayString(now)}.zip"`,
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
