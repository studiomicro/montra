import { isHttpError } from '@sveltejs/kit';
import { addDays, wibInstantUtcMs, wibTodayString } from '#lib/shared/dates';
import type { Locale } from '#lib/shared/i18n';
import {
	QUEUE_INVALID,
	QUEUE_ONLINE_ONLY,
	QUEUE_SPACE_GONE,
	type PushRequest,
	type PushResponse,
	type PushResult
} from '#lib/shared/offline-queue';
import { parsePushRequest } from '#lib/shared/offline-queue-schema';
import { SESSION_ENDED } from '../auth/gate';
import type { Db } from '../db';
import { getEnv } from '../env';
import { textField } from '../forms';
import { requireSpaceAccess, type SpaceScope } from '../spaces/access';
import { createTransactionOnce } from '../transactions/client-id';
import { overTransactionCreateLimit } from '../transactions/create-limit';
import { readTransactionForm } from '../transactions/form';
import {
	REFS_GONE,
	TRANSACTION_CHANGED,
	TRANSACTION_LINKED,
	TRANSACTION_LIMIT,
	TRANSACTION_NOT_FOUND,
	TRANSACTION_RATE_LIMITED
} from '../transactions/messages';
import {
	deleteTransaction,
	getTransaction,
	isTombstoneInSpace,
	updateTransaction,
	type TransactionDetail
} from '../transactions/repo';
import { ID_MAX_LENGTH, type TransactionInput } from '../transactions/validation';
import {
	checkVoiceRows,
	recordAgain,
	saveVoiceTransactions,
	submissionKey
} from '../transactions/voice';

/**
 * FN-02 `/api/v1/sync/push`: one queued write, mapped onto the very function the page action calls (riwayat/baru
 * `create`, riwayat/[id]/edit `update`/`delete`, riwayat/suara `save`/`catatLagi`/`urungkan`) with the same
 * checks. No business logic of its own: the space is the item's own `spaceId`, re-checked with
 * `requireSpaceAccess` for the session's user (never the space that is current now, never a client user id);
 * every id in the payload is then looked up inside that space only.
 */
export interface PushOutcome {
	status: number;
	body: PushResponse;
}

const STATUS: Record<PushResult, number> = {
	ok: 200,
	invalid: 400,
	session: 401,
	missing: 404,
	'no-access': 404,
	stale: 409,
	limit: 409,
	gone: 409
};

const MESSAGE: Partial<Record<PushResult, string>> = {
	missing: TRANSACTION_NOT_FOUND,
	'no-access': QUEUE_SPACE_GONE,
	stale: TRANSACTION_CHANGED,
	limit: TRANSACTION_LIMIT,
	gone: REFS_GONE,
	invalid: QUEUE_INVALID
};

function answer(clientId: string | null, result: PushResult, message?: string): PushOutcome {
	const text = message ?? MESSAGE[result];
	return {
		status: STATUS[result],
		body: text ? { clientId, result, message: text } : { clientId, result }
	};
}

function formOf(item: PushRequest): FormData {
	const form = new FormData();
	for (const [name, value] of item.payload) form.append(name, value);
	return form;
}

/** The first field error's message id (every one is a msg() phrase). */
const firstError = (errors: Partial<Record<string, string>>) =>
	Object.values(errors).find((m): m is string => typeof m === 'string');

const idField = (form: FormData, name: string) => {
	const value = textField(form, name);
	return value.length > ID_MAX_LENGTH ? '' : value;
};

/**
 * Pushes one user may send per throttle window (10 minutes): a full queue (200 items) drains three times over,
 * a script hammering the endpoint does not.
 */
export const SYNC_PUSH_MAX_PER_WINDOW = 600;

/** How far back a queued voice entry may be dated: the 7-day stale window plus one day. */
const VOICE_DAY_MAX_BACK_DAYS = 8;

/**
 * The day a voice entry counts on. The online voice actions date rows today (WIB); a queued entry keeps the WIB
 * date it was queued on only when that is today or at most VOICE_DAY_MAX_BACK_DAYS before it (an item older
 * than the stale window was resent by the user and counts like a fresh entry). Anything else — earlier, later,
 * or a device clock that is off — is today (WIB) on the server, exactly as online.
 */
function voiceDay(item: PushRequest, now: number): string {
	const today = wibTodayString(now);
	const day = item.occurredOn;
	return day && day <= today && day >= addDays(today, -VOICE_DAY_MAX_BACK_DAYS) ? day : today;
}

/**
 * The row already holds exactly what this edit writes: a resend of an edit whose first attempt landed (its
 * answer was lost), or the same edit made elsewhere. Then the edit is applied, not "changed meanwhile".
 */
function alreadyApplied(current: TransactionDetail, input: TransactionInput): boolean {
	return (
		current.type === input.type &&
		current.amountMinor === input.amountMinor &&
		current.currency === input.currency &&
		current.walletId === input.walletId &&
		current.transferToWalletId === input.transferToWalletId &&
		current.categoryId === input.categoryId &&
		current.title === input.title &&
		current.note === input.note &&
		current.occurredOn === input.occurredOn &&
		(!input.occurredTime ||
			current.occurredAt === wibInstantUtcMs(input.occurredOn, input.occurredTime))
	);
}

