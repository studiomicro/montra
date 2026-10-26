import { fail, redirect } from '@sveltejs/kit';
import { msg } from '#lib/shared/i18n';
import { allowedTheme } from '#lib/shared/pro-look';
import { planOf } from '#lib/server/billing/gate';
import { readFormBody, textField } from '#lib/server/forms';
import { isThemePref } from '#lib/server/prefs';
import {
	STORY_COOKIE_MAX_AGE,
	STORY_OFF_COOKIE,
	STORY_SEEN_COOKIE,
	storyOff
} from '#lib/shared/daily-story';
import type { Actions, PageServerLoad } from './$types';

// The theme is a per-browser cookie (FN-40 Part 1), never a D1 row: nothing here reads or writes space data.
// The page itself reads the current choice from the root layout (`data.theme`). FN-54: the daily greeting's
// off switch is a per-browser cookie too (owner decision 3: device-only, not synced).

export const load: PageServerLoad = ({ cookies }) => ({
	sapaanOn: !storyOff(cookies.get(STORY_OFF_COOKIE))
});

const THEME_INVALID = msg('Pilihan tampilan tidak dikenal.');
/** FN-46: a Pro theme posted by an account without a paid plan in force (the row is a link to Paket there). */
const PRO_THEME_LOCKED = msg('Perlu paket Pro atau Agen');
/** A year, like the sidebar's quick toggle (src/lib/ui/shell/theme.ts). */
const THEME_MAX_AGE = 31_536_000;

export const actions: Actions = {
	/**
	 * Stores `theme` as the `theme` cookie; `system` clears it. A Pro theme (FN-46) is stored only while the
	 * account's own plan, read here from D1 (planOf on locals.user.id), has the Pro look: a posted value is a wish,
	 * not a plan. Once the plan lapses, hooks.server.ts renders `system` for a Pro theme cookie but leaves the
	 * cookie, so the chosen theme returns if the account pays again.
	 */
	theme: async ({ request, cookies, locals }) => {
		if (!locals.user) redirect(303, '/masuk?next=%2Fpengaturan%2Ftampilan');
		const form = await readFormBody(request);
		const theme = textField(form, 'theme');
		if (!isThemePref(theme)) return fail(400, { error: THEME_INVALID });
		const plan = await planOf(locals.db, locals.user.id, Date.now());
		if (allowedTheme(theme, plan) !== theme) return fail(403, { error: PRO_THEME_LOCKED });
		// Not HttpOnly: the sidebar's light/dark toggle rewrites the same cookie from the page.
		if (theme === 'system') cookies.delete('theme', { path: '/', secure: locals.secure });
		else
			cookies.set('theme', theme, {
				path: '/',
				maxAge: THEME_MAX_AGE,
				sameSite: 'lax',
				secure: locals.secure,
				httpOnly: false
			});
		// This response already renders the new theme (<html data-theme>, theme-color) — no flash, no JS needed.
		locals.theme = theme;
		return { saved: theme };
	},

	/**
	 * FN-54 D3: the daily greeting on (`enabled=on`) or off (anything else, as the sheet's "Matikan sapaan harian"
	 * posts). Off sets `montra-sapaan-off=1`; on clears it and the "seen" date, so the sheet is due again today.
	 * HttpOnly: only the server reads the off switch (the Beranda load).
	 */
	sapaan: async ({ request, cookies, locals }) => {
		if (!locals.user) redirect(303, '/masuk?next=%2Fpengaturan%2Ftampilan');
		const form = await readFormBody(request);
		const on = textField(form, 'enabled') === 'on';
		if (on) {
			cookies.delete(STORY_OFF_COOKIE, { path: '/', secure: locals.secure });
			cookies.delete(STORY_SEEN_COOKIE, { path: '/', secure: locals.secure });
		} else
			cookies.set(STORY_OFF_COOKIE, '1', {
				path: '/',
				maxAge: STORY_COOKIE_MAX_AGE,
				sameSite: 'lax',
				secure: locals.secure,
				httpOnly: true
			});
		return { sapaan: on ? ('on' as const) : ('off' as const) };
	}
};
