import { error, fail, redirect } from '@sveltejs/kit';
import { idField, readFormBody } from '#lib/server/forms';
import { NOTIFICATION_GONE, NOTIFICATIONS_LOAD_FAILED } from '#lib/server/notifications/messages';
import { changeNotification, findOwned, listNotifications } from '#lib/server/notifications/repo';
import { safeReturnTo } from '#lib/server/return-to';
import { requireSpaceAccess, setSpaceCookie } from '#lib/server/spaces/access';
import { createTranslator } from '#lib/shared/i18n';
import { notificationText, notificationUrl, parseParams } from '#lib/shared/notifications';
import { errorLabel } from '#lib/server/util';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// The signed-in user's own notifications (FN-24). User-level rows are scoped `user_id = locals.user.id`; a
// space-level row is listed only while the user is still a live member of its space (re-checked in the list
// query), and every action on one passes `requireSpaceAccess` for that space. An unknown id, another user's
// id and a row of a space the user left all get the same 404 "Not found" (no existence oracle).

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) redirect(303, '/masuk?next=%2Fkotak-masuk%2Fnotifikasi');
	try {
		const rows = await listNotifications(locals.db, user.id);
		const t = createTranslator(locals.locale);
		const items = rows.map((row) => {
			const params = parseParams(row.kind, row.params);
			const spaceName = row.space
				? row.space.kind === 'personal'
					? t.tr('Pribadi')
					: row.space.name
				: null;
			return {
				id: row.id,
				kind: row.kind,
				...notificationText(row.kind, params, t, spaceName),
				unread: row.readAt === null,
				createdAt: row.createdAt
			};
		});
		return { items, loadError: null };
	} catch (e) {
		console.error('kotak-masuk/notifikasi: load failed', errorLabel(e));
		return { items: [], loadError: NOTIFICATIONS_LOAD_FAILED };
	}
};

/** The user's live notification named by the form, its space re-checked; 404 for anything else. */
async function owned(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const { locals } = event;
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	const id = idField(form, 'id');
	const row = await findOwned(locals.db, user.id, id);
	if (!row) error(404, 'Not found');
	if (row.table === 'space') await requireSpaceAccess(locals.db, user.id, row.spaceId);
	return { id, row, userId: user.id, db: locals.db };
}

export const actions: Actions = {
	/**
	 * Opens a notification: marks it read, makes its space the current one (so `/` shows that space's budget,
	 * never another's), then goes to its page.
	 */
	open: async (event) => {
		const { id, row, userId, db } = await owned(event);
		const changed = await changeNotification(db, userId, row, id, 'read', Date.now());
		if (!changed) return fail(404, { error: NOTIFICATION_GONE });
		if (row.table === 'space') setSpaceCookie(event.cookies, row.spaceId, event.locals.secure);
		redirect(303, safeReturnTo(notificationUrl(row.kind, parseParams(row.kind, row.params))));
	},

	/** Dismisses a notification: a content-free tombstone, gone from the list for good. */
	dismiss: async (event) => {
		const { id, row, userId, db } = await owned(event);
		const changed = await changeNotification(db, userId, row, id, 'dismiss', Date.now());
		if (!changed) return fail(404, { error: NOTIFICATION_GONE });
		return { dismissed: true };
	}
};