async function dispatch(
	db: Db,
	scope: SpaceScope,
	item: PushRequest,
	now: number,
	locale: Locale
): Promise<PushOutcome> {
	const { clientId } = item;
	const form = formOf(item);
	switch (item.kind) {
		case 'transaction.create': {
			const read = await readTransactionForm(db, scope.spaceId, form, locale);
			if (!read.ok) return answer(clientId, 'invalid', firstError(read.errors));
			const created = await createTransactionOnce(db, scope, clientId, read.input, now);
			return answer(clientId, created.ok ? 'ok' : created.reason);
		}
		case 'transaction.update':
		case 'transaction.delete': {
			const targetId = (item.targetId ?? '').slice(0, ID_MAX_LENGTH + 1);
			// A delete resent after it landed (its answer was lost) finds the tombstone: already applied.
			const gone = async () =>
				item.kind === 'transaction.delete' &&
				(await isTombstoneInSpace(db, scope.spaceId, targetId));
			const current = await getTransaction(db, scope.spaceId, targetId);
			if (!current) return answer(clientId, (await gone()) ? 'ok' : 'missing');
			// A balance adjustment (FN-37) is changed only online, through its own form.
			if (current.type === 'adjustment') return answer(clientId, 'invalid', QUEUE_ONLINE_ONLY);
			const expected = item.expectedUpdatedAt ?? -1;
			if (item.kind === 'transaction.delete') {
				const result = await deleteTransaction(db, scope, targetId, expected, now, getEnv());
				return answer(clientId, result === 'missing' && (await gone()) ? 'ok' : result);
			}
			const read = await readTransactionForm(db, scope.spaceId, form, locale, current);
			if (!read.ok) return answer(clientId, 'invalid', firstError(read.errors));
			if (current.updatedAt !== expected && alreadyApplied(current, read.input))
				return answer(clientId, 'ok');
			const updated = await updateTransaction(db, scope, targetId, read.input, expected, now);
			// FN-49: a split's bill keeps its amount offline too; the queued edit is refused with the reason.
			return updated === 'linked'
				? answer(clientId, 'invalid', TRANSACTION_LINKED)
				: answer(clientId, updated);
		}
		case 'voice.save': {
			const key = submissionKey(form);
			if (!key) return answer(clientId, 'invalid');
			const checked = await checkVoiceRows(db, scope.spaceId, form, voiceDay(item, now), locale);
			if (!checked.ok) {
				const message = checked.errors.map(firstError).find(Boolean);
				return answer(clientId, 'invalid', message);
			}
			const saved = await saveVoiceTransactions(db, scope, checked.inputs, key, now);
			// `duplicate`: this very submission was written before (an unanswered first attempt).
			if (saved.ok || saved.reason === 'duplicate') return answer(clientId, 'ok');
			return answer(clientId, saved.reason);
		}
		case 'voice.recordAgain': {
			const key = submissionKey(form);
			const id = idField(form, 'id');
			if (!key || !id) return answer(clientId, 'missing');
			const r = await recordAgain(db, scope, id, key, voiceDay(item, now), now);
			if (r.ok || r.reason === 'duplicate') return answer(clientId, 'ok');
			return answer(clientId, r.reason);
		}
	}
}

/** Queue items that create transactions (counted against the per-user creation budget). */
const CREATING = new Set<PushRequest['kind']>([
	'transaction.create',
	'voice.save',
	'voice.recordAgain'
]);

/**
 * One parsed JSON body for `userId` (the session's user; the route answers 401 before this without one).
 * `session` (401) when the item was queued for another account.
 * `invalid` (400) for a body that is not one queue item; `no-access` (404, one answer for a space that does
 * not exist, that the user left or was removed from) before any payload id is read; 429 for a creating item
 * past the per-user creation budget (the route adds Retry-After). `locale` is the session's UI language, used
 * only for an item queued without its own (`PushRequest.locale`, FN-47).
 */
export async function pushQueuedWrite(
	db: Db,
	userId: string,
	value: unknown,
	now: number,
	locale: Locale
): Promise<PushOutcome> {
	const item = parsePushRequest(value);
	if (!item) return answer(null, 'invalid');
	// Queued for another account than the session's (a stale tab after an account switch): never written here.
	if (item.accountId !== userId) return answer(item.clientId, 'session', SESSION_ENDED);
	let scope: SpaceScope;
	try {
		const access = await requireSpaceAccess(db, userId, item.spaceId);
		scope = { spaceId: access.space.id, userId };
	} catch (e) {
		if (isHttpError(e) && e.status === 404) return answer(item.clientId, 'no-access');
		throw e;
	}
	// The same per-user creation budget as the page actions (one per creating item, a voice save of many rows
	// counting once): 429, so the device keeps the item and sends it again after Retry-After.
	if (CREATING.has(item.kind) && (await overTransactionCreateLimit(db, userId, now)))
		return {
			status: 429,
			body: { clientId: item.clientId, result: 'limit', message: TRANSACTION_RATE_LIMITED }
		};
	// FN-47: the language the form was typed in wins over the session's (a language switch while offline).
	return dispatch(db, scope, item, now, item.locale ?? locale);
}
