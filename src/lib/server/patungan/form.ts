import { isDateString } from '#lib/shared/dates';
import type { Locale } from '#lib/shared/i18n';
import { MAX_AMOUNT_MINOR } from '#lib/shared/money-parse';
import {
	equalShares,
	exactShares,
	isFormMode,
	MAX_PARTICIPANTS,
	PERSON_NAME_MAX,
	SPLIT_NOTE_MAX,
	SPLIT_TITLE_MAX,
	typedUnitMinor,
	type PatunganFormValues
} from '#lib/shared/patungan';
import { cleanText } from '#lib/shared/text';
import { amountMinorFromText, textField } from '../forms';
import { DATE_INVALID } from '../transactions/messages';
import { ID_MAX_LENGTH } from '../transactions/validation';
import {
	GUEST_NAME_INVALID,
	MEMBER_NOT_FOUND,
	MODE_INVALID,
	NOTE_TOO_LONG,
	PEOPLE_COUNT,
	SHARE_INVALID,
	SUM_MISMATCH,
	TITLE_REQUIRED,
	TOTAL_INVALID,
	TOTAL_TOO_SMALL
} from './messages';
import type { ParticipantInput, SplitFields } from './repo';

/** Longest typed amount or name read from a field (cut before any work). */
const FIELD_CAP = 64;

/**
 * The create/edit form's fields as typed, each cut to a bounded length and the repeated ones to
 * MAX_PARTICIPANTS rows before any work. Guests are two aligned lists (`guestName`, `guestShare`), one pair per
 * row; a row with an empty name is no guest.
 */
export function splitFormValues(form: FormData): PatunganFormValues {
	const strings = (name: string) =>
		form
			.getAll(name)
			.slice(0, MAX_PARTICIPANTS)
			.map((v) => (typeof v === 'string' ? v : ''));
	const members = [...new Set(strings('member').map((v) => v.slice(0, ID_MAX_LENGTH + 1)))];
	const names = strings('guestName');
	const shares = strings('guestShare');
	return {
		title: textField(form, 'title').slice(0, SPLIT_TITLE_MAX * 4),
		occurredOn: textField(form, 'occurredOn').slice(0, 10),
		note: textField(form, 'note').slice(0, SPLIT_NOTE_MAX * 4),
		mode: textField(form, 'mode').slice(0, 16),
		amount: textField(form, 'amount').slice(0, FIELD_CAP),
		payerShare: textField(form, 'payerShare').slice(0, FIELD_CAP),
		members,
		memberShares: Object.fromEntries(
			members.map((id) => [id, textField(form, `memberShare.${id}`).slice(0, FIELD_CAP)])
		),
		guests: names.map((name, i) => ({
			name: name.slice(0, PERSON_NAME_MAX * 4),
			share: (shares[i] ?? '').slice(0, FIELD_CAP)
		})),
		walletId: textField(form, 'walletId').slice(0, ID_MAX_LENGTH + 1),
		categoryId: textField(form, 'categoryId').slice(0, ID_MAX_LENGTH + 1)
	};
}

export type SplitFormErrors = Partial<Record<string, string>>;

export type ReadSplitForm =
	| { ok: true; fields: SplitFields; values: PatunganFormValues }
	| { ok: false; errors: SplitFormErrors; values: PatunganFormValues };

export interface SplitFormContext {
	/** The split's currency: the linked bill's, the split's own (edit) or the chosen wallet's (standalone create). */
	currency: string;
	/** The total, when fixed by a linked bill (the typed amount is then ignored). */
	fixedTotal: number | null;
	/** The payer: the signed-in member. */
	payer: { userId: string; name: string };
	/** The space's live members (the payer included; filtered out here). */
	members: readonly { userId: string; name: string }[];
	locale: Locale;
}

const amountOf = (text: string, ctx: SplitFormContext): number | null => {
	const minor = amountMinorFromText(text, ctx.currency, ctx.locale);
	return minor === null || minor < 1 || minor > MAX_AMOUNT_MINOR ? null : minor;
};

