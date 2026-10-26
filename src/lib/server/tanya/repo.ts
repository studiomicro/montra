import { and, count, desc, eq, gt, sql } from 'drizzle-orm';
import {
	parseCards,
	TANYA_CARDS_MAX_BYTES,
	TANYA_LIST_MAX,
	TANYA_RETENTION_MS,
	type TanyaCard,
	type TanyaMessageView
} from '#lib/shared/tanya';
import type { Db } from '../db';
import { tanyaMessages } from '../db/schema';
import { sha256Hex } from '../util';

/**
 * `tanya_messages` (FN-22): every function is scoped to the caller's own (user, space), resolved from the session
 * (`currentSpaceScope`) by the route, never from the request. Expired rows are never listed, counted or sent
 * to the model, and `purgeExpired` deletes them when /tanya loads.
 */

/** Expired rows one load deletes (owner decision 6). */
const TANYA_PURGE_BATCH = 200;

export interface TanyaScope {
	userId: string;
	spaceId: string;
}

const live = (scope: TanyaScope, now: number) =>
	and(
		eq(tanyaMessages.userId, scope.userId),
		eq(tanyaMessages.spaceId, scope.spaceId),
		gt(tanyaMessages.expiresAt, now)
	);

/** The newest TANYA_LIST_MAX live rows, oldest first. */
export async function listMessages(
	db: Db,
	scope: TanyaScope,
	now: number
): Promise<TanyaMessageView[]> {
	const rows = await db
		.select({
			id: tanyaMessages.id,
			role: tanyaMessages.role,
			body: tanyaMessages.body,
			cardsJson: tanyaMessages.cardsJson,
			createdAt: tanyaMessages.createdAt
		})
		.from(tanyaMessages)
		.where(live(scope, now))
		.orderBy(desc(tanyaMessages.createdAt), desc(tanyaMessages.id))
		.limit(TANYA_LIST_MAX);
	return rows.reverse().map((r) => ({
		id: r.id,
		role: r.role,
		body: r.body,
		cards: parseCards(r.cardsJson),
		createdAt: r.createdAt
	}));
}

/** Live rows of the conversation. */
export async function countMessages(db: Db, scope: TanyaScope, now: number): Promise<number> {
	const [row] = await db.select({ n: count() }).from(tanyaMessages).where(live(scope, now));
	return row?.n ?? 0;
}

/** "Percakapan baru" / "Hapus semua percakapan": deletes the caller's rows in this space (idempotent). */
export async function deleteConversation(db: Db, scope: TanyaScope): Promise<void> {
	await db
		.delete(tanyaMessages)
		.where(and(eq(tanyaMessages.userId, scope.userId), eq(tanyaMessages.spaceId, scope.spaceId)));
}

/** Deletes up to TANYA_PURGE_BATCH of the user's expired rows (every space). */
export async function purgeExpired(db: Db, userId: string, now: number): Promise<void> {
	await db.delete(tanyaMessages).where(
		sql`${tanyaMessages.id} in (select id from tanya_messages
			where user_id = ${userId} and expires_at <= ${now} limit ${TANYA_PURGE_BATCH})`
	);
}

/**
 * The question row's id for one form submission: derived from the user and the form's one-time `askId`, so a
 * resubmitted form names the same row (and cannot name another user's).
 */
export async function questionRowId(userId: string, askId: string): Promise<string> {
	return (await sha256Hex(`tanya:${userId}:${askId}`)).slice(0, 32);
}

/** Whether this submission was already answered (a resubmitted form; nothing is asked twice). */
export async function alreadyAsked(db: Db, scope: TanyaScope, rowId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: tanyaMessages.id })
		.from(tanyaMessages)
		.where(and(eq(tanyaMessages.id, rowId), eq(tanyaMessages.userId, scope.userId)))
		.limit(1);
	return row !== undefined;
}

/** The last `turns` question-and-answer pairs, oldest first, for the model (bodies only, never cards). */
export async function historyForModel(
	db: Db,
	scope: TanyaScope,
	now: number,
	turns: number
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
	const rows = await db
		.select({ role: tanyaMessages.role, body: tanyaMessages.body })
		.from(tanyaMessages)
		.where(live(scope, now))
		.orderBy(desc(tanyaMessages.createdAt), desc(tanyaMessages.id))
		.limit(turns * 2);
	const ordered = rows.reverse();
	// Only whole pairs, starting with a question (the API wants user first and alternating turns).
	const out: { role: 'user' | 'assistant'; content: string }[] = [];
	for (let i = 0; i + 1 < ordered.length; i++) {
		const q = ordered[i];
		const a = ordered[i + 1];
		if (q?.role === 'user' && a?.role === 'assistant') {
			out.push({ role: 'user', content: q.body }, { role: 'assistant', content: a.body });
			i++;
		}
	}
	return out;
}

/** The cards as stored: the leading ones that fit TANYA_CARDS_MAX_BYTES (the CHECK), null for none. */
function cardsJson(cards: readonly TanyaCard[]): string | null {
	for (let n = cards.length; n > 0; n--) {
		const json = JSON.stringify(cards.slice(0, n));
		if (new TextEncoder().encode(json).byteLength <= TANYA_CARDS_MAX_BYTES) return json;
	}
	return null;
}

/**
 * Saves one answered question: the question row and the answer row in one `db.batch` (both or neither). The
 * question row's id is `questionRowId`, so a concurrent duplicate of the same submission fails the whole batch.
 */
export async function saveExchange(
	db: Db,
	scope: TanyaScope,
	exchange: {
		questionId: string;
		answerId: string;
		question: string;
		answer: string;
		cards: TanyaCard[];
		inputTokens: number;
		outputTokens: number;
		toolCalls: number;
		askedAt: number;
		answeredAt: number;
	}
): Promise<void> {
	const answeredAt = Math.max(exchange.answeredAt, exchange.askedAt + 1);
	await db.batch([
		db.insert(tanyaMessages).values({
			id: exchange.questionId,
			userId: scope.userId,
			spaceId: scope.spaceId,
			role: 'user',
			body: exchange.question,
			createdAt: exchange.askedAt,
			expiresAt: exchange.askedAt + TANYA_RETENTION_MS
		}),
		db.insert(tanyaMessages).values({
			id: exchange.answerId,
			userId: scope.userId,
			spaceId: scope.spaceId,
			role: 'assistant',
			body: exchange.answer,
			cardsJson: cardsJson(exchange.cards),
			inputTokens: exchange.inputTokens,
			outputTokens: exchange.outputTokens,
			toolCalls: exchange.toolCalls,
			createdAt: answeredAt,
			expiresAt: answeredAt + TANYA_RETENTION_MS
		})
	]);
}
