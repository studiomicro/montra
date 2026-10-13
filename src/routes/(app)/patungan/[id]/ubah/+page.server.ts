import { error, fail, redirect } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { readSplitForm } from '#lib/server/patungan/form';
import {
	BILL_UNAVAILABLE,
	NOTE_TOO_LONG,
	PAYER_ONLY,
	SPLIT_CHANGED,
	SPLIT_LOCKED,
	SPLIT_NOT_FOUND,
	TITLE_REQUIRED
} from '#lib/server/patungan/messages';
import {
	getSplit,
	spaceMemberNames,
	updateSplit,
	updateSplitDetails,
	type SplitDetail,
	type SplitWriteRefusal
} from '#lib/server/patungan/repo';
import { expectedUpdatedAt } from '#lib/server/recurring/validation';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { DATE_INVALID, REFS_GONE } from '#lib/server/transactions/messages';
import { setSplitSavedNotice } from '#lib/server/transactions/saved-notice';
import { ID_MAX_LENGTH } from '#lib/server/transactions/validation';
import { minorToAmountText } from '#lib/shared/amount-input';
import { isDateString } from '#lib/shared/dates';
import type { Locale } from '#lib/shared/i18n';
import { SPLIT_NOTE_MAX, SPLIT_TITLE_MAX, type PatunganFormValues } from '#lib/shared/patungan';
import { cleanText } from '#lib/shared/text';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

const bounded = (value: string) => (value.length > ID_MAX_LENGTH ? '' : value);

/** A bill's total is fixed by the transaction it is linked to (an own-share row follows the share instead). */
const fixedTotal = (split: SplitDetail) =>
	split.linked && !split.linked.ownShare ? split.totalAmountMinor : null;

/** The stored split as the form shows it; a member no longer in the space is kept as a named guest. */
function formValues(
	split: SplitDetail,
	live: ReadonlySet<string>,
	locale: Locale
): PatunganFormValues {
	const text = (minor: number) => minorToAmountText(minor, split.currency, locale);
	const others = split.participants.filter((p) => !p.isPayer);
	const members = others.filter((p) => p.memberUserId && live.has(p.memberUserId));
	const payer = split.participants.find((p) => p.isPayer);
	return {
		title: split.title,
		occurredOn: split.occurredOn,
		note: split.note ?? '',
		mode: split.mode,
		amount: text(split.totalAmountMinor),
		payerShare: payer ? text(payer.shareAmountMinor) : '',
		members: members.map((p) => p.memberUserId as string),
		memberShares: Object.fromEntries(
			members.map((p) => [p.memberUserId as string, text(p.shareAmountMinor)])
		),
		guests: others
			.filter((p) => !members.includes(p))
			.map((p) => ({ name: p.displayName, share: text(p.shareAmountMinor) })),
		walletId: '',
		categoryId: ''
	};
}

// FN-49 "Ubah patungan": payer-only. While nobody else has paid, everything can change (a full re-save); once
// someone has, only the title, date and note (`details`). The server refuses the rest, not only the form.
export const load: PageServerLoad = async ({ locals, params }) => {
	const scope = await currentSpaceScope(locals);
	const split = await getSplit(locals.db, scope.spaceId, bounded(params.id));
	if (!split) error(404, 'Not found');
	if (split.createdByUserId !== scope.userId || split.isDemo)
		redirect(303, `/patungan/${split.id}`);
	const members = await spaceMemberNames(locals.db, scope.spaceId);
	return {
		split,
		members: members.filter((m) => m.userId !== scope.userId),
		fixedTotal: fixedTotal(split),
		values: formValues(split, new Set(members.map((m) => m.userId)), locals.locale)
	};
};

async function guarded(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const scope = await currentSpaceScope(event.locals);
	const split = await getSplit(event.locals.db, scope.spaceId, bounded(event.params.id));
	return { form, scope, db: event.locals.db, split };
}

function refused(result: SplitWriteRefusal) {
	if (result === 'missing') return fail(404, { error: SPLIT_NOT_FOUND });
	if (result === 'forbidden') return fail(403, { error: PAYER_ONLY });
	if (result === 'stale') return fail(409, { error: SPLIT_CHANGED });
	if (result === 'locked') return fail(409, { error: SPLIT_LOCKED });
	if (result === 'bill') return fail(409, { error: BILL_UNAVAILABLE });
	return fail(409, { error: REFS_GONE });
}

function saved(event: RequestEvent): never {
	setSplitSavedNotice(event.cookies, event.locals.secure, 'updated');
	redirect(303, `/patungan/${event.params.id}?saved=updated`);
}

export const actions: Actions = {
	/** The full re-save: mode, people and shares too (refused once someone else has paid). */
	update: async (event) => {
		const { form, scope, db, split } = await guarded(event);
		// A Data demo split is never written (red team L1): the same answer as a missing one.
		if (!split || split.isDemo) return fail(404, { error: SPLIT_NOT_FOUND });
		if (split.createdByUserId !== scope.userId) return fail(403, { error: PAYER_ONLY });
		if (split.locked) return fail(409, { error: SPLIT_LOCKED });
		const members = await spaceMemberNames(db, scope.spaceId);
		const payer = members.find((m) => m.userId === scope.userId);
		if (!payer) return fail(403, { error: PAYER_ONLY });
		const read = readSplitForm(form, {
			currency: split.currency,
			fixedTotal: fixedTotal(split),
			payer,
			members,
			locale: event.locals.locale
		});
		if (!read.ok) return fail(400, { errors: read.errors, values: read.values });
		const result = await updateSplit(
			db,
			scope,
			split.id,
			read.fields,
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return refused(result);
		saved(event);
	},

	/** Title, date and note only: works on a locked split too. */
	details: async (event) => {
		const { form, scope, db, split } = await guarded(event);
		// A Data demo split is never written (red team L1): the same answer as a missing one.
		if (!split || split.isDemo) return fail(404, { error: SPLIT_NOT_FOUND });
		const title = cleanText(textField(form, 'title'), SPLIT_TITLE_MAX);
		const occurredOn = textField(form, 'occurredOn').slice(0, 10);
		const note = cleanText(
			textField(form, 'note').slice(0, SPLIT_NOTE_MAX * 4),
			SPLIT_NOTE_MAX * 2
		);
		const errors: Record<string, string> = {};
		if (!title) errors.title = TITLE_REQUIRED;
		if (!isDateString(occurredOn)) errors.occurredOn = DATE_INVALID;
		if (Array.from(note).length > SPLIT_NOTE_MAX) errors.note = NOTE_TOO_LONG;
		if (Object.keys(errors).length > 0) return fail(400, { errors });
		const result = await updateSplitDetails(
			db,
			scope,
			split.id,
			{ title, occurredOn, note: note || null },
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return refused(result);
		saved(event);
	}
};
