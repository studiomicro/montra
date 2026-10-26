import { sql } from 'drizzle-orm';
import { AGENT_FACTS_MAX_BYTES, stepsOf, type AgentStep } from '#lib/shared/agent';
import { RetryLaterError, type JobMessage } from '#lib/shared/jobs';
import type { AiGatewayEnv } from '../ai-keys/anthropic';
import type { AiKeysEnv } from '../ai-keys/crypto';
import { agentEnabled, planOf } from '../billing/gate';
import type { Db } from '../db';
import { isLiveMember } from '../spaces/access';
import { errorLabel } from '../util';
import {
	agentFacts,
	assetsStep,
	balancesStep,
	groupStep,
	readStep,
	startFacts,
	summaryStep,
	type AgentFacts
} from './facts';
import { writeReportFiles } from './files';
import { writeNarrative } from './narrative';
import { renderCsv, renderHtml } from './render';
import {
	AGENT_MAX_ATTEMPTS,
	claimStep,
	finishStep,
	markFailed,
	markReady,
	readRun,
	recordStepFailure,
	type AgentRunRow,
	type StepResult
} from './repo';

/**
 * The step machine of an Agen report (FN-23), run by the jobs Worker for each `agent_run` message (ids only).
 * One delivery runs at most one step: it reads the run, takes the step's lease (`claimStep`), re-checks that the
 * creator is still a live member and still on the Agent plan, does the step's bounded work, stores the result by
 * compare-and-set (`finishStep`) and only then enqueues the next step. So a repeated or concurrent delivery
 * never runs a step twice; a step that throws leaves `steps_done` as it was (the queue retries that step); a
 * next-step enqueue that fails throws after the store, and the redelivery continues with the next step. After
 * AGENT_MAX_ATTEMPTS failed deliveries on one run, or AGENT_STEP_MAX_DELIVERIES of one step, the run fails.
 * No D1 statement spans R2, the queue or the AI call: each is its own step or its own call.
 */

/** Deliveries of one step's message before a failing step fails the run (wrangler max_retries 3). */
const AGENT_STEP_MAX_DELIVERIES = 3;

export interface StepDeps {
	db: Db;
	env: (AiGatewayEnv & AiKeysEnv) | undefined;
	files: R2Bucket;
	cache?: KVNamespace;
	enqueue(messages: JobMessage[]): Promise<void>;
	now(): number;
	fetchFn?: typeof fetch;
}

export type StepOutcome = 'skipped' | 'advanced' | 'ready' | 'failed';

async function stillMember(db: Db, spaceId: string, userId: string): Promise<boolean> {
	const [row] = await db.all<{ ok: number }>(sql`select ${isLiveMember(spaceId, userId)} as ok`);
	return row?.ok === 1;
}

function factsOf(run: AgentRunRow, now: number): AgentFacts {
	if (run.factsJson === null) return startFacts(run.type, run.period, now);
	return agentFacts.parse(JSON.parse(run.factsJson));
}

type Executed = StepResult | 'empty' | 'too_large' | 'ready' | 'lost';

async function execute(
	deps: StepDeps,
	run: AgentRunRow,
	step: AgentStep,
	attempts: number,
	now: number
): Promise<Executed> {
	const facts = factsOf(run, now);
	const ctx = { db: deps.db, spaceId: run.spaceId, now, cache: deps.cache };
	const stored = (next: AgentFacts): StepResult | 'too_large' => {
		const factsJson = JSON.stringify(agentFacts.parse(next));
		return factsJson.length > AGENT_FACTS_MAX_BYTES ? 'too_large' : { factsJson };
	};
	switch (step) {
		case 'read': {
			const next = await readStep(ctx, facts);
			return next === 'empty' ? 'empty' : stored(next);
		}
		case 'group':
			return stored(await groupStep(ctx, facts));
		case 'summary':
			return stored(await summaryStep(ctx, facts));
		case 'balances':
			return stored(await balancesStep(ctx, facts));
		case 'assets':
			return stored(await assetsStep(ctx, facts));
		case 'narrate': {
			const outcome = run.withNarrative
				? await writeNarrative(
						{ db: deps.db, env: deps.env, userId: run.userId, fetchFn: deps.fetchFn },
						facts,
						run.locale,
						attempts
					)
				: ({ state: 'none', reason: 'off', inputTokens: null, outputTokens: null } as const);
			return {
				factsJson: JSON.stringify(facts),
				narrative:
					outcome.state === 'ai' ? { ...outcome, reason: null } : { ...outcome, text: null }
			};
		}
		case 'render': {
			const narrative = run.narrativeState === 'ai' ? run.narrativeText : null;
			const files = await writeReportFiles(
				deps.db,
				deps.files,
				run,
				{
					csv: renderCsv(facts, narrative, run.locale),
					html: renderHtml(facts, narrative, run.locale)
				},
				now
			);
			return (await markReady(deps.db, run, files, now)) ? 'ready' : 'lost';
		}
	}
}

/** One delivery of `{ type: 'agent_run', runId }` (`attempts`: this delivery's count). Throws for a queue retry. */
export async function runNextStep(
	deps: StepDeps,
	runId: string,
	attempts: number
): Promise<StepOutcome> {
	const { db } = deps;
	const now = deps.now();
	const run = await readRun(db, runId);
	if (!run || (run.status !== 'queued' && run.status !== 'running') || run.expiresAt <= now)
		return 'skipped';
	const step = stepsOf(run.type)[run.stepsDone];
	if (!step || !(await claimStep(db, runId, run.stepsDone, now))) return 'skipped';
	if (!(await stillMember(db, run.spaceId, run.userId))) {
		await markFailed(db, runId, 'access', now);
		return 'failed';
	}
	// A plan that lapsed between steps ends the run here: no further step and no file.
	if (!agentEnabled(await planOf(db, run.userId, now))) {
		await markFailed(db, runId, 'plan', now);
		return 'failed';
	}
	let result: Executed;
	try {
		result = await execute(deps, run, step, attempts, now);
	} catch (e) {
		const count = await recordStepFailure(db, runId, run.stepsDone, deps.now()).catch(() => null);
		console.warn('agent: step failed', { step, attempts, error: errorLabel(e) });
		const lastTry =
			(count ?? 0) > AGENT_MAX_ATTEMPTS ||
			(!(e instanceof RetryLaterError) && attempts >= AGENT_STEP_MAX_DELIVERIES);
		if (!lastTry) throw e;
		await markFailed(db, runId, 'internal', deps.now());
		return 'failed';
	}
	if (result === 'empty') {
		await markFailed(db, runId, 'empty', now);
		return 'failed';
	}
	if (result === 'too_large') {
		await markFailed(db, runId, 'internal', now);
		return 'failed';
	}
	if (result === 'ready') return 'ready';
	if (result === 'lost' || !(await finishStep(db, runId, run.stepsDone, result, now)))
		return 'skipped';
	await deps.enqueue([{ type: 'agent_run', runId }]);
	return 'advanced';
}
