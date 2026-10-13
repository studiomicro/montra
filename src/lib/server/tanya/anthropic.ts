import { z } from 'zod';
import type { AiKeyTestOutcome } from '../../shared/ai-keys.ts';
import {
	ANTHROPIC_VERSION,
	anthropicGatewayUrl,
	cappedText,
	classifyAnthropicResponse,
	type AiGatewayEnv
} from '../ai-keys/anthropic.ts';
import { RECEIPT_MODEL } from '../receipts/anthropic.ts';

/**
 * One Messages API call of Tanya (FN-22), built on the receipt read's skeleton (FN-15 `readReceiptImage`): the
 * user's own key (BYOK, FN-41) through the app's AI Gateway, the same headers, capped bodies and FN-41's
 * `classifyAnthropicResponse` for a non-2xx answer. No client class, nothing logged; neither the key nor a
 * provider body leaves this module except as the outcome. Automated tests inject `fetchFn`: no test reaches the
 * gateway or Anthropic, so the real path is verified only by the owner-run `npm run compat:tanya`.
 */

/**
 * The model: the receipt reader's own constant (Claude Sonnet 5.5, re-checked against the skill's model table on
 * 2026-10-10), so the app names one Sonnet id. The user pays through their own key. A retired id shows
 * TANYA_MODEL_UNAVAILABLE, never "invalid key".
 */
export const TANYA_MODEL = RECEIPT_MODEL;
/** Output budget of one call: a short answer or a few tool calls (owner decision 5). */
export const TANYA_MAX_TOKENS = 1024;
/** One provider call's deadline (owner decision 5); the whole question has its own (loop.ts). */
export const TANYA_CALL_TIMEOUT_MS = 30_000;
/** Most bytes of a successful answer read (1024 output tokens are far below). */
const ANSWER_MAX_BYTES = 128 * 1024;
const ERROR_BODY_MAX_BYTES = 4096;

/** A tool as the Messages API takes it. */
export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

/** A content block passed back verbatim (text, tool_use and any block the model adds), or a tool_result. */
export type ContentBlock = { type: string } & Record<string, unknown>;

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string | ContentBlock[];
}

const answerSchema = z.object({
	content: z.array(z.looseObject({ type: z.string() })).max(64),
	stop_reason: z.string().nullable(),
	usage: z.looseObject({
		input_tokens: z.number().int().nonnegative(),
		output_tokens: z.number().int().nonnegative()
	})
});

export interface Usage {
	inputTokens: number;
	outputTokens: number;
}

export type AskOutcome =
	| { kind: 'end_turn'; content: ContentBlock[]; usage: Usage }
	| { kind: 'tool_use'; content: ContentBlock[]; usage: Usage }
	/** The answer was cut off at TANYA_MAX_TOKENS. */
	| { kind: 'max_tokens'; usage: Usage }
	/** The model declined (`stop_reason: refusal`). */
	| { kind: 'refusal'; usage: Usage }
	/** A 2xx body that is not a Messages answer, or a stop reason Tanya never asks for. */
	| { kind: 'malformed' }
	/** The deadline passed before the whole answer arrived. */
	| { kind: 'timeout' }
	/** FN-41's provider outcomes for a non-2xx answer (`network` also for a failed fetch). */
	| { kind: Exclude<AiKeyTestOutcome, 'ok'> }
	/** The gateway ids are unset: no call was made. */
	| { kind: 'not_configured' };

export interface AskRequest {
	system: string;
	messages: ChatMessage[];
	/** Omitted (FN-23's narrative): the request carries no `tools` field at all. */
	tools?: readonly ToolDefinition[];
	/** Output budget; TANYA_MAX_TOKENS when omitted. */
	maxTokens?: number;
}

/** One call with `apiKey`. Never throws. */
export async function askClaude(
	env: AiGatewayEnv | undefined,
	apiKey: string,
	request: AskRequest,
	fetchFn: typeof fetch = fetch,
	timeoutMs: number = TANYA_CALL_TIMEOUT_MS
): Promise<AskOutcome> {
	const base = anthropicGatewayUrl(env);
	if (!base) return { kind: 'not_configured' };
	const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
	try {
		const response = await fetchFn(`${base}/v1/messages`, {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': ANTHROPIC_VERSION,
				'content-type': 'application/json',
				// AI Gateway (developers.cloudflare.com/ai-gateway › Caching, › Logging): never answer from a cache, and
				// keep questions and figures out of the owner's gateway logs.
				'cf-aig-skip-cache': 'true',
				'cf-aig-collect-log': 'false'
			},
			body: JSON.stringify({
				model: TANYA_MODEL,
				max_tokens: request.maxTokens ?? TANYA_MAX_TOKENS,
				// Claude Sonnet 5.5 rejects `disabled`; `between_tools` (thinking off, accepted at effort high or below with
				// no other thinking field, tools or not: claude-api skill model table, cached 2026-10-06) keeps thinking
				// out of the small output budget. Omitting `thinking` would run adaptive thinking inside max_tokens.
				thinking: { type: 'between_tools' },
				system: request.system,
				...(request.tools ? { tools: request.tools } : {}),
				messages: request.messages
			}),
			redirect: 'manual',
			signal
		});
		if (!response.ok) {
			const outcome = classifyAnthropicResponse(
				response.status,
				await cappedText(response, ERROR_BODY_MAX_BYTES)
			);
			if (signal.aborted) return { kind: 'timeout' };
			return { kind: outcome === 'ok' ? 'network' : outcome };
		}
		const body = await cappedText(response, ANSWER_MAX_BYTES);
		if (signal.aborted) return { kind: 'timeout' };
		return interpretAnswer(body);
	} catch {
		return { kind: signal.aborted ? 'timeout' : 'network' };
	}
}

/** A 2xx body → outcome (exported for tests). */
export function interpretAnswer(body: string): AskOutcome {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { kind: 'malformed' };
	}
	const answer = answerSchema.safeParse(parsed);
	if (!answer.success) return { kind: 'malformed' };
	const { content, stop_reason: stop, usage } = answer.data;
	const counted = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
	const blocks = content as ContentBlock[];
	if (stop === 'end_turn') return { kind: 'end_turn', content: blocks, usage: counted };
	if (stop === 'tool_use') return { kind: 'tool_use', content: blocks, usage: counted };
	if (stop === 'max_tokens') return { kind: 'max_tokens', usage: counted };
	if (stop === 'refusal') return { kind: 'refusal', usage: counted };
	return { kind: 'malformed' };
}
