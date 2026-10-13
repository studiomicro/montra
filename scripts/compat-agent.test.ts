import { describe, expect, it, vi } from 'vitest';
import { agentFacts } from '../src/lib/server/agent/facts.ts';
import type { narrateWithKey } from '../src/lib/server/agent/narrate.ts';
import { COMPAT_FACTS, compatAgentReport } from './compat-agent.ts';

// The owner-run real-provider check (FN-23 criterion 32): here only with an injected narrator, never the provider.

const CREDENTIALS = {
	apiKey: 'sk-ant-api03-synthetic-0023-AbCdEfGh',
	env: { AI_GATEWAY_ACCOUNT_ID: 'acct', AI_GATEWAY_ID: 'gw' }
};

describe('compat:agent', () => {
	it('does nothing without local credentials', async () => {
		expect(await compatAgentReport(null)).toBe(
			'tidak ada kunci Anthropic lokal — compat:agent tidak dijalankan'
		);
	});

	it('prints the outcome and token counts, never the key or the narrative text', async () => {
		const narrate = vi.fn(async () => ({
			state: 'ai' as const,
			text: 'Rahasia sekali.',
			inputTokens: 10,
			outputTokens: 5
		}));
		const report = await compatAgentReport(
			CREDENTIALS,
			narrate as unknown as typeof narrateWithKey
		);
		expect(narrate).toHaveBeenCalledWith(
			CREDENTIALS.env,
			CREDENTIALS.apiKey,
			COMPAT_FACTS,
			'id',
			3
		);
		expect(report).toContain('narrative  guard:prose  tokens:10/5  request-without-tools:accepted');
		expect(report).not.toContain(CREDENTIALS.apiKey);
		expect(report).not.toContain('Rahasia');
		const skipped = await compatAgentReport(CREDENTIALS, (async () => ({
			state: 'skipped',
			reason: 'guard',
			inputTokens: 1,
			outputTokens: 2
		})) as unknown as typeof narrateWithKey);
		expect(skipped).toContain('skipped:guard  tokens:1/2');
	});

	it('the fixed facts are valid report facts', () => {
		expect(agentFacts.safeParse(COMPAT_FACTS).success).toBe(true);
	});
});
