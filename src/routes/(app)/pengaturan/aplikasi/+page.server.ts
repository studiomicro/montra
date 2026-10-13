import { error, fail } from '@sveltejs/kit';
import { dev } from '$app/env';
import { isConnectedAppsConfigured } from '#lib/server/connected-apps/crypto';
import {
	ALREADY_CONNECTED,
	CONNECTED_APPS_LOAD_FAILED,
	CONNECTED_APPS_NOT_CONFIGURED,
	CONNECTION_NOT_FOUND,
	DISCONNECT_NOT_ALLOWED,
	PROVIDER_INVALID
} from '#lib/server/connected-apps/messages';
import {
	clearDemoConnectedApps,
	disconnectApp,
	listConnections,
	seedDemoConnectedApp
} from '#lib/server/connected-apps/repo';
import { providerField } from '#lib/server/connected-apps/validation';
import { devRoutesEnabled } from '#lib/server/dev';
import { getEnv } from '#lib/server/env';
import { readFormBody } from '#lib/server/forms';
import { isGmailConfigured, type GmailAppEnv } from '#lib/server/gmail/config';
import { getConnection } from '#lib/server/gmail/repo';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { idField } from '#lib/server/subscriptions/validation';
import { errorLabel } from '#lib/server/util';
import { appRows, isConnectedAppProvider } from '#lib/shared/connected-apps/providers';
import { inboundDomain } from '#lib/shared/inbound/address';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// FN-29 Aplikasi terhubung. The page works on the session's current space (locals.space), re-checked through
// requireSpaceAccess on every load and action (currentSpaceScope), so there is one access rule; a connection id
// from a form is only looked up inside that space. No provider app exists yet, so "Hubungkan" is never an
// action here; only "Putuskan" and the dev-only seed/clear tools write. Token columns never reach page data.

const devTools = () => devRoutesEnabled(getEnv() as { DEV_ROUTES?: string }, dev);

export const load: PageServerLoad = async ({ locals, url }) => {
	const scope = await currentSpaceScope(locals);
	const configured = isConnectedAppsConfigured(getEnv());
	// Without JavaScript `?app=<provider>` renders the detail inline; with it the rows open a sheet.
	const requested = url.searchParams.get('app') ?? '';
	const base = {
		configured,
		// FN-19: the "Teruskan e-mail" entry says whether forwarding is configured on this server.
		forwardingReady: inboundDomain(getEnv().INBOUND_EMAIL_DOMAIN) !== null,
		devTools: devTools(),
		open: isConnectedAppProvider(requested) ? requested : null
	};
	// FN-19 Gmail: the user's own connection (account-level, not the space's), shown on the Gmail row.
	const gmailReady = isGmailConfigured(getEnv() as GmailAppEnv);
	try {
		const [connections, gmail] = await Promise.all([
			listConnections(locals.db, scope),
			getConnection(locals.db, scope.userId, Date.now())
		]);
		return {
			...base,
			apps: appRows(connections, configured),
			gmail: { configured: gmailReady, status: gmail?.status ?? null },
			loadError: null
		};
	} catch (e) {
		console.error('pengaturan/aplikasi: load failed', errorLabel(e));
		return {
			...base,
			apps: appRows([], configured),
			gmail: { configured: gmailReady, status: null },
			loadError: CONNECTED_APPS_LOAD_FAILED
		};
	}
};

/** Refuses a dev-only action (404, like /dev/ui) unless the gate is open; then the usual guarded scope. */
async function devAction(event: RequestEvent) {
	if (!devTools()) error(404, 'Not found');
	const form = await readFormBody(event.request);
	return { form, scope: await currentSpaceScope(event.locals) };
}

export const actions: Actions = {
	/**
	 * "Putuskan": the connection's creator or the space's Pemilik (red team L3), with or without the key (deleting
	 * a token never needs it).
	 */
	disconnect: async (event) => {
		const form = await readFormBody(event.request);
		const scope = await currentSpaceScope(event.locals);
		const result = await disconnectApp(
			event.locals.db,
			scope,
			idField(form, 'connectionId'),
			Date.now()
		);
		if (result === 'missing') return fail(404, { error: CONNECTION_NOT_FOUND });
		if (result === 'forbidden') return fail(403, { error: DISCONNECT_NOT_ALLOWED });
		return { done: 'disconnected' as const };
	},

	seedDemoConnectedApp: async (event) => {
		const { form, scope } = await devAction(event);
		const provider = providerField(form);
		if (!provider) return fail(400, { error: PROVIDER_INVALID });
		const result = await seedDemoConnectedApp(
			event.locals.db,
			scope,
			getEnv(),
			provider,
			Date.now()
		);
		if (result === 'not_configured') return fail(503, { error: CONNECTED_APPS_NOT_CONFIGURED });
		if (result === 'exists') return fail(409, { error: ALREADY_CONNECTED });
		return { done: 'seeded' as const };
	},

	clearDemoConnectedApps: async (event) => {
		const { scope } = await devAction(event);
		const cleared = await clearDemoConnectedApps(event.locals.db, scope, Date.now());
		return { done: 'cleared' as const, count: cleared };
	}
};