/**
 * The create/edit form → the split's content, or one error per field. The people are the payer (always first),
 * the picked members (live members of the space only) and the named guests; the shares come from the shared
 * rounding engine (`equalShares`: remainder to the payer; `exactShares`: must add up exactly). No database work:
 * the repo re-checks every member and the bill inside its own statements.
 */
export function readSplitForm(form: FormData, ctx: SplitFormContext): ReadSplitForm {
	const values = splitFormValues(form);
	const errors: SplitFormErrors = {};

	const title = cleanText(values.title, SPLIT_TITLE_MAX);
	if (!title) errors.title = TITLE_REQUIRED;
	if (!isDateString(values.occurredOn)) errors.occurredOn = DATE_INVALID;
	const note = cleanText(values.note, SPLIT_NOTE_MAX * 2);
	if (Array.from(note).length > SPLIT_NOTE_MAX) errors.note = NOTE_TOO_LONG;
	const mode = values.mode;
	if (!isFormMode(mode)) errors.mode = MODE_INVALID;

	const others = ctx.members.filter((m) => m.userId !== ctx.payer.userId);
	const people: (ParticipantInput & { text: string; key: string })[] = [
		{
			kind: 'member',
			memberUserId: ctx.payer.userId,
			displayName: ctx.payer.name,
			shareAmountMinor: 0,
			text: values.payerShare,
			key: 'payerShare'
		}
	];
	for (const id of values.members) {
		const member = others.find((m) => m.userId === id);
		if (!member) {
			errors.people = MEMBER_NOT_FOUND;
			continue;
		}
		people.push({
			kind: 'member',
			memberUserId: member.userId,
			displayName: member.name,
			shareAmountMinor: 0,
			text: values.memberShares[id] ?? '',
			key: `memberShare.${id}`
		});
	}
	values.guests.forEach((guest, i) => {
		if (guest.name.trim() === '') return;
		const name = cleanText(guest.name, PERSON_NAME_MAX);
		if (!name) {
			errors[`guest.${i}`] = GUEST_NAME_INVALID;
			return;
		}
		people.push({
			kind: 'guest',
			memberUserId: null,
			displayName: name,
			shareAmountMinor: 0,
			text: guest.share,
			key: `guest.${i}`
		});
	});
	if (people.length < 2 || people.length > MAX_PARTICIPANTS) errors.people ??= PEOPLE_COUNT;

	const total = ctx.fixedTotal ?? amountOf(values.amount, ctx);
	if (total === null) errors.amount = TOTAL_INVALID;

	if (total !== null && isFormMode(mode) && !errors.people) {
		if (mode === 'equal') {
			const result = equalShares(total, people.length, 0, typedUnitMinor(ctx.currency));
			if (result.ok)
				result.shares.forEach((s, i) => ((people[i] as ParticipantInput).shareAmountMinor = s));
			else errors.amount = TOTAL_TOO_SMALL;
		} else {
			const amounts = people.map((p) => amountOf(p.text, ctx));
			amounts.forEach((a, i) => {
				if (a === null) errors[(people[i] as { key: string }).key] ??= SHARE_INVALID;
			});
			const result = exactShares(total, amounts);
			if (result.ok)
				result.shares.forEach((s, i) => ((people[i] as ParticipantInput).shareAmountMinor = s));
			else if (result.reason === 'sum_mismatch') errors.shares = SUM_MISMATCH;
		}
	}

	if (Object.keys(errors).length > 0 || total === null || !isFormMode(mode))
		return { ok: false, errors, values };
	return {
		ok: true,
		values,
		fields: {
			title,
			occurredOn: values.occurredOn,
			note: note || null,
			mode,
			totalAmountMinor: total,
			participants: people.map(({ kind, memberUserId, displayName, shareAmountMinor }) => ({
				kind,
				memberUserId,
				displayName,
				shareAmountMinor
			}))
		}
	};
}
