import { fail, redirect } from '@sveltejs/kit';
import { isAiGatewayConfigured } from '#lib/server/ai-keys/anthropic';
import { resolveAnthropicKey } from '#lib/server/ai-keys/lookup';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { createUserLane } from '#lib/server/lane';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { guardAnswer } from '#lib/server/tanya/answer-guard';
import { FigureBook } from '#lib/server/tanya/figures';
import { runTanya, type LoopFailure } from '#lib/server/tanya/loop';
import {
	TANYA_BUSY,
	TANYA_CLEAR_FAILED,
	TANYA_CUT_OFF,
	TANYA_EMPTY,
	TANYA_LOAD_FAILED,
	TANYA_MALFORMED,
	TANYA_MODEL_UNAVAILABLE,
	TANYA_NO_KEY,
	TANYA_NOT_CONFIGURED,
	TANYA_RATE_LIMITED,
	TANYA_REFUSED,
	TANYA_SAVE_FAILED,
	TANYA_TIMEOUT,
	TANYA_TOO_MANY_ROUNDS
} from '#lib/server/tanya/messages';
import {
	alreadyAsked,
	deleteConversation,
	historyForModel,
	listMessages,
	purgeExpired,
	questionRowId,
	saveExchange
} from '#lib/server/tanya/repo';
import { makeTools } from '#lib/server/tanya/tools';
import { errorLabel, newId } from '#lib/server/util';
import { AI_KEY_TEST_LABELS } from '#lib/shared/ai-keys';
import { wibTodayString } from '#lib/shared/dates';
import {
	cleanQuestion,
	TANYA_ASKS_PER_WINDOW,
	TANYA_HISTORY_TURNS,
	type TanyaReady
} from '#lib/shared/tanya';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * FN-22 Tanya. One running conversation per (user, space). `ask` answers one question with the user's own key
 * (BYOK, FN-41) through a read-only tool loop; the question and the checked answer are saved together only once
 * the answer is ready, then the page reloads (redirect after post). `clear` ("Percakapan baru") deletes the
 * conversation. Every load and action resolves the space through `currentSpaceScope` (signed out: /masuk; a
 * removed member: the shared 404), and the tools only ever see that space.
 */

/** Questions one isolate answers at once; one per user. */
const TANYA_LANE_MAX = 10;
const reserveTanyaSlot = createUserLane(TANYA_LANE_MAX);
/** Seconds a client is told to wait when the lane is full or this user already has a question in flight. */
const TANYA_RETRY_AFTER_S = 30;
/** Longest form-supplied `askId` (a UUID). */
const ASK_ID = /^[0-9a-f-]{36}$/;

/** Longest `?q=` read before cleaning (a few times TANYA_QUESTION_MAX; the rest is never looked at). */
const PREFILL_READ_MAX = 2_000;

export const load: PageServerLoad = async ({ locals, url }) => {
	const scope = await currentSpaceScope(locals);
	// FN-54 B4: Beranda's ask field opens Tanya with its question in the composer. A prefill only: nothing is sent,
	// no AI call, credit or key is used and no row is written until the user presses Kirim. Untrusted text: capped,
	// then cleaned like a posted question (control and zero-width characters out), and only ever rendered as text.
	const prefill = cleanQuestion((url.searchParams.get('q') ?? '').slice(0, PREFILL_READ_MAX));
	const db = locals.db;
	const env = getEnv();
	const configured = isAiGatewayConfigured(env);
	const now = Date.now();
	try {
		await purgeExpired(db, scope.userId, now);
		const [messages, hasKey] = await Promise.all([
			listMessages(db, scope, now),
			// Only whether a key opens: the key itself never leaves the server.
			configured ? resolveAnthropicKey(db, scope.userId, env).then((k) => k !== null) : false
		]);
		const ready: TanyaReady = !configured ? 'no_gateway' : hasKey ? 'ok' : 'no_key';
		return { messages, ready, askId: newId(), prefill, loadError: null };
	} catch (e) {
		console.error('tanya: load failed', errorLabel(e));
		const ready: TanyaReady = configured ? 'ok' : 'no_gateway';
		return { messages: [], ready, askId: newId(), prefill, loadError: TANYA_LOAD_FAILED };
	}
};

