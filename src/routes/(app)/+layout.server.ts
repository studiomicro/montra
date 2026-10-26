import { hiddenModules, type Module } from '#lib/shared/feature-flags';
import { isAiGatewayConfigured } from '#lib/server/ai-keys/anthropic';
import { releaseNoteFor } from '#lib/server/content/release-notes';
import { getEnv } from '#lib/server/env';
import { getFeatureFlags } from '#lib/server/feature-flags/repo';
import { inboundDomain } from '#lib/shared/inbound/address';
import { errorLabel } from '#lib/server/util';
import type { ShellData } from '#lib/ui/shell/shell-data';
import type { LayoutServerLoad } from './$types';

/**
 * The modules the signed-in user hid from their own navigation (FN-12), for Sidebar and TabBar. Flags that
 * cannot be read degrade to showing every entry: a display preference never blocks a page. `shell` is the
 * sidebar's space card and account row, read from the session's already-validated `locals.space` and
 * `locals.user` (display only: every page still checks access itself). `receiptReady`: the AI Gateway is
 * configured, so Beranda's and the Tambah sheet's "Struk" lead to /riwayat/struk (FN-15; the page itself says
 * when the user still needs a key). FN-42b: `appVersion` (the Worker's APP_VERSION, public as on
 * /api/v1/health) and `whatsNew`, that version's bundled note in the user's language (about 1 KB, null without
 * a note), for the one-time "Baru di Montra" notice; signed out, both are null. Repo content only, no D1 read.
 * `forwardingReady`: a forwarding domain is configured, so "Otomatis" leads to /pengaturan/aplikasi/email (FN-19);
 * the domain itself is not sent. FN-46: `shell.plan` is hooks.server.ts's `locals.plan` (no second query).
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	const user = locals.user;
	const space = locals.space;
	const shell: ShellData = {
		space: space ? { name: space.name, kind: space.kind, role: space.role } : null,
		account: user ? { name: user.name ?? '', email: user.email } : null,
		plan: locals.plan
	};
	const env = getEnv();
	const receiptReady = isAiGatewayConfigured(env);
	const forwardingReady = inboundDomain(env.INBOUND_EMAIL_DOMAIN) !== null;
	if (!user)
		return {
			hiddenModules: [] as Module[],
			shell,
			queue: null,
			receiptReady,
			forwardingReady,
			appVersion: null,
			whatsNew: null
		};
	const appVersion = String(env.APP_VERSION);
	const note = releaseNoteFor(locals.locale, appVersion);
	const whatsNew = note ? { version: note.version, date: note.date, html: note.html } : null;
	// FN-02: whose offline queue this page uses, and the space a write queued here belongs to (re-checked by
	// the server when the item is sent). The user's own id, never a secret.
	const queue = { accountId: user.id, spaceId: space?.id ?? null, spaceName: space?.name ?? '' };
	try {
		return {
			hiddenModules: hiddenModules(await getFeatureFlags(locals.db, user.id)),
			shell,
			queue,
			receiptReady,
			forwardingReady,
			appVersion,
			whatsNew
		};
	} catch (e) {
		console.error('app layout: feature flags failed', errorLabel(e));
		return {
			hiddenModules: [] as Module[],
			shell,
			queue,
			receiptReady,
			forwardingReady,
			appVersion,
			whatsNew
		};
	}
};
