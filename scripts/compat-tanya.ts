import { existsSync, readFileSync } from 'node:fs';
import { guardAnswer } from '../src/lib/server/tanya/answer-guard.ts';
import { FigureBook } from '../src/lib/server/tanya/figures.ts';
import { runTanya, type LoopOutcome } from '../src/lib/server/tanya/loop.ts';
import { TOOL_DEFINITIONS } from '../src/lib/server/tanya/definitions.ts';
import type { ToolSet } from '../src/lib/server/tanya/tools.ts';
import { credentialsFrom, parseDevVars, type ReceiptCredentials } from './compat-receipts.ts';
import { assertLocalOnly } from './local-guard.ts';

/**
 * `npm run compat:tanya` (FN-22): the real-provider check the owner runs by hand. It asks a few fixed questions
 * through the same `runTanya` loop and `guardAnswer` the /tanya action uses, with the owner's own key and gateway
 * from the local `.dev.vars` (`COMPAT_TANYA_ANTHROPIC_KEY`, else `COMPAT_RECEIPTS_ANTHROPIC_KEY`;
 * `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`), never from a command-line argument. The tools answer from fixed,
 * fictional figures (no database), so the check proves the provider path: headers, the tool-use loop, the
 * figure placeholders and the guard. It prints outcome kinds, tool names and whether the prose passed the guard
 * — never the key or the answer text. Without credentials it prints why and does nothing. Never part of
 * `npm run gates` or CI; always exits 0 (a report, not a gate).
 */

export const COMPAT_QUESTIONS: readonly string[] = [
	'Bulan ini habis berapa?',
	'Berapa saldo semua dompetku?',
	'Sebaiknya aku beli saham sekarang?'
];

/** Fixed, fictional tool results: every tool exists, every figure goes through the question's FigureBook. */
export function fixtureTools(book: FigureBook, called: string[]): ToolSet {
	return {
		definitions: TOOL_DEFINITIONS,
		async run(name) {
			called.push(name);
			const known = TOOL_DEFINITIONS.some((t) => t.name === name);
			if (!known)
				return { isError: true, content: JSON.stringify({ error: 'unknown tool' }), card: null };
			const f = book.money(`${name} total`, 1_250_000, 'IDR');
			return {
				isError: false,
				content: JSON.stringify({
					note: 'fictional compat figures',
					total: f ? { figure_id: f.id, label: f.label, value: f.formatted } : null
				}),
				card: null
			};
		}
	};
}

function line(index: number, outcome: LoopOutcome, called: string[], book: FigureBook): string {
	if (outcome.kind !== 'answer') return `${index}  ${outcome.kind}`;
	const guarded = guardAnswer(outcome.text, book);
	return `${index}  answer  tools:${called.join(',') || '-'}  guard:${guarded.kind}  tokens:${outcome.inputTokens}/${outcome.outputTokens}`;
}

/** The whole report. `ask` is injected by tests (no test reaches the provider). */
export async function compatTanyaReport(
	credentials: ReceiptCredentials | null,
	ask: typeof runTanya = runTanya
): Promise<string> {
	if (!credentials) return 'tidak ada kunci Anthropic lokal — compat:tanya tidak dijalankan';
	const out = [`Tanya: ${COMPAT_QUESTIONS.length} questions against the real provider.`];
	let index = 0;
	for (const question of COMPAT_QUESTIONS) {
		const book = new FigureBook('id');
		const called: string[] = [];
		const outcome = await ask({
			env: credentials.env,
			apiKey: credentials.apiKey,
			question,
			history: [],
			tools: fixtureTools(book, called)
		});
		out.push(line(++index, outcome, called, book));
	}
	return out.join('\n');
}

if (import.meta.main) {
	assertLocalOnly(process.argv.slice(2));
	try {
		const vars = existsSync('.dev.vars') ? parseDevVars(readFileSync('.dev.vars', 'utf8')) : {};
		const key = vars.COMPAT_TANYA_ANTHROPIC_KEY ?? vars.COMPAT_RECEIPTS_ANTHROPIC_KEY;
		console.log(
			await compatTanyaReport(
				credentialsFrom(key ? { ...vars, COMPAT_RECEIPTS_ANTHROPIC_KEY: key } : vars)
			)
		);
	} catch (e) {
		// A report, never a gate: an unexpected failure is one fixed line (no content), still exit 0.
		console.log(`compat:tanya stopped: ${e instanceof Error ? e.name : 'error'}`);
	}
	process.exit(0);
}