const FAILURES: Record<LoopFailure, readonly [number, string]> = {
	invalid: [502, AI_KEY_TEST_LABELS.invalid],
	quota: [502, AI_KEY_TEST_LABELS.quota],
	network: [502, AI_KEY_TEST_LABELS.network],
	model_unavailable: [502, TANYA_MODEL_UNAVAILABLE],
	timeout: [504, TANYA_TIMEOUT],
	malformed: [502, TANYA_MALFORMED],
	max_tokens: [502, TANYA_CUT_OFF],
	refusal: [422, TANYA_REFUSED],
	too_many_rounds: [422, TANYA_TOO_MANY_ROUNDS],
	not_configured: [503, TANYA_NOT_CONFIGURED]
};

function busy(event: RequestEvent, q: string) {
	event.setHeaders({ 'retry-after': String(TANYA_RETRY_AFTER_S) });
	return fail(503, { action: 'ask' as const, error: TANYA_BUSY, q });
}

export const actions: Actions = {
	/** One question: refused before any provider call when unconfigured, keyless, busy or over the limit. */
	ask: async (event) => {
		const scope = await currentSpaceScope(event.locals);
		const db = event.locals.db;
		const form = await readFormBody(event.request);
		// The typed text goes back with every refusal, so the box keeps it.
		const q = textField(form, 'q').slice(0, 2000);
		const question = cleanQuestion(q);
		if (!question) return fail(400, { action: 'ask' as const, error: TANYA_EMPTY, q });
		const env = getEnv();
		if (!isAiGatewayConfigured(env))
			return fail(503, { action: 'ask' as const, error: TANYA_NOT_CONFIGURED, q });
		const apiKey = await resolveAnthropicKey(db, scope.userId, env);
		if (!apiKey) return fail(400, { action: 'ask' as const, error: TANYA_NO_KEY, noKey: true, q });
		const askId = textField(form, 'askId');
		const questionId = await questionRowId(scope.userId, ASK_ID.test(askId) ? askId : newId());
		// A resubmitted form (reload, double tap) was answered already: show the conversation, ask nothing.
		if (await alreadyAsked(db, scope, questionId)) redirect(303, '/tanya');
		const release = reserveTanyaSlot(scope.userId);
		if (!release) return busy(event, q);
		try {
			const askedAt = Date.now();
			// Counted before any provider call; a provider failure still counts (criterion 18).
			if (await overUserAttemptLimit(db, scope.userId, askedAt, 'tanya-ask', TANYA_ASKS_PER_WINDOW))
				return fail(429, { action: 'ask' as const, error: TANYA_RATE_LIMITED, q });
			const book = new FigureBook(event.locals.locale);
			const outcome = await runTanya({
				env,
				apiKey,
				question,
				history: await historyForModel(db, scope, askedAt, TANYA_HISTORY_TURNS),
				tools: makeTools({
					db,
					spaceId: scope.spaceId,
					today: wibTodayString(askedAt),
					locale: event.locals.locale,
					book
				})
			});
			if (outcome.kind !== 'answer') {
				const [status, error] = FAILURES[outcome.kind];
				return fail(status, { action: 'ask' as const, error, q });
			}
			const answer = guardAnswer(outcome.text, book);
			try {
				await saveExchange(db, scope, {
					questionId,
					answerId: newId(),
					question,
					answer: answer.text,
					cards: outcome.cards,
					inputTokens: outcome.inputTokens,
					outputTokens: outcome.outputTokens,
					toolCalls: outcome.toolCalls,
					askedAt,
					answeredAt: Date.now()
				});
			} catch (e) {
				// A concurrent duplicate of the same submission saved first: that answer is the one shown.
				if (await alreadyAsked(db, scope, questionId).catch(() => false)) redirect(303, '/tanya');
				console.error('tanya: save failed', errorLabel(e));
				return fail(503, { action: 'ask' as const, error: TANYA_SAVE_FAILED, q });
			}
		} finally {
			release();
		}
		// Success only after both rows are saved; the page then lists them (redirect after post).
		redirect(303, '/tanya');
	},

	/** "Percakapan baru": deletes this user's conversation in this space (idempotent). */
	clear: async (event) => {
		const scope = await currentSpaceScope(event.locals);
		await readFormBody(event.request);
		try {
			await deleteConversation(event.locals.db, scope);
		} catch (e) {
			console.error('tanya: clear failed', errorLabel(e));
			return fail(503, { action: 'clear' as const, error: TANYA_CLEAR_FAILED });
		}
		redirect(303, '/tanya');
	}
};
