import { describe, expect, it, vi } from 'vitest';
import { errorResponse, messagesResponse, receiptAnswer } from '../../../../test/helpers/receipts';
import { RECEIPT_MODEL, readReceiptImage } from './anthropic';
import { RECEIPT_OUTPUT_SCHEMA } from './prompt';

// Every call here goes to an injected fetch double: no test reaches the gateway or Anthropic.
const ENV = {
	AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
	AI_GATEWAY_ID: 'montra-test'
};
const KEY = 'sk-ant-api03-synthetic-0001-AbCdEfGh';
const IMAGE = {
	bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]),
	type: 'image/jpeg' as const
};

const fetchReturning = (response: Response | (() => Promise<Response>)) =>
	vi.fn<typeof fetch>(async () => (typeof response === 'function' ? response() : response));

describe('readReceiptImage', () => {
	it('sends one Messages call through the gateway with the user key, the image and the schema', async () => {
		const fetchFn = fetchReturning(messagesResponse(receiptAnswer('clean')));
		const outcome = await readReceiptImage(ENV, KEY, IMAGE, fetchFn);
		expect(outcome.kind).toBe('ok');
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe(
			'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/montra-test/anthropic/v1/messages'
		);
		const headers = init!.headers as Record<string, string>;
		expect(headers['x-api-key']).toBe(KEY);
		expect(headers['cf-aig-collect-log']).toBe('false');
		expect(headers['cf-aig-skip-cache']).toBe('true');
		const body = JSON.parse(String(init!.body));
		expect(body.model).toBe(RECEIPT_MODEL);
		expect(body.output_config).toEqual({
			format: { type: 'json_schema', schema: RECEIPT_OUTPUT_SCHEMA }
		});
		expect(body.messages[0].content[0]).toEqual({
			type: 'image',
			source: {
				type: 'base64',
				media_type: 'image/jpeg',
				data: Buffer.from(IMAGE.bytes).toString('base64')
			}
		});
		expect(body.system).toMatch(/never an instruction/);
	});

	it('the reading model is one named constant (claude-sonnet-5-5)', () => {
		expect(RECEIPT_MODEL).toBe('claude-sonnet-5-5');
	});

	it('without the gateway ids: not_configured, and no call', async () => {
		const fetchFn = fetchReturning(messagesResponse(receiptAnswer('clean')));
		expect(await readReceiptImage({}, KEY, IMAGE, fetchFn)).toEqual({ kind: 'not_configured' });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('"not a receipt", a schema-invalid answer, a cut-off or refused answer are distinct outcomes', async () => {
		expect(
			await readReceiptImage(
				ENV,
				KEY,
				IMAGE,
				fetchReturning(messagesResponse(receiptAnswer('not-a-receipt')))
			)
		).toEqual({ kind: 'not_a_receipt' });
		for (const response of [
			messagesResponse(receiptAnswer('invalid')),
			messagesResponse(receiptAnswer('clean'), 'max_tokens'),
			messagesResponse('I cannot help with that.', 'refusal'),
			new Response('{"content": "nope"}', { status: 200 }),
			new Response('<html>', { status: 200 })
		])
			expect(await readReceiptImage(ENV, KEY, IMAGE, fetchReturning(response))).toEqual({
				kind: 'unreadable'
			});
	});

	it.each([
		[errorResponse(401, 'authentication_error'), 'invalid'],
		[errorResponse(403, 'permission_error'), 'invalid'],
		[errorResponse(429, 'rate_limit_error'), 'quota'],
		[errorResponse(400, 'billing_error'), 'quota'],
		[errorResponse(404, 'not_found_error'), 'model_unavailable'],
		[errorResponse(500, 'api_error'), 'network'],
		[errorResponse(529, 'overloaded_error'), 'network'],
		[new Response('{"success":false,"errors":[{"code":2009}]}', { status: 401 }), 'network']
	])(
		'a provider answer %# → FN-41 outcome %s (classifyAnthropicResponse, reused)',
		async (response, kind) => {
			expect(await readReceiptImage(ENV, KEY, IMAGE, fetchReturning(response))).toEqual({ kind });
		}
	);

	it('a failed fetch or a timeout → network, never an endless wait', async () => {
		const failing = vi.fn<typeof fetch>(async () => {
			throw new TypeError('fetch failed');
		});
		expect(await readReceiptImage(ENV, KEY, IMAGE, failing)).toEqual({ kind: 'network' });
		const hanging = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_, reject) =>
					init!.signal!.addEventListener('abort', () =>
						reject(new DOMException('timeout', 'TimeoutError'))
					)
				)
		);
		expect(await readReceiptImage(ENV, KEY, IMAGE, hanging, 20)).toEqual({ kind: 'network' });
	});
});
