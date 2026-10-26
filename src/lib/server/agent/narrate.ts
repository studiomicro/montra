import { AGENT_NARRATIVE_MAX, type AgentNarrativeReason } from '../../shared/agent.ts';
import type { Locale } from '../../shared/i18n.ts';
import { RetryLaterError } from '../../shared/jobs.ts';
import type { AiGatewayEnv } from '../ai-keys/anthropic.ts';
import { guardAnswer } from '../tanya/answer-guard.ts';
import { askClaude, type ContentBlock } from '../tanya/anthropic.ts';
import { dataText } from '../tanya/data-text.ts';
import { FigureBook, forModel } from '../tanya/figures.ts';
import type { AgentFacts } from './facts.ts';
import { AGENT_NARRATIVE_PROMPT } from './prompt.ts';

/**
 * The provider step of an Agen narrative (FN-23): one call with an already opened key through the AI Gateway, no
 * tools and no loop. The model receives the facts as data, every figure only as `{ figure_id, label, value }`
 * from a FigureBook built here from the stored facts (the same numbers and the same formatter the files use),
 * and its text is kept only when Tanya's `guardAnswer` returns prose. Neither the key nor a provider body leaves
 * this module. Node-safe imports, so the owner-run `npm run compat:agent` uses this very code.
 */

/** Output budget of the one call (owner decision 9). */
const AGENT_NARRATIVE_MAX_TOKENS = 800;
/** The call's deadline (owner decision 9). */
const AGENT_NARRATIVE_TIMEOUT_MS = 30_000;
/** Deliveries of the narrate step before a network failure or timeout is skipped instead of retried. */
const AGENT_NARRATE_MAX_ATTEMPTS = 3;
/** Seconds before a transient failure is retried. */
const AGENT_NARRATE_RETRY_S = 60;
/** Longest category or merchant name the model sees. */
const MODEL_NAME_MAX = 40;

export type NarrativeOutcome =
	| { state: 'ai'; text: string; inputTokens: number; outputTokens: number }
	| {
			state: 'none' | 'skipped';
			reason: AgentNarrativeReason;
			inputTokens: number | null;
			outputTokens: number | null;
	  };

/**
 * A link or a credential lure in a narrative (red team S1, cycle 2 N3), tested on a folded copy (NFKC, marks
 * stripped, lower case): a scheme, `www.`, a dotted domain-like token (also with a space before the dot or the dot in
 * brackets), `titik com` / `dot com`, or the words login, password, passcode, PIN, OTP, (kata) sandi, or "masuk ke
 * akun/aplikasi". Merchant and category titles are model input an outsider can shape, so a narrative that points
 * somewhere or asks for a credential is skipped (`guard`), never stored.
 */
const TLD = '(?:com|net|org|id|co|io|app|xyz|info|biz|me|site|online|link)';
const LURE = new RegExp(
	[
		':\\/\\/',
		'\\bwww\\.',
		'\\b[a-z0-9-]+\\.[a-z]{2,}\\b',
		`[a-z0-9-]\\s+\\.\\s*${TLD}\\b`,
		'[(\\[{]\\s*\\.\\s*[)\\]}]',
		`\\b(?:titik|dot)\\s+${TLD}\\b`,
		'\\b(?:log ?in|password|passcode|pin|otp)\\b',
		'\\b(?:kata[\\s-]?)?sandi\\b',
		'\\bmasuk ke (?:akun|aplikasi)'
	].join('|')
);

export function narrativeHasLure(text: string): boolean {
	const folded = text.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
	return LURE.test(folded);
}

export const none = (reason: AgentNarrativeReason): NarrativeOutcome => ({
	state: 'none',
	reason,
	inputTokens: null,
	outputTokens: null
});
const skipped = (
	reason: AgentNarrativeReason,
	usage?: { inputTokens: number; outputTokens: number }
): NarrativeOutcome => ({
	state: 'skipped',
	reason,
	inputTokens: usage?.inputTokens ?? null,
	outputTokens: usage?.outputTokens ?? null
});

