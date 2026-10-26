import { fail, redirect } from '@sveltejs/kit';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField, idField } from '#lib/server/forms';
import {
	ADDRESS_CHANGED_MEANWHILE,
	ADDRESS_EXISTS,
	ADDRESS_NOT_FOUND,
	ADDRESS_RATE_LIMITED,
	FORWARDING_LOAD_FAILED,
	FORWARDING_NOT_CONFIGURED,
	SPACE_NOT_AVAILABLE
} from '#lib/server/inbound/messages';
import {
	ADDRESS_CHANGES_PER_WINDOW,
	createAddress,
	getActiveAddress,
	hasAnthropicKey,
	listRecentMail,
	revokeAddress,
	rotateAddress,
	setAddressSpace,
	type AddressWriteResult
} from '#lib/server/inbound/repo';
import { listSpaces } from '#lib/server/spaces/spaces';
import { errorLabel } from '#lib/server/util';
import { formatAddress, inboundDomain } from '#lib/shared/inbound/address';
import type { Actions, PageServerLoad } from './$types';

// FN-19 "Teruskan e-mail". Account-level like /pengaturan/integrasi: every load and action works on the
// session user's own address only (`user_id = locals.user.id` is repeated in every write, so another user's
// address id reads exactly like a missing one). A space id from a form is only accepted when the user is a live
// member of it, checked inside the write itself. The address is shown only to its owner; it is never logged.

function signedIn(locals: App.Locals) {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	return user;
}

const domain = () => inboundDomain(getEnv().INBOUND_EMAIL_DOMAIN);

export const load: PageServerLoad = async ({ locals }) => {
	const user = signedIn(locals);
	const configured = domain();
	const base = { configured: configured !== null };
	try {
		const now = Date.now();
		const [address, spaces, mail, hasKey] = await Promise.all([
			getActiveAddress(locals.db, user.id),
			listSpaces(locals.db, user.id),
			listRecentMail(locals.db, user.id, now),
			hasAnthropicKey(locals.db, user.id)
		]);
		return {
			...base,
			address:
				address && configured
					? {
							id: address.id,
							email: formatAddress(address.localPart, configured),
							spaceId: address.spaceId,
							spaceName: address.spaceName,
							lastReceivedAt: address.lastReceivedAt,
							updatedAt: address.updatedAt
						}
					: null,
			spaces: spaces.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
			mail,
			hasKey,
			loadError: null
		};
	} catch (e) {
		console.error('pengaturan/aplikasi/email: load failed', errorLabel(e));
		return {
			...base,
			address: null,
			spaces: [],
			mail: [],
			hasKey: false,
			loadError: FORWARDING_LOAD_FAILED
		};
	}
};

/** The address ref of a form: its id and the `updated_at` the page showed ("changed meanwhile" otherwise). */
function addressRef(form: FormData): { id: string; updatedAt: number } | null {
	const id = idField(form, 'addressId');
	const updatedAt = Number(textField(form, 'updatedAt'));
	return id && Number.isSafeInteger(updatedAt) && updatedAt > 0 ? { id, updatedAt } : null;
}

function answer(result: AddressWriteResult, done: 'rotated' | 'revoked' | 'moved') {
	if (result === 'missing') return fail(404, { error: ADDRESS_NOT_FOUND });
	if (result === 'stale') return fail(409, { error: ADDRESS_CHANGED_MEANWHILE });
	return { done };
}

export const actions: Actions = {
	/** "Buat alamat": one active address, recording into the chosen space (the personal one by default). */
	create: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		if (!domain()) return fail(503, { error: FORWARDING_NOT_CONFIGURED });
		const spaceId = idField(form, 'spaceId') || locals.space?.id || '';
		const now = Date.now();
		if (
			await overUserAttemptLimit(
				locals.db,
				user.id,
				now,
				'inbound-address',
				ADDRESS_CHANGES_PER_WINDOW
			)
		)
			return fail(429, { error: ADDRESS_RATE_LIMITED });
		const result = await createAddress(locals.db, user.id, spaceId, now);
		if (result === 'space') return fail(404, { error: SPACE_NOT_AVAILABLE });
		if (result === 'exists') return fail(409, { error: ADDRESS_EXISTS });
		return { done: 'created' as const };
	},

	/** "Putar ulang alamat": the old address stops at once, a new one starts (same space). */
	rotate: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		if (!domain()) return fail(503, { error: FORWARDING_NOT_CONFIGURED });
		const ref = addressRef(form);
		if (!ref) return fail(404, { error: ADDRESS_NOT_FOUND });
		const now = Date.now();
		if (
			await overUserAttemptLimit(
				locals.db,
				user.id,
				now,
				'inbound-address',
				ADDRESS_CHANGES_PER_WINDOW
			)
		)
			return fail(429, { error: ADDRESS_RATE_LIMITED });
		return answer(await rotateAddress(locals.db, user.id, ref, now), 'rotated');
	},

	/** "Matikan": works even when forwarding is no longer configured (stopping is always possible). */
	revoke: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const ref = addressRef(form);
		if (!ref) return fail(404, { error: ADDRESS_NOT_FOUND });
		return answer(await revokeAddress(locals.db, user.id, ref, Date.now()), 'revoked');
	},

	/** "Dicatat ke": a space the user is a live member of; any other id gets the same refusal. */
	target: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const ref = addressRef(form);
		if (!ref) return fail(404, { error: ADDRESS_NOT_FOUND });
		const spaceId = idField(form, 'spaceId');
		const spaces = await listSpaces(locals.db, user.id);
		if (!spaces.some((s) => s.id === spaceId)) return fail(404, { error: SPACE_NOT_AVAILABLE });
		return answer(await setAddressSpace(locals.db, user.id, ref, spaceId, Date.now()), 'moved');
	}
};
