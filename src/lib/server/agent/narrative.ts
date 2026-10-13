import type { Locale } from '#lib/shared/i18n';
import { isAiGatewayConfigured, type AiGatewayEnv } from '../ai-keys/anthropic';
import type { AiKeysEnv } from '../ai-keys/crypto';
import { resolveAnthropicKey } from '../ai-keys/lookup';
import type { Db } from '../db';
import type { AgentFacts } from './facts';
import { narrateWithKey, none, type NarrativeOutcome } from './narrate';

/**
 * The optional narrative of a monthly or annual report (FN-23): the run owner's own key (BYOK, `user_id` of the
 * run row, never an id from the message) is opened here and handed to the one provider call (narrate.ts). No
 * gateway or no key: no call, the report completes without a narrative.
 */

export interface NarrativeDeps {
	db: Db;
	env: (AiGatewayEnv & AiKeysEnv) | undefined;
	/** The run row's owner: the only key ever opened. */
	userId: string;
	fetchFn?: typeof fetch;
}

/**
 * The narrative of one run. Throws RetryLaterError on a network failure or timeout before the last delivery
 * (`attempts`, this delivery's count); every other outcome, the last delivery included, is returned.
 */
export async function writeNarrative(
	deps: NarrativeDeps,
	facts: AgentFacts,
	locale: Locale,
	attempts: number
): Promise<NarrativeOutcome> {
	if (!isAiGatewayConfigured(deps.env)) return none('ai_unconfigured');
	const apiKey = await resolveAnthropicKey(deps.db, deps.userId, deps.env);
	if (!apiKey) return none('no_key');
	return narrateWithKey(deps.env, apiKey, facts, locale, attempts, deps.fetchFn);
}
