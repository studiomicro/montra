import { describe, expect, it, vi } from 'vitest';
import {
	ANTHROPIC_TEST_MODEL,
	anthropicGatewayUrl,
	classifyAnthropicResponse,
	isAiGatewayConfigured,
	testAnthropicKey
} from './anthropic';

// No test here reaches the network: every call goes to an injected fetch double.

const GW = {
	AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
	AI_GATEWAY_ID: 'montra-staging'
};
const KEY = 'sk-ant-api03-synthetic-test-key-AbCd';
const anthropicError = (type: string) =>
	JSON.stringify({ type: 'error', error: { type, message: 'x' } });

describe('anthropicGatewayUrl / isAiGatewayConfigured', () => {
	it('builds the gateway Anthropic route from both ids', () => {
		expect(anthropicGatewayUrl(GW)).toBe(
			'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/montra-staging/anthropic'
		);
		expect(isAiGatewayConfigured(GW)).toBe(true);
	});

	it('is not configured when either id is unset, blank or could change the URL', () => {
		for (const env of [
			undefined,
			{},
			{ ...GW, AI_GATEWAY_ID: '' },
			{ ...GW, AI_GATEWAY_ACCOUNT_ID: '   ' },
			{ ...GW, AI_GATEWAY_ID: '../evil' },
			{ ...GW, AI_GATEWAY_ID: 'a/b' },
			{ ...GW, AI_GATEWAY_ACCOUNT_ID: 'x?y=1' },
			{ ...GW, AI_GATEWAY_ID: 'evil.example.com' },
			{ ...GW, AI_GATEWAY_ID: 'a'.repeat(65) }
		])
			expect(isAiGatewayConfigured(env), JSON.stringify(env)).toBe(false);
	});
});

describe('classifyAnthropicResponse: four outcomes, never conflated', () => {
	it.each([
		[200, '{}', 'ok'],
		[401, anthropicError('authentication_error'), 'invalid'],
		[403, anthropicError('permission_error'), 'invalid'],
		[401, '', 'invalid'],
		[429, anthropicError('rate_limit_error'), 'quota'],
		[429, '', 'quota'],
		[402, anthropicError('billing_error'), 'quota'],
		[400, anthropicError('billing_error'), 'quota'],
		[500, anthropicError('api_error'), 'network'],
		[529, anthropicError('overloaded_error'), 'network'],
		[502, '<html>bad gateway</html>', 'network'],
		[404, anthropicError('not_found_error'), 'model_unavailable'],
		[404, '', 'model_unavailable'],
		[400, anthropicError('not_found_error'), 'model_unavailable'],
		[
			404,
			JSON.stringify({ success: false, errors: [{ code: 7001, message: 'Not found' }] }),
			'network'
		],
		[400, anthropicError('invalid_request_error'), 'network'],
		// A Cloudflare-shaped refusal is the gateway's, not a verdict on the user's key.
		[
			401,
			JSON.stringify({ success: false, errors: [{ code: 2009, message: 'Unauthorized' }] }),
			'network'
		]
	] as const)('%i %s → %s', (status, body, outcome) => {
		expect(classifyAnthropicResponse(status, body)).toBe(outcome);
	});
});

describe('testAnthropicKey', () => {
	it('makes one minimal Messages call through the gateway with the user’s own key', async () => {
		const fetchFn = vi.fn(async () => new Response('{"id":"msg"}', { status: 200 }));
		expect(await testAnthropicKey(GW, KEY, fetchFn as never)).toBe('ok');
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${anthropicGatewayUrl(GW)}/v1/messages`);
		expect(init.method).toBe('POST');
		const headers = init.headers as Record<string, string>;
		expect(headers['x-api-key']).toBe(KEY);
		expect(headers['anthropic-version']).toBe('2023-06-01');
		// AI Gateway: never answered from its cache (another user's key), never kept in its logs (red team L3).
		expect(headers['cf-aig-skip-cache']).toBe('true');
		expect(headers['cf-aig-collect-log']).toBe('false');
		expect(JSON.parse(init.body as string)).toEqual({
			model: ANTHROPIC_TEST_MODEL,
			max_tokens: 1,
			messages: [{ role: 'user', content: 'ping' }]
		});
		expect(init.signal).toBeInstanceOf(AbortSignal);
		// The key is in the header only, never in the URL or body.
		expect(url).not.toContain(KEY);
		expect(String(init.body)).not.toContain(KEY);
	});

	it('maps provider answers to their outcomes', async () => {
		const answer = (status: number, body: string) =>
			testAnthropicKey(GW, KEY, (async () => new Response(body, { status })) as never);
		expect(await answer(401, anthropicError('authentication_error'))).toBe('invalid');
		expect(await answer(429, anthropicError('rate_limit_error'))).toBe('quota');
		expect(await answer(503, 'down')).toBe('network');
		expect(await answer(404, anthropicError('not_found_error'))).toBe('model_unavailable');
	});

	it('is network on a failed fetch or a timeout', async () => {
		expect(
			await testAnthropicKey(GW, KEY, (async () => {
				throw new TypeError('fetch failed');
			}) as never)
		).toBe('network');
		const hanging = (_url: string, init: RequestInit) =>
			new Promise<Response>((_, reject) =>
				init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
			);
		expect(await testAnthropicKey(GW, KEY, hanging as never, 20)).toBe('network');
	});

	it('reads at most a few KiB of an error body', async () => {
		const huge = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
			}
		});
		expect(
			await testAnthropicKey(GW, KEY, (async () => new Response(huge, { status: 500 })) as never)
		).toBe('network');
	});

	it('calls nothing when the gateway is not configured', async () => {
		const fetchFn = vi.fn();
		expect(await testAnthropicKey({}, KEY, fetchFn as never)).toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
