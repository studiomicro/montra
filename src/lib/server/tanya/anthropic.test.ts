import { describe, expect, it, vi } from 'vitest';
import { bodyOf, errorAnswer, textAnswer, toolAnswer } from '../../../../test/helpers/tanya';
import { RECEIPT_MODEL } from '../receipts/anthropic';
import { askClaude, interpretAnswer, TANYA_MAX_TOKENS, TANYA_MODEL } from './anthropic';

// Criteria 16 and 17. Every call goes to an injected fetch double: nothing reaches the gateway or Anthropic.

const ENV = {
	AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
	AI_GATEWAY_ID: 'montra-test'
};
const KEY = 'sk-ant-api03-synthetic-0001-AbCdEfGh';
const REQUEST = {
	system: 'sys',
	messages: [{ role: 'user' as const, content: 'Halo' }],
	tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }]
};

describe('askClaude', () => {
	it('reuses the receipt model constant and sends the gateway headers, a timeout and manual redirects', async () => {
		expect(TANYA_MODEL).toBe(RECEIPT_MODEL);
		const fetchFn = vi.fn(async () => textAnswer('Halo'));
		const outcome = await askClaude(ENV, KEY, REQUEST, fetchFn as unknown as typeof fetch);
		expect(outcome).toMatchObject({
			kind: 'end_turn',
			usage: { inputTokens: 120, outputTokens: 30 }
		});
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(
			'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/montra-test/anthropic/v1/messages'
		);
		const headers = init.headers as Record<string, string>;
		expect(headers['x-api-key']).toBe(KEY);
		expect(headers['cf-aig-skip-cache']).toBe('true');
		expect(headers['cf-aig-collect-log']).toBe('false');
		expect(headers['anthropic-version']).toBe('2023-06-01');
		expect(init.redirect).toBe('manual');
		expect(init.signal).toBeInstanceOf(AbortSignal);
		const body = bodyOf(init);
		expect(body.model).toBe(RECEIPT_MODEL);
		expect(body.max_tokens).toBe(TANYA_MAX_TOKENS);
		expect(body.tools).toEqual(REQUEST.tools);
		expect(body.system).toBe('sys');
	});

	it('FN-23: a request without tools sends no tools field and its own output budget', async () => {
		const fetchFn = vi.fn(async () => textAnswer('Halo'));
		await askClaude(
			ENV,
			KEY,
			{ system: 'sys', messages: REQUEST.messages, maxTokens: 800 },
			fetchFn as unknown as typeof fetch
		);
		const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		const body = bodyOf(init);
		expect(body).not.toHaveProperty('tools');
		expect(body.max_tokens).toBe(800);
		expect(body.thinking).toEqual({ type: 'between_tools' });
	});

	it('makes no call without the gateway', async () => {
		const fetchFn = vi.fn();
		expect(await askClaude({}, KEY, REQUEST, fetchFn as unknown as typeof fetch)).toEqual({
			kind: 'not_configured'
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it.each([
		[401, 'authentication_error', 'invalid'],
		[429, 'rate_limit_error', 'quota'],
		[400, 'billing_error', 'quota'],
		[404, 'not_found_error', 'model_unavailable'],
		[529, 'overloaded_error', 'network'],
		[500, 'api_error', 'network']
	])('%i %s → %s, without the provider body', async (status, type, kind) => {
		const fetchFn = async () => errorAnswer(status, type);
		const outcome = await askClaude(ENV, KEY, REQUEST, fetchFn as unknown as typeof fetch);
		expect(outcome).toEqual({ kind });
		expect(JSON.stringify(outcome)).not.toContain('synthetic');
	});

	it('a failed fetch is network, a hung one ends at its deadline as timeout', async () => {
		const failing = async () => {
			throw new TypeError('fetch failed');
		};
		expect(await askClaude(ENV, KEY, REQUEST, failing as unknown as typeof fetch)).toEqual({
			kind: 'network'
		});
		const hung = (_: string, init: RequestInit) =>
			new Promise<Response>((_, reject) =>
				init.signal!.addEventListener('abort', () =>
					reject(new DOMException('aborted', 'AbortError'))
				)
			);
		const started = Date.now();
		expect(await askClaude(ENV, KEY, REQUEST, hung as unknown as typeof fetch, 50)).toEqual({
			kind: 'timeout'
		});
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it('the outcome never carries the key', async () => {
		for (const response of [textAnswer('x'), errorAnswer(401, 'authentication_error')]) {
			const outcome = await askClaude(
				ENV,
				KEY,
				REQUEST,
				(async () => response) as unknown as typeof fetch
			);
			expect(JSON.stringify(outcome)).not.toContain(KEY);
		}
	});
});

describe('interpretAnswer', () => {
	it('tool_use keeps the content verbatim', async () => {
		const outcome = interpretAnswer(
			await toolAnswer([['spending_summary', { period: 'this_month' }]]).text()
		);
		expect(outcome.kind).toBe('tool_use');
		if (outcome.kind === 'tool_use')
			expect(outcome.content[1]).toEqual({
				type: 'tool_use',
				id: 'toolu_1_0',
				name: 'spending_summary',
				input: { period: 'this_month' }
			});
	});

	it('max_tokens, refusal, malformed bodies and other stop reasons are distinct outcomes', async () => {
		expect(interpretAnswer(await textAnswer('x', 'max_tokens').text()).kind).toBe('max_tokens');
		expect(interpretAnswer(await textAnswer('x', 'refusal').text()).kind).toBe('refusal');
		expect(interpretAnswer(await textAnswer('x', 'pause_turn').text()).kind).toBe('malformed');
		expect(interpretAnswer('not json').kind).toBe('malformed');
		expect(interpretAnswer('{"content":"x","stop_reason":"end_turn"}').kind).toBe('malformed');
		expect(interpretAnswer('{"content":[],"stop_reason":"end_turn"}').kind).toBe('malformed');
	});
});
