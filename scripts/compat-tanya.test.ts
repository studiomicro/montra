import { describe, expect, it, vi } from 'vitest';
import { FigureBook } from '../src/lib/server/tanya/figures.ts';
import type { runTanya } from '../src/lib/server/tanya/loop.ts';
import { COMPAT_QUESTIONS, compatTanyaReport, fixtureTools } from './compat-tanya.ts';

// The owner-run real-provider check (criterion 31): here only with an injected loop, never the provider.

const CREDENTIALS = {
	apiKey: 'sk-ant-api03-synthetic-0001-AbCdEfGh',
	env: { AI_GATEWAY_ACCOUNT_ID: 'acct', AI_GATEWAY_ID: 'gw' }
};

describe('compat:tanya', () => {
	it('does nothing without local credentials', async () => {
		expect(await compatTanyaReport(null)).toBe(
			'tidak ada kunci Anthropic lokal — compat:tanya tidak dijalankan'
		);
	});

	it('prints outcome kinds, tools and the guard verdict, never the key or the answer text', async () => {
		const ask = vi.fn(async (input: Parameters<typeof runTanya>[0]) => {
			const r = await input.tools.run('spending_summary', { period: 'this_month' });
			const id = JSON.parse(r.content).total.figure_id as string;
			return {
				kind: 'answer' as const,
				text: `Rahasia [[f:${id}]].`,
				cards: [],
				inputTokens: 10,
				outputTokens: 5,
				toolCalls: 1
			};
		});
		const report = await compatTanyaReport(CREDENTIALS, ask as unknown as typeof runTanya);
		expect(ask).toHaveBeenCalledTimes(COMPAT_QUESTIONS.length);
		expect(report).toContain('1  answer  tools:spending_summary  guard:prose  tokens:10/5');
		expect(report).not.toContain(CREDENTIALS.apiKey);
		expect(report).not.toContain('Rahasia');
	});

	it('fixture tools refuse an unknown tool and return figures through the book', async () => {
		const book = new FigureBook('id');
		const tools = fixtureTools(book, []);
		expect((await tools.run('drop', {})).isError).toBe(true);
		const id = JSON.parse((await tools.run('wallet_balances', {})).content).total.figure_id;
		expect(book.get(id)).toBeDefined();
	});
});
