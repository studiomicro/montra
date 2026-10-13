import type { AiKeyTestOutcome } from '../../shared/ai-keys.ts';
import { base64Encode } from '../../shared/base64url.ts';
import type { PhotoType } from '../../shared/photos.ts';
import type { ReceiptReading } from '../../shared/receipts.ts';
import {
	ANTHROPIC_VERSION,
	anthropicGatewayUrl,
	cappedText,
	classifyAnthropicResponse,
	type AiGatewayEnv
} from '../ai-keys/anthropic.ts';
import { RECEIPT_OUTPUT_SCHEMA, RECEIPT_SYSTEM_PROMPT, RECEIPT_USER_PROMPT } from './prompt.ts';
import { interpretReceiptAnswer } from './schema.ts';

/**
 * One receipt read (FN-15): a single Messages API call with the user's own Anthropic key (BYOK, FN-41) through
 * the app's AI Gateway, the photo inline as one image block, the answer constrained to RECEIPT_OUTPUT_SCHEMA and
 * checked again by schema.ts. A non-2xx answer is classified by FN-41's `classifyAnthropicResponse` unchanged.
 * Nothing here logs; neither the key, the photo nor the answer leaves this module except as the outcome.
 * Automated tests inject `fetchFn`: no test reaches the gateway or Anthropic, so the real path is verified only
 * by the owner-run `npm run compat:receipts`.
 */

/**
 * The reading model, Claude Sonnet 5.5 (owner decision 3: the stronger mid-tier vision model; the user pays
 * through their own key). Listed on docs.anthropic.com › Models overview, re-checked 2026-10-09. Model ids are
 * retired over time: a retired id shows RECEIPT_MODEL_UNAVAILABLE, never "invalid key".
 */
export const RECEIPT_MODEL = 'claude-sonnet-5-5';
/** Output budget: a long itemised receipt as JSON fits well within it (the model's cap is far higher). */
export const RECEIPT_MAX_TOKENS = 4096;
/** "Every AI call … has a timeout" (checklist › Cost): the whole call, answer body included. */
export const RECEIPT_READ_TIMEOUT_MS = 45_000;
/** Most bytes of a successful answer read (4096 tokens of JSON are far below). */
const ANSWER_MAX_BYTES = 256 * 1024;
/** Most bytes of an error body read to classify it. */
const ERROR_BODY_MAX_BYTES = 4096;

export type ReceiptReadOutcome =
	| { kind: 'ok'; reading: ReceiptReading }
	/** The model said the photo is not a receipt. */
	| { kind: 'not_a_receipt' }
	/** The answer failed the schema, was cut off (max_tokens) or refused. */
	| { kind: 'unreadable' }
	/** FN-41's provider outcomes for a non-2xx answer (and `network` for a timeout or failed fetch). */
	| { kind: Exclude<AiKeyTestOutcome, 'ok'> }
	/** The gateway ids are unset: no call was made. */
	| { kind: 'not_configured' };

/** The text of the first text block of a Messages answer that ended normally, else null. */
export function answerText(body: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const { content, stop_reason: stop } = parsed as { content?: unknown; stop_reason?: unknown };
	// `max_tokens`: the JSON was cut off; `refusal`: the answer need not follow the schema.
	if (stop !== 'end_turn' || !Array.isArray(content)) return null;
	for (const block of content as unknown[]) {
		if (typeof block !== 'object' || block === null) continue;
		const { type, text } = block as { type?: unknown; text?: unknown };
		if (type === 'text' && typeof text === 'string') return text;
	}
	return null;
}

/** Reads one checked receipt photo (sanitised bytes and sniffed type) with `apiKey`. Never throws. */
export async function readReceiptImage(
	env: AiGatewayEnv | undefined,
	apiKey: string,
	image: { bytes: Uint8Array; type: PhotoType },
	fetchFn: typeof fetch = fetch,
	timeoutMs: number = RECEIPT_READ_TIMEOUT_MS
): Promise<ReceiptReadOutcome> {
	const base = anthropicGatewayUrl(env);
	if (!base) return { kind: 'not_configured' };
	const signal = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetchFn(`${base}/v1/messages`, {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': ANTHROPIC_VERSION,
				'content-type': 'application/json',
				// AI Gateway (developers.cloudflare.com/ai-gateway › Caching, › Logging): never answer from a cache, and
				// keep receipt contents out of the owner's gateway logs.
				'cf-aig-skip-cache': 'true',
				'cf-aig-collect-log': 'false'
			},
			body: JSON.stringify({
				model: RECEIPT_MODEL,
				max_tokens: RECEIPT_MAX_TOKENS,
				system: RECEIPT_SYSTEM_PROMPT,
				output_config: { format: { type: 'json_schema', schema: RECEIPT_OUTPUT_SCHEMA } },
				messages: [
					{
						role: 'user',
						content: [
							{
								type: 'image',
								source: { type: 'base64', media_type: image.type, data: base64Encode(image.bytes) }
							},
							{ type: 'text', text: RECEIPT_USER_PROMPT }
						]
					}
				]
			}),
			redirect: 'manual',
			signal
		});
		if (!response.ok) {
			const outcome = classifyAnthropicResponse(
				response.status,
				await cappedText(response, ERROR_BODY_MAX_BYTES)
			);
			return { kind: outcome === 'ok' ? 'network' : outcome };
		}
		const body = await cappedText(response, ANSWER_MAX_BYTES);
		// The deadline passed while the answer streamed in: a timeout, not an unreadable receipt.
		if (signal.aborted) return { kind: 'network' };
		const text = answerText(body);
		if (text === null) return { kind: 'unreadable' };
		const interpreted = interpretReceiptAnswer(text);
		if (interpreted.kind === 'invalid') return { kind: 'unreadable' };
		return interpreted;
	} catch {
		return { kind: 'network' };
	}
}
