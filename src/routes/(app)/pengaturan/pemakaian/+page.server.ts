import { error, redirect } from '@sveltejs/kit';
import { listApiTokens } from '#lib/server/auth/api-tokens';
import { creditBalance, gmailLookbackMaxDays, planStateOf } from '#lib/server/billing/gate';
import {
	creditsSpentThisMonth,
	LEDGER_PAGE_SIZE,
	ledgerCursorParam,
	listLedger
} from '#lib/server/billing/ledger';
import { listCategories, MAX_CATEGORIES_PER_SPACE } from '#lib/server/categories/repo';
import { listConnections } from '#lib/server/connected-apps/repo';
import { countStoredPhotos } from '#lib/server/photos/store';
import { MAX_SPACE_MEMBERS, requireSpaceAccess } from '#lib/server/spaces/access';
import { listMembers, listSpaces } from '#lib/server/spaces/spaces';
import { errorLabel } from '#lib/server/util';
import { API_TOKEN_MAX_PER_USER } from '#lib/shared/api-tokens';
import { PLAN_CATALOGUE } from '#lib/shared/billing/plans';
import { monthOf, wibDateString } from '#lib/shared/dates';
import { msg } from '#lib/shared/i18n';
import type { PageServerLoad } from './$types';

// FN-42 "Pemakaian": a read-only view over rows that already exist. Account figures (plan, credits, spaces, API
// tokens) are read for locals.user.id only; space figures (categories, connected apps, members, photos) for the
// current space only, after requireSpaceAccess re-checked the session's membership of it. The request carries
// no id at all. Every query is bounded (a capped list or one aggregate); nothing is shown that is not stored.

const USAGE_LOAD_FAILED = msg('Pemakaian tidak bisa dimuat. Coba lagi sebentar lagi.');

/** Built-time: whether FN-41's AI integrations page ships in this build (the AI row links there only then). */
const INTEGRATIONS_PAGE =
	Object.keys(import.meta.glob('../integrasi/+page.svelte', { query: '?raw' })).length > 0;

export type LimitKey = 'spaces' | 'tokens';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	if (!locals.space) error(404, 'Not found');
	// Outside the try: a refused membership is the shared 404, never the page's "could not load" state.
	const access = await requireSpaceAccess(locals.db, user.id, locals.space.id);
	const spaceId = access.space.id;
	const scope = { spaceId, userId: user.id };
	const now = Date.now();
	const space = { name: access.space.name, kind: access.space.kind };
	try {
		const [
			state,
			balance,
			spent,
			ledger,
			spaces,
			categories,
			tokens,
			connections,
			members,
			photos
		] = await Promise.all([
			planStateOf(locals.db, user.id, now),
			creditBalance(locals.db, user.id),
			creditsSpentThisMonth(locals.db, user.id, now),
			listLedger(locals.db, user.id, null, LEDGER_PAGE_SIZE),
			listSpaces(locals.db, user.id),
			listCategories(locals.db, spaceId, { includeHidden: true }),
			listApiTokens(locals.db, user.id, now),
			listConnections(locals.db, scope),
			access.space.kind === 'shared' ? listMembers(locals.db, spaceId, user.id) : null,
			countStoredPhotos(locals.db, spaceId)
		]);
		const last = ledger.rows.at(-1);
		// Account-wide "N dari M" rows, keyed by limit name (the page keys its list by it).
		const limits: { key: LimitKey; used: number; allowed: number }[] = [
			{ key: 'spaces', used: spaces.length, allowed: PLAN_CATALOGUE[state.plan].maxSpaces },
			{ key: 'tokens', used: tokens.length, allowed: API_TOKEN_MAX_PER_USER }
		];
		return {
			space,
			usage: {
				state,
				balance,
				spentThisMonth: spent,
				month: monthOf(wibDateString(now)),
				ledger: ledger.rows,
				olderCursor: ledger.more && last ? ledgerCursorParam(last) : null,
				limits,
				// Hidden ones count too; a space topped up past the cap by later presets shows its real count.
				categories: { used: categories.length, allowed: MAX_CATEGORIES_PER_SPACE },
				// Fixture connections (Data demo) are shown apart, never counted as real ones.
				connectedApps: {
					real: connections.filter((c) => !c.isDemo).length,
					demo: connections.filter((c) => c.isDemo).length
				},
				members: members ? { used: members.length, allowed: MAX_SPACE_MEMBERS } : null,
				gmailLookbackDays: gmailLookbackMaxDays(state.plan),
				photos
			},
			aiLink: INTEGRATIONS_PAGE ? '/pengaturan/integrasi' : null,
			loadError: null
		};
	} catch (e) {
		console.error('pengaturan/pemakaian: load failed', errorLabel(e));
		return { space, usage: null, aiLink: null, loadError: USAGE_LOAD_FAILED };
	}
};
