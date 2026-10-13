import { readFileSync } from 'node:fs';

/**
 * FN-15 receipt-reading test doubles. `test/fixtures/receipts/*.json` are synthetic, fictional model answers
 * (no real merchant, receipt or amount); the photos are hand-built in `images.ts`. Real receipt photos never go
 * in the repository (owner samples stay in the git-ignored `.superpowers/ref/samples/receipts/`).
 */
export type ReceiptFixture =
	'clean' | 'mismatch' | 'discount-heavy' | 'not-a-receipt' | 'invalid' | 'injection';

export const receiptAnswer = (name: ReceiptFixture): string =>
	readFileSync(new URL(`../fixtures/receipts/${name}.json`, import.meta.url), 'utf8');

/** A Messages API success answer carrying `text`, as the provider (through the gateway) would send it. */
export const messagesResponse = (text: string, stopReason = 'end_turn') =>
	new Response(
		JSON.stringify({
			id: 'msg_test',
			type: 'message',
			role: 'assistant',
			content: [{ type: 'text', text }],
			stop_reason: stopReason
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);

/** An Anthropic error answer (`{"type":"error","error":{"type":…}}`). */
export const errorResponse = (status: number, type: string) =>
	new Response(JSON.stringify({ type: 'error', error: { type, message: 'synthetic' } }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