/** The facts as the model receives them: figure ids and formatted text, cleaned names, never minor units. */
function narrativeInput(facts: AgentFacts, locale: Locale, book: FigureBook) {
	const name = (n: string | null) => (n === null ? null : dataText(n, MODEL_NAME_MAX));
	const currencies = (facts.summary?.currencies ?? []).map((s) => {
		const c = s.currency;
		const group = facts.group?.currencies.find((g) => g.currency === c);
		return {
			currency: c,
			income: forModel(book.money(`income ${c}`, s.inMinor, c)),
			expense: forModel(book.money(`expense ${c}`, s.outMinor, c)),
			net: forModel(book.money(`net ${c}`, s.netMinor, c)),
			...(s.previousOutMinor !== undefined
				? {
						previous_month_expense: forModel(
							book.money(`previous month expense ${c}`, s.previousOutMinor, c)
						),
						expense_change_percent: forModel(
							book.percent(`expense change ${c}`, s.changePercent ?? null)
						)
					}
				: {}),
			...(s.months
				? {
						months: s.months.map((m) => ({
							month: m.month,
							expense: forModel(book.money(`expense ${m.month} ${c}`, m.outMinor, c)),
							income: forModel(book.money(`income ${m.month} ${c}`, m.inMinor, c))
						})),
						highest_expense_month: s.highestMonth ?? null,
						lowest_expense_month: s.lowestMonth ?? null
					}
				: {}),
			categories: (group?.categories ?? []).map((g) => ({
				name: name(g.name),
				expense: forModel(book.money(`category ${c}`, g.outMinor, c))
			})),
			other_categories:
				group && group.otherCount > 0
					? forModel(book.money(`other categories ${c}`, group.otherMinor, c))
					: null,
			merchants: (group?.merchants ?? []).map((m) => ({
				name: name(m.title),
				transactions: forModel(book.count(`merchant transactions`, m.count)),
				expense: forModel(book.money(`merchant ${c}`, m.amountMinor, c))
			}))
		};
	});
	return {
		language: locale,
		report: facts.type === 'monthly' ? 'monthly' : 'annual',
		period: facts.period,
		from: facts.from,
		to: facts.to,
		period_not_finished: facts.partial,
		transactions: forModel(book.count('transactions', facts.read?.count ?? 0)),
		categories_with_expense: forModel(book.count('categories', facts.group?.categoryCount ?? 0)),
		currencies
	};
}

/**
 * The provider step alone, with an already opened key (also the owner-run `npm run compat:agent`): one call, no
 * tools, the answer through `guardAnswer`. Same retry rule as `writeNarrative`.
 */
export async function narrateWithKey(
	env: AiGatewayEnv | undefined,
	apiKey: string,
	facts: AgentFacts,
	locale: Locale,
	attempts: number,
	fetchFn?: typeof fetch
): Promise<NarrativeOutcome> {
	const book = new FigureBook(locale);
	const input = narrativeInput(facts, locale, book);
	const outcome = await askClaude(
		env,
		apiKey,
		{
			system: AGENT_NARRATIVE_PROMPT,
			messages: [{ role: 'user', content: JSON.stringify(input) }],
			maxTokens: AGENT_NARRATIVE_MAX_TOKENS
		},
		fetchFn,
		AGENT_NARRATIVE_TIMEOUT_MS
	);
	switch (outcome.kind) {
		case 'end_turn': {
			const text = textOf(outcome.content);
			const guarded = guardAnswer(text, book);
			if (
				guarded.kind !== 'prose' ||
				Array.from(guarded.text).length > AGENT_NARRATIVE_MAX ||
				narrativeHasLure(guarded.text)
			)
				return skipped('guard', outcome.usage);
			return { state: 'ai', text: guarded.text, ...outcome.usage };
		}
		case 'tool_use':
			// No tool was offered: an answer asking for one is not a narrative.
			return skipped('malformed', outcome.usage);
		case 'max_tokens':
		case 'refusal':
			return skipped(outcome.kind, outcome.usage);
		case 'not_configured':
			return none('ai_unconfigured');
		case 'network':
		case 'timeout':
			if (attempts < AGENT_NARRATE_MAX_ATTEMPTS)
				throw new RetryLaterError('agent narrative: provider unavailable', AGENT_NARRATE_RETRY_S);
			return skipped(outcome.kind);
		default:
			// invalid key, quota, model unavailable, malformed: retrying will not help.
			return skipped(outcome.kind);
	}
}

function textOf(content: readonly ContentBlock[]): string {
	return content
		.filter((b) => b.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text as string)
		.join('\n');
}
