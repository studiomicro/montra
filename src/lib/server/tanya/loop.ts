import type { TanyaCard } from '../../shared/tanya.ts';
import type { AiGatewayEnv } from '../ai-keys/anthropic.ts';
import {
	askClaude,
	TANYA_CALL_TIMEOUT_MS,
	type AskOutcome,
	type ChatMessage,
	type ContentBlock
} from './anthropic.ts';
import { TANYA_SYSTEM_PROMPT } from './prompt.ts';
import type { ToolSet } from './tools.ts';

/**
 * The tool-use loop of one question (FN-22), as Anthropic's stop-reason guide describes it: while the answer stops
 * with `tool_use`, the assistant content is appended verbatim, every `tool_use` block is run, and one user message
 * holding only the `tool_result` blocks (one per `tool_use`, same order) continues the conversation with the same
 * `tools`. At most TANYA_MAX_TOOL_ROUNDS rounds of tools, then the question ends unanswered; the whole question
 * has its own deadline. Tools only read (tools.ts); nothing here writes, so no D1 transaction spans a provider call.
 */

/** Rounds of tool calls per question (owner decision 5); one more call may then answer. */
export const TANYA_MAX_TOOL_ROUNDS = 4;
/** Most tool calls one round runs (a model asking for more gets an error result for the rest). */
const MAX_CALLS_PER_ROUND = 8;
/** The whole question's deadline (owner decision 5). */
const TANYA_TOTAL_TIMEOUT_MS = 55_000;

export type LoopFailure =
	| Exclude<AskOutcome['kind'], 'end_turn' | 'tool_use'>
	/** The model still wanted tools after TANYA_MAX_TOOL_ROUNDS. */
	| 'too_many_rounds';

export type LoopOutcome =
	| {
			kind: 'answer';
			text: string;
			cards: TanyaCard[];
			inputTokens: number;
			outputTokens: number;
			toolCalls: number;
	  }
	| { kind: LoopFailure };

export interface LoopInput {
	env: AiGatewayEnv | undefined;
	apiKey: string;
	question: string;
	/** Earlier questions and checked answers, oldest first, alternating user/assistant (never a figure card). */
	history: readonly ChatMessage[];
	tools: ToolSet;
	fetchFn?: typeof fetch;
	/** Injected by tests; Date.now otherwise. */
	clock?: () => number;
	totalTimeoutMs?: number;
}

const textOf = (content: readonly ContentBlock[]) =>
	content
		.filter((b) => b.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text as string)
		.join('\n');

export async function runTanya(input: LoopInput): Promise<LoopOutcome> {
	const clock = input.clock ?? Date.now;
	const deadline = clock() + (input.totalTimeoutMs ?? TANYA_TOTAL_TIMEOUT_MS);
	const messages: ChatMessage[] = [...input.history, { role: 'user', content: input.question }];
	const cards: TanyaCard[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let toolCalls = 0;
	for (let round = 0; ; round++) {
		const left = deadline - clock();
		if (left <= 0) return { kind: 'timeout' };
		const outcome = await askClaude(
			input.env,
			input.apiKey,
			{ system: TANYA_SYSTEM_PROMPT, messages, tools: input.tools.definitions },
			input.fetchFn,
			Math.min(TANYA_CALL_TIMEOUT_MS, left)
		);
		if ('usage' in outcome) {
			inputTokens += outcome.usage.inputTokens;
			outputTokens += outcome.usage.outputTokens;
		}
		if (outcome.kind === 'end_turn')
			return {
				kind: 'answer',
				text: textOf(outcome.content),
				cards,
				inputTokens,
				outputTokens,
				toolCalls
			};
		if (outcome.kind !== 'tool_use') return { kind: outcome.kind };
		if (round >= TANYA_MAX_TOOL_ROUNDS) return { kind: 'too_many_rounds' };
		const uses = outcome.content.filter((b) => b.type === 'tool_use');
		if (uses.length === 0) return { kind: 'malformed' };
		messages.push({ role: 'assistant', content: outcome.content });
		const results: ContentBlock[] = [];
		for (const [i, use] of uses.entries()) {
			const id = typeof use.id === 'string' ? use.id : '';
			const name = typeof use.name === 'string' ? use.name : '';
			const ran =
				i < MAX_CALLS_PER_ROUND
					? await input.tools.run(name, use.input)
					: { isError: true, content: JSON.stringify({ error: 'too many calls' }), card: null };
			toolCalls++;
			if (ran.card && !ran.isError && cards.length < 8) cards.push(ran.card);
			results.push({
				type: 'tool_result',
				tool_use_id: id,
				content: ran.content,
				...(ran.isError ? { is_error: true } : {})
			});
		}
		messages.push({ role: 'user', content: results });
	}
}
