import { describe, expect, it, vi } from 'vitest';
import {
	classifyMerchants,
	interpretMerchantAnswer,
	MERCHANT_AI_BATCH_MAX,
	MERCHANT_MODEL
} from './ai';

/**
 * FN-20 AI step with an injected fetch double: no test reaches the gateway or Anthropic. These prove the
 * request shape, privacy and validation only; they never count as a working AI path (PRD AC-25).
 */
const ENV = { AI_GATEWAY_ACCOUNT_ID: 'acct', AI_GATEWAY_ID: 'gw' };
const CATS = [
	{ id: 'cat-kopi', name: 'Kopi' },
	{ id: 'cat-makan', name: 'Makan & Minum' }
];

const messageAnswer = (text: string, stop = 'end_turn') =>
	new Response(
		JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stop, usage: {} }),
		{ status: 200 }
	);
const resultsText = (results: unknown[]) => JSON.stringify({ results });

describe('classifyMerchants', () => {
	it('sends the cleaned keys, the kind and category names under refs, through the gateway', async () => {
		const fetchFn = vi.fn(async () =>
			messageAnswer(
				resultsText([
					{ key: 'kopi senja', category: 'c1', merchant_name: 'Kopi Senja' },
					{ key: 'warung bu ani', category: 'c2', merchant_name: null }
				])
			)
		);
		const r = await classifyMerchants(
			ENV,
			'sk-test',
			'expense',
			['kopi senja', 'warung bu ani'],
			CATS,
			fetchFn
		);
		expect(r).toEqual({
			kind: 'ok',
			answers: new Map([
				['kopi senja', { categoryId: 'cat-kopi', merchantName: 'Kopi Senja' }],
				['warung bu ani', { categoryId: 'cat-makan', merchantName: null }]
			])
		});
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages');
		const headers = init.headers as Record<string, string>;
		expect(headers['x-api-key']).toBe('sk-test');
		expect(headers['cf-aig-skip-cache']).toBe('true');
		expect(headers['cf-aig-collect-log']).toBe('false');
		const body = JSON.parse(String(init.body)) as {
			model: string;
			messages: { content: string }[];
		};
		expect(body.model).toBe(MERCHANT_MODEL);
		const prompt = JSON.parse(body.messages[0]!.content) as Record<string, unknown>;
		expect(prompt).toEqual({
			kind: 'expense',
			categories: [
				{ ref: 'c1', name: 'Kopi' },
				{ ref: 'c2', name: 'Makan & Minum' }
			],
			descriptors: ['kopi senja', 'warung bu ani']
		});
		// Category ids never leave the server.
		expect(String(init.body)).not.toContain('cat-kopi');
	});

	it('at most MERCHANT_AI_BATCH_MAX keys in one request', async () => {
		const fetchFn = vi.fn(async () => messageAnswer(resultsText([])));
		const keys = Array.from(
			{ length: 50 },
			(_, i) => `toko ${String.fromCharCode(97 + (i % 26))}${i}`
		);
		await classifyMerchants(ENV, 'k', 'expense', keys, CATS, fetchFn);
		const body = JSON.parse(
			String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body)
		) as { messages: { content: string }[] };
		expect(
			(JSON.parse(body.messages[0]!.content) as { descriptors: string[] }).descriptors
		).toHaveLength(MERCHANT_AI_BATCH_MAX);
	});

	it('no gateway: no call', async () => {
		const fetchFn = vi.fn();
		expect(await classifyMerchants({}, 'k', 'expense', ['a'], CATS, fetchFn)).toEqual({
			kind: 'not_configured'
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('HTTP 4xx/5xx, a thrown fetch and a timeout are failures (AC-10)', async () => {
		for (const status of [400, 401, 429, 500, 529]) {
			const r = await classifyMerchants(
				ENV,
				'k',
				'expense',
				['a'],
				CATS,
				async () => new Response('{"type":"error"}', { status })
			);
			expect(r).toEqual({ kind: 'failed' });
		}
		expect(
			await classifyMerchants(ENV, 'k', 'expense', ['a'], CATS, async () => {
				throw new TypeError('network');
			})
		).toEqual({ kind: 'failed' });
		const hanging = (_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
			);
		expect(
			await classifyMerchants(ENV, 'k', 'expense', ['a'], CATS, hanging as typeof fetch, 5)
		).toEqual({ kind: 'failed' });
	});

	it('invalid JSON, wrong types, extra fields, cut-off or refused answers are unreadable (AC-10)', async () => {
		const answers = [
			messageAnswer('not json'),
			messageAnswer(resultsText([{ key: 'a', category: 5, merchant_name: null }])),
			messageAnswer(resultsText([{ key: 'a', category: 'c1', merchant_name: null, amount: 9 }])),
			messageAnswer(JSON.stringify({ results: [], extra: true })),
			messageAnswer(resultsText([]), 'max_tokens'),
			messageAnswer(resultsText([]), 'refusal')
		];
		for (const a of answers)
			expect(await classifyMerchants(ENV, 'k', 'expense', ['a'], CATS, async () => a)).toEqual({
				kind: 'unreadable'
			});
	});
});

describe('interpretMerchantAnswer', () => {
	const refs = new Map([['c1', 'cat-kopi']]);
	it('an unknown ref becomes no category; keys not asked for are ignored', () => {
		const r = interpretMerchantAnswer(
			resultsText([
				{ key: 'a', category: 'c99', merchant_name: null },
				{ key: 'zzz', category: 'c1', merchant_name: null }
			]),
			['a'],
			refs
		);
		expect(r).toEqual(new Map([['a', { categoryId: null, merchantName: null }]]));
	});
	it('a model-returned name is cleaned like any descriptor (no HTML, no control characters, no ids)', () => {
		const r = interpretMerchantAnswer(
			resultsText([
				{ key: 'a', category: 'c1', merchant_name: '<b>Kopi</b>\u0000​ Senja 08123456789' }
			]),
			['a'],
			refs
		);
		expect(r?.get('a')).toEqual({ categoryId: 'cat-kopi', merchantName: 'B Kopi B Senja' });
	});
});
