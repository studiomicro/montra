import { describe, expect, it, vi } from 'vitest';
import { generateRows, unlabeledXlsx } from '../../../../test/fixtures/spreadsheets';
import { messagesResponse } from '../../../../test/helpers/receipts';
import { SAMPLE_CELL_MAX } from '#lib/shared/spreadsheet/layout';
import {
	interpretMappingAnswer,
	mappingPrompt,
	SHEET_MAPPING_TIMEOUT_MS,
	suggestTabMapping
} from './ai-mapping';
import { suggestionInput } from './import';

const ENV = { AI_GATEWAY_ACCOUNT_ID: 'acc0123', AI_GATEWAY_ID: 'gw-test' };
const answer = (columns: { index: number; role: string }[], kind = 'both', header_row = 0) =>
	JSON.stringify({ header_row, kind, columns });

describe('suggestTabMapping (stubbed provider)', () => {
	it('sends the header and at most 5 sample rows of a 3,000-row tab, capped cells, through the gateway', async () => {
		const rows = generateRows(3000);
		const long = rows.map((r, i) => (i === 0 ? { ...r, title: 'x'.repeat(500) } : r));
		const input = await suggestionInput(unlabeledXlsx(long), 0, null);
		if (!input.ok) throw new Error(input.error);
		const fetchFn = vi.fn(async () =>
			messagesResponse(
				answer([
					{ index: 0, role: 'date' },
					{ index: 2, role: 'amount' }
				])
			)
		);
		const outcome = await suggestTabMapping(
			ENV,
			'sk-ant-synthetic',
			{ tabName: input.tabName, header: input.header, samples: input.samples },
			input.columns,
			fetchFn as unknown as typeof fetch
		);
		expect(outcome).toEqual({
			kind: 'ok',
			suggestion: { headerRow: 0, columns: ['date', 'ignore', 'amount'], kind: 'auto' }
		});
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://gateway.ai.cloudflare.com/v1/acc0123/gw-test/anthropic/v1/messages');
		const headers = init.headers as Record<string, string>;
		expect(headers['cf-aig-skip-cache']).toBe('true');
		expect(headers['cf-aig-collect-log']).toBe('false');
		expect(init.signal).toBeInstanceOf(AbortSignal);
		const body = JSON.parse(String(init.body)) as { messages: { content: { text: string }[] }[] };
		const sent = JSON.parse(body.messages[0]!.content[0]!.text) as {
			tab: string;
			rows: string[][];
		};
		expect(sent.rows).toHaveLength(1 + 5);
		expect(sent.rows[0]).toEqual(['Kapan', 'Apa', 'Berapa']);
		expect(sent.rows.flat().every((c) => c.length <= SAMPLE_CELL_MAX)).toBe(true);
		// None of the rows past the fifth sample leaves the server.
		const text = String(init.body);
		for (const r of rows.slice(5)) expect(text).not.toContain(r.title + '"');
		expect(SHEET_MAPPING_TIMEOUT_MS).toBe(30_000);
	});

	it('not configured: no call; a provider error or a timeout is an outcome, never a throw', async () => {
		const fetchFn = vi.fn();
		expect(
			await suggestTabMapping(
				{},
				'k',
				{ tabName: 'A', header: [], samples: [] },
				1,
				fetchFn as never
			)
		).toEqual({ kind: 'not_configured' });
		expect(fetchFn).not.toHaveBeenCalled();
		const failing = vi.fn(async () => {
			throw new Error('timeout');
		});
		expect(
			await suggestTabMapping(
				ENV,
				'k',
				{ tabName: 'A', header: [], samples: [] },
				1,
				failing as never
			)
		).toEqual({ kind: 'network' });
	});
});

describe('mappingPrompt masks account and card numbers (L3)', () => {
	it('long digit runs in header, sample cells and tab name leave as last 4 digits; dates and amounts stay', () => {
		const prompt = mappingPrompt({
			tabName: 'Rek 1234567890123',
			header: ['Tanggal', 'No. kartu 4111 1111 1111 1111', 'Jumlah'],
			samples: [
				['2026-10-08', 'Transfer ke 1234-5678-9012', '1.250.000'],
				['08/10/2026', 'Kopi', '28000']
			]
		});
		expect(prompt).not.toMatch(/1234567890123|4111 1111|1234-5678|5678-9012/);
		const sent = JSON.parse(prompt) as { tab: string; rows: string[][] };
		expect(sent.tab).toContain('0123');
		expect(sent.rows[0]![1]).toContain('\u2022\u2022\u2022\u20221111');
		expect(sent.rows[1]).toEqual(['2026-10-08', expect.stringContaining('9012'), '1.250.000']);
		expect(sent.rows[2]).toEqual(['08/10/2026', 'Kopi', '28000']);
	});
});

describe('interpretMappingAnswer', () => {
	it('accepts a fitting answer; "both" means automatic', () => {
		expect(
			interpretMappingAnswer(
				answer(
					[
						{ index: 0, role: 'date' },
						{ index: 1, role: 'expense' }
					],
					'expense'
				),
				2
			)
		).toEqual({ headerRow: 0, columns: ['date', 'expense'], kind: 'expense' });
	});
	it.each([
		['not json', 'bukan json'],
		['wrong types', JSON.stringify({ header_row: '0', kind: 'both', columns: [] })],
		[
			'unknown role',
			answer([
				{ index: 0, role: 'date' },
				{ index: 1, role: 'saldo' }
			])
		],
		[
			'outside the grid',
			answer([
				{ index: 0, role: 'date' },
				{ index: 5, role: 'amount' }
			])
		],
		[
			'role twice',
			answer([
				{ index: 0, role: 'date' },
				{ index: 1, role: 'date' },
				{ index: 2, role: 'amount' }
			])
		],
		[
			'amount and in/out',
			answer([
				{ index: 0, role: 'date' },
				{ index: 1, role: 'amount' },
				{ index: 2, role: 'income' }
			])
		],
		['no date', answer([{ index: 1, role: 'amount' }])],
		['extra field', JSON.stringify({ header_row: 0, kind: 'both', columns: [], values: [1] })],
		[
			'header row out of range',
			answer(
				[
					{ index: 0, role: 'date' },
					{ index: 1, role: 'amount' }
				],
				'both',
				9
			)
		]
	])('%s → null', (_, text) => expect(interpretMappingAnswer(text, 3)).toBeNull());
});
