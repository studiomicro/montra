import { existsSync, readFileSync } from 'node:fs';
import type { AgentFacts } from '../src/lib/server/agent/facts.ts';
import { narrateWithKey, type NarrativeOutcome } from '../src/lib/server/agent/narrate.ts';
import { credentialsFrom, parseDevVars, type ReceiptCredentials } from './compat-receipts.ts';
import { assertLocalOnly } from './local-guard.ts';

/**
 * `npm run compat:agent` (FN-23 criterion 32): the real-provider check the owner runs by hand. It writes one
 * monthly narrative through the same `narrateWithKey` the jobs Worker uses (one Messages call, no `tools` field,
 * `thinking: between_tools`, max_tokens 800, the answer through Tanya's figure guard), with the owner's own key
 * and gateway from the local `.dev.vars` (`COMPAT_AGENT_ANTHROPIC_KEY`, else `COMPAT_RECEIPTS_ANTHROPIC_KEY`;
 * `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`), never from a command-line argument. The facts are fixed and
 * fictional (no database). It prints the outcome (state, reason, token counts) and whether the request without
 * tools was accepted — never the key or the narrative text. Without credentials it prints why and does nothing.
 * Never part of `npm run gates` or CI; always exits 0 (a report, not a gate).
 */

/** A fictional month: every figure is invented for the check and never stored. */
export const COMPAT_FACTS: AgentFacts = {
	version: 1,
	type: 'monthly',
	period: '2026-09',
	from: '2026-09-01',
	to: '2026-09-30',
	generatedOn: '2026-10-10',
	partial: false,
	read: {
		count: 128,
		expenseCount: 120,
		incomeCount: 8,
		transferCount: 0,
		adjustmentCount: 0,
		currencies: ['IDR']
	},
	group: {
		categoryCount: 6,
		currencies: [
			{
				currency: 'IDR',
				categories: [
					{ name: 'Makan', outMinor: 2_450_000_00 },
					{ name: 'Transportasi', outMinor: 780_000_00 },
					{ name: 'Belanja', outMinor: 610_000_00 }
				],
				otherCount: 3,
				otherMinor: 300_000_00,
				merchants: [
					{ title: 'Warung Contoh', count: 14, amountMinor: 420_000_00 },
					{ title: 'Ojek Contoh', count: 22, amountMinor: 310_000_00 }
				]
			}
		]
	},
	summary: {
		previousPeriod: '2026-08',
		currencies: [
			{
				currency: 'IDR',
				inMinor: 9_000_000_00,
				outMinor: 4_140_000_00,
				netMinor: 4_860_000_00,
				previousOutMinor: 3_900_000_00,
				changePercent: 6
			}
		]
	}
};

export function line(outcome: NarrativeOutcome): string {
	const tokens = `${outcome.inputTokens ?? '-'}/${outcome.outputTokens ?? '-'}`;
	if (outcome.state === 'ai')
		return `narrative  guard:prose  tokens:${tokens}  request-without-tools:accepted`;
	// A 400 for the request shape (thinking without tools) is classified `network` by FN-41's classifier.
	const accepted = outcome.reason === 'network' ? 'unknown (provider error)' : 'accepted';
	return `narrative  ${outcome.state}:${outcome.reason}  tokens:${tokens}  request-without-tools:${accepted}`;
}

/** The whole report. `narrate` is injected by tests (no test reaches the provider). */
export async function compatAgentReport(
	credentials: ReceiptCredentials | null,
	narrate: typeof narrateWithKey = narrateWithKey
): Promise<string> {
	if (!credentials) return 'tidak ada kunci Anthropic lokal — compat:agent tidak dijalankan';
	// Attempt 3 = the last delivery: a network failure is reported, never retried.
	const outcome = await narrate(credentials.env, credentials.apiKey, COMPAT_FACTS, 'id', 3);
	return ['Agen: one monthly narrative against the real provider.', line(outcome)].join('\n');
}

if (import.meta.main) {
	assertLocalOnly(process.argv.slice(2));
	try {
		const vars = existsSync('.dev.vars') ? parseDevVars(readFileSync('.dev.vars', 'utf8')) : {};
		const key = vars.COMPAT_AGENT_ANTHROPIC_KEY ?? vars.COMPAT_RECEIPTS_ANTHROPIC_KEY;
		console.log(
			await compatAgentReport(
				credentialsFrom(key ? { ...vars, COMPAT_RECEIPTS_ANTHROPIC_KEY: key } : vars)
			)
		);
	} catch (e) {
		// A report, never a gate: an unexpected failure is one fixed line (no content), still exit 0.
		console.log(`compat:agent stopped: ${e instanceof Error ? e.name : 'error'}`);
	}
	process.exit(0);
}
