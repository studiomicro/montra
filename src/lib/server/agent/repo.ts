import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
	AGENT_DAY_MS,
	AGENT_LIVE_MAX,
	AGENT_MAX_YEARS_BACK,
	AGENT_READY_TTL_MS,
	AGENT_SPACE_ACTIVE_MAX,
	AGENT_SPACE_DAILY_MAX,
	AGENT_UNFINISHED_TTL_MS,
	AGENT_USER_ACTIVE_MAX,
	AGENT_USER_DAILY_MAX,
	stepsOf,
	type AgentFailure,
	type AgentNarrativeReason,
	type AgentNarrativeState,
	type AgentStatus,
	type AgentType
} from '#lib/shared/agent';
import type { Locale } from '#lib/shared/i18n';
import type { Db } from '../db';
import { agentRuns, spaces } from '../db/schema';
import { keepKey } from '../photos/store';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { sha256Hex } from '../util';
import { agentFacts } from './facts';
import { releaseAgentKeys } from './keys';

/**
 * `agent_runs` (FN-23). Every read for the page or a download is keyed by (id, user, space) and repeats the live
 * membership in its own statement, so only the member who created a run sees it, and only while still a member.
 * The jobs Worker advances a run with `claimStep` (a 120 s lease) and `finishStep` (compare-and-set on
 * `steps_done`), so a repeated or concurrent delivery never runs a step's side effects twice. R2 keys pass the
 * file-deletion outbox (photos/store.ts) in the same batch as every write that stops holding them.
 */

/** How long one delivery holds a step. */
const AGENT_LEASE_MS = 120_000;
/** No progress for this long (lease expired): the cron sweep re-sends the run once. */
export const AGENT_STALL_RESEND_MS = 5 * 60 * 1000;
/** No progress for this long after a re-send or a failed delivery: the run is failed. */
export const AGENT_STALL_FAIL_MS = 30 * 60 * 1000;
/** Failed step deliveries (any step) before the run is failed. */
export const AGENT_MAX_ATTEMPTS = 6;
/** Most runs one sweep deletes, fails or re-sends per kind. */
const AGENT_SWEEP_EXPIRE_MAX = 100;
const AGENT_SWEEP_STALL_MAX = 50;

/** The run's id for one form submission: a resubmitted form names the same row (and never another user's). */
export async function agentRunId(userId: string, requestId: string): Promise<string> {
	return (await sha256Hex(`agent:${userId}:${requestId}`)).slice(0, 32);
}

export type CreateRunResult =
	| 'created'
	| 'exists'
	| 'user_busy'
	| 'space_busy'
	| 'user_daily'
	| 'space_daily'
	| 'too_many'
	| 'gone';

const UNFINISHED = sql`status in ('queued', 'running')`;

/**
 * Creates a queued run in one guarded `INSERT … SELECT … WHERE` (checklist › concurrent writes): only for a live
 * member of the live space, only while every cap holds (AGENT_USER_ACTIVE_MAX unfinished per user, …_SPACE_…
 * per space, AGENT_USER_DAILY_MAX / AGENT_SPACE_DAILY_MAX new runs in a rolling day, AGENT_LIVE_MAX live reports
 * per user and space). A double submit (same id) inserts nothing and answers 'exists'. A refusal writes nothing.
 */
export async function createRun(
	db: Db,
	scope: SpaceScope,
	run: { id: string; type: AgentType; period: string; withNarrative: boolean; locale: Locale },
	now: number
): Promise<CreateRunResult> {
	const { spaceId, userId } = scope;
	const dayAgo = now - AGENT_DAY_MS;
	const [stmt] = await db.batch([
		db
			.insert(agentRuns)
			.select((qb) =>
				qb
					.select({
						id: sql`${run.id}`.as('id'),
						userId: sql`${userId}`.as('user_id'),
						spaceId: spaces.id,
						type: sql`${run.type}`.as('type'),
						period: sql`${run.period}`.as('period'),
						withNarrative: sql`${run.withNarrative ? 1 : 0}`.as('with_narrative'),
						locale: sql`${run.locale}`.as('locale'),
						status: sql`'queued'`.as('status'),
						stepsDone: sql`0`.as('steps_done'),
						failure: sql`null`.as('failure'),
						narrativeState: sql`'none'`.as('narrative_state'),
						narrativeReason: sql`null`.as('narrative_reason'),
						factsJson: sql`null`.as('facts_json'),
						narrativeText: sql`null`.as('narrative_text'),
						csvKey: sql`null`.as('csv_key'),
						htmlKey: sql`null`.as('html_key'),
						csvBytes: sql`null`.as('csv_bytes'),
						htmlBytes: sql`null`.as('html_bytes'),
						aiInputTokens: sql`null`.as('ai_input_tokens'),
						aiOutputTokens: sql`null`.as('ai_output_tokens'),
						attempts: sql`0`.as('attempts'),
						leaseUntil: sql`null`.as('lease_until'),
						createdAt: sql`${now}`.as('created_at'),
						updatedAt: sql`${now}`.as('updated_at'),
						readyAt: sql`null`.as('ready_at'),
						expiresAt: sql`${now + AGENT_UNFINISHED_TTL_MS}`.as('expires_at'),
						deletedAt: sql`null`.as('deleted_at')
					})
					.from(spaces)
					.where(
						and(
							eq(spaces.id, spaceId),
							isLiveMember(spaceId, userId),
							sql`(select count(*) from agent_runs r where r.user_id = ${userId}
								and r.status in ('queued', 'running') and r.expires_at > ${now}) < ${AGENT_USER_ACTIVE_MAX}`,
							sql`(select count(*) from agent_runs r where r.space_id = ${spaceId}
								and r.status in ('queued', 'running') and r.expires_at > ${now}) < ${AGENT_SPACE_ACTIVE_MAX}`,
							sql`(select count(*) from agent_runs r where r.user_id = ${userId}
								and r.created_at > ${dayAgo}) < ${AGENT_USER_DAILY_MAX}`,
							sql`(select count(*) from agent_runs r where r.space_id = ${spaceId}
								and r.created_at > ${dayAgo}) < ${AGENT_SPACE_DAILY_MAX}`,
							sql`(select count(*) from agent_runs r where r.user_id = ${userId}
								and r.space_id = ${spaceId} and r.expires_at > ${now} and r.deleted_at is null) < ${AGENT_LIVE_MAX}`
						)
					)
			)
			.onConflictDoNothing()
			.returning({ id: agentRuns.id })
	]);
	if (stmt.length === 1) return 'created';
	const [row] = await db.all<{
		mine: number;
		userActive: number;
		spaceActive: number;
		userDay: number;
		spaceDay: number;
		live: number;
	}>(sql`select
		(select count(*) from agent_runs where id = ${run.id} and user_id = ${userId}) as mine,
		(select count(*) from agent_runs where user_id = ${userId} and ${UNFINISHED} and expires_at > ${now}) as userActive,
		(select count(*) from agent_runs where space_id = ${spaceId} and ${UNFINISHED} and expires_at > ${now}) as spaceActive,
		(select count(*) from agent_runs where user_id = ${userId} and created_at > ${dayAgo}) as userDay,
		(select count(*) from agent_runs where space_id = ${spaceId} and created_at > ${dayAgo}) as spaceDay,
		(select count(*) from agent_runs where user_id = ${userId} and space_id = ${spaceId}
			and expires_at > ${now} and deleted_at is null) as live`);
	if (!row) return 'gone';
	if (row.mine > 0) return 'exists';
	if (row.userActive >= AGENT_USER_ACTIVE_MAX) return 'user_busy';
	if (row.spaceActive >= AGENT_SPACE_ACTIVE_MAX) return 'space_busy';
	if (row.userDay >= AGENT_USER_DAILY_MAX) return 'user_daily';
	if (row.spaceDay >= AGENT_SPACE_DAILY_MAX) return 'space_daily';
	if (row.live >= AGENT_LIVE_MAX) return 'too_many';
	return 'gone';
}

/** Months (`YYYY-MM`, newest first) of the last AGENT_MAX_YEARS_BACK years that hold a live, real row. */
export async function monthsWithRows(db: Db, spaceId: string, today: string): Promise<string[]> {
	const oldest = `${Number(today.slice(0, 4)) - AGENT_MAX_YEARS_BACK}-01-01`;
	const rows = await db.all<{ m: string }>(sql`select distinct substr(occurred_on, 1, 7) as m
		from transactions
		where space_id = ${spaceId} and deleted_at is null and is_demo = 0
			and occurred_on >= ${oldest} and occurred_on <= ${today}
		order by m desc
		limit ${(AGENT_MAX_YEARS_BACK + 1) * 12}`);
	return rows.map((r) => r.m);
}

/** Whether the WIB range holds any live, real transaction (the "Belum ada catatan" check). */
export async function hasRowsIn(
	db: Db,
	spaceId: string,
	range: { from: string; to: string }
): Promise<boolean> {
	const [row] = await db.all<{
		n: number;
	}>(sql`select count(*) as n from (select 1 from transactions
		where space_id = ${spaceId} and deleted_at is null and is_demo = 0
			and occurred_on >= ${range.from} and occurred_on <= ${range.to} limit 1)`);
	return (row?.n ?? 0) > 0;
}

/** Whether the space has anything an asset list can show (a live wallet or a real asset record). */
export async function hasAssetRecords(db: Db, spaceId: string): Promise<boolean> {
	const [row] = await db.all<{ n: number }>(sql`select
		exists (select 1 from wallets where space_id = ${spaceId} and deleted_at is null)
		or exists (select 1 from net_worth_items where space_id = ${spaceId} and deleted_at is null and is_demo = 0)
		or exists (select 1 from belongings where space_id = ${spaceId} and deleted_at is null and is_demo = 0)
		or exists (select 1 from collectibles where space_id = ${spaceId} and deleted_at is null and is_demo = 0)
		as n`);
	return (row?.n ?? 0) === 1;
}

/** A run as the page lists it: never a key, a user id or the facts themselves. */
export interface AgentRunView {
	id: string;
	type: AgentType;
	period: string;
	withNarrative: boolean;
	status: AgentStatus;
	stepsDone: number;
	failure: AgentFailure | null;
	narrativeState: AgentNarrativeState;
	narrativeReason: AgentNarrativeReason | null;
	csvBytes: number | null;
	htmlBytes: number | null;
	createdAt: number;
	expiresAt: number;
	/** Counts from the stored facts, for the step lines ("Membaca 1.234 transaksi"). */
	counts: {
		transactions: number | null;
		categories: number | null;
		months: number | null;
		wallets: number | null;
		assets: number | null;
	};
}

function countsOf(factsJson: string | null): AgentRunView['counts'] {
	const empty = { transactions: null, categories: null, months: null, wallets: null, assets: null };
	if (!factsJson) return empty;
	let parsed;
	try {
		parsed = agentFacts.safeParse(JSON.parse(factsJson));
	} catch {
		return empty;
	}
	if (!parsed.success) return empty;
	const f = parsed.data;
	const inv = f.inventory;
	return {
		transactions: f.read?.count ?? null,
		categories: f.group?.categoryCount ?? null,
		months: f.summary?.currencies[0]?.months?.length ?? null,
		wallets: inv ? inv.wallets : null,
		assets: inv ? inv.items + inv.belongings + inv.collectibles : null
	};
}

/** The user's live runs in the space, newest first (at most AGENT_LIVE_MAX), while they are a live member. */
export async function listRuns(db: Db, scope: SpaceScope, now: number): Promise<AgentRunView[]> {
	const rows = await db
		.select({
			id: agentRuns.id,
			type: agentRuns.type,
			period: agentRuns.period,
			withNarrative: agentRuns.withNarrative,
			status: agentRuns.status,
			stepsDone: agentRuns.stepsDone,
			failure: agentRuns.failure,
			narrativeState: agentRuns.narrativeState,
			narrativeReason: agentRuns.narrativeReason,
			csvBytes: agentRuns.csvBytes,
			htmlBytes: agentRuns.htmlBytes,
			createdAt: agentRuns.createdAt,
			expiresAt: agentRuns.expiresAt,
			// Counts are shown only while a run is unfinished: a ready run's facts are never read for the list.
			factsJson: sql<
				string | null
			>`case when ${agentRuns.status} in ('queued', 'running') then ${agentRuns.factsJson} end`
		})
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.userId, scope.userId),
				eq(agentRuns.spaceId, scope.spaceId),
				sql`${agentRuns.expiresAt} > ${now}`,
				isNull(agentRuns.deletedAt),
				isLiveMember(scope.spaceId, scope.userId)
			)
		)
		.orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
		.limit(AGENT_LIVE_MAX);
	return rows.map(({ factsJson, ...r }) => ({ ...r, counts: countsOf(factsJson) }));
}

/** The space of the user's own run, or '' (so an unknown id asks `requireSpaceAccess` about no space). */
export async function runSpaceId(db: Db, userId: string, runId: string): Promise<string> {
	const row = await db
		.select({ spaceId: agentRuns.spaceId })
		.from(agentRuns)
		.where(and(eq(agentRuns.id, runId.slice(0, 64)), eq(agentRuns.userId, userId)))
		.get();
	return row?.spaceId ?? '';
}

/** A ready, unexpired run of the user in the space, while they are a live member; null otherwise. */
export async function getReadyRun(db: Db, scope: SpaceScope, runId: string, now: number) {
	const row = await db
		.select({
			type: agentRuns.type,
			period: agentRuns.period,
			csvKey: agentRuns.csvKey,
			htmlKey: agentRuns.htmlKey
		})
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.id, runId.slice(0, 64)),
				eq(agentRuns.userId, scope.userId),
				eq(agentRuns.spaceId, scope.spaceId),
				eq(agentRuns.status, 'ready'),
				sql`${agentRuns.expiresAt} > ${now}`,
				isNull(agentRuns.deletedAt),
				isLiveMember(scope.spaceId, scope.userId)
			)
		)
		.get();
	return row && row.csvKey && row.htmlKey
		? { type: row.type, period: row.period, csvKey: row.csvKey, htmlKey: row.htmlKey }
		: null;
}

/**
 * "Hapus": the user's own run in the space, files to the outbox in one batch. Idempotent. A run created in the last
 * 24 hours stays as a contentless tombstone (failed, no facts, keys, narrative or counts) until `created_at` + 24 h,
 * so the daily caps keep counting it and create-delete loops cannot cycle them (red team S2); an older run is
 * deleted outright. The tombstone is never listed or downloadable, and a queued step for it is acked unworked.
 */
export async function deleteRun(
	db: Db,
	scope: SpaceScope,
	runId: string,
	now: number
): Promise<string[]> {
	const mine = and(
		eq(agentRuns.id, runId.slice(0, 64)),
		eq(agentRuns.userId, scope.userId),
		eq(agentRuns.spaceId, scope.spaceId)
	);
	const recent = sql`${agentRuns.createdAt} > ${now - AGENT_DAY_MS}`;
	const [csv, html] = releaseAgentKeys(db, mine, now);
	const [a, b] = await db.batch([
		csv,
		html,
		db
			.update(agentRuns)
			.set({
				...FAILED_FIELDS('access', now),
				narrativeReason: null,
				csvKey: null,
				htmlKey: null,
				csvBytes: null,
				htmlBytes: null,
				readyAt: null,
				aiInputTokens: null,
				aiOutputTokens: null,
				expiresAt: sql`${agentRuns.createdAt} + ${AGENT_DAY_MS}`,
				deletedAt: sql`coalesce(${agentRuns.deletedAt}, ${now})`
			})
			.where(and(mine, recent)),
		db.delete(agentRuns).where(and(mine, sql`not (${recent})`))
	]);
	return [...a, ...b].map((k) => k.key);
}

// ── The jobs Worker's side ─────────────────────────────────────────────────────────────────────────────────────

export type AgentRunRow = typeof agentRuns.$inferSelect;

export async function readRun(db: Db, runId: string): Promise<AgentRunRow | null> {
	return (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get()) ?? null;
}

/** Takes the lease on step `stepsDone` of an unfinished, unexpired run; false when another delivery holds it. */
export async function claimStep(
	db: Db,
	runId: string,
	stepsDone: number,
	now: number
): Promise<boolean> {
	const rows = await db
		.update(agentRuns)
		.set({ status: 'running', leaseUntil: now + AGENT_LEASE_MS, updatedAt: now })
		.where(
			and(
				eq(agentRuns.id, runId),
				inArray(agentRuns.status, ['queued', 'running']),
				eq(agentRuns.stepsDone, stepsDone),
				sql`(${agentRuns.leaseUntil} is null or ${agentRuns.leaseUntil} <= ${now})`,
				sql`${agentRuns.expiresAt} > ${now}`
			)
		)
		.returning({ id: agentRuns.id });
	return rows.length === 1;
}

export interface StepResult {
	factsJson: string;
	narrative?: {
		state: AgentNarrativeState;
		reason: AgentNarrativeReason | null;
		text: string | null;
		inputTokens: number | null;
		outputTokens: number | null;
	};
}

/** Stores a finished step (compare-and-set on `steps_done`); false when the run moved on or ended meanwhile. */
export async function finishStep(
	db: Db,
	runId: string,
	stepsDone: number,
	result: StepResult,
	now: number
): Promise<boolean> {
	const n = result.narrative;
	const rows = await db
		.update(agentRuns)
		.set({
			factsJson: result.factsJson,
			stepsDone: stepsDone + 1,
			leaseUntil: null,
			updatedAt: now,
			...(n
				? {
						narrativeState: n.state,
						narrativeReason: n.reason,
						narrativeText: n.text,
						aiInputTokens: n.inputTokens,
						aiOutputTokens: n.outputTokens
					}
				: {})
		})
		.where(
			and(
				eq(agentRuns.id, runId),
				eq(agentRuns.status, 'running'),
				eq(agentRuns.stepsDone, stepsDone)
			)
		)
		.returning({ id: agentRuns.id });
	return rows.length === 1;
}

/** A failed delivery of step `stepsDone`: one more attempt, lease released; the run's attempt count, or null. */
export async function recordStepFailure(
	db: Db,
	runId: string,
	stepsDone: number,
	now: number
): Promise<number | null> {
	const [row] = await db
		.update(agentRuns)
		.set({ attempts: sql`${agentRuns.attempts} + 1`, leaseUntil: null, updatedAt: now })
		.where(
			and(
				eq(agentRuns.id, runId),
				inArray(agentRuns.status, ['queued', 'running']),
				eq(agentRuns.stepsDone, stepsDone)
			)
		)
		.returning({ attempts: agentRuns.attempts });
	return row?.attempts ?? null;
}

const FAILED_FIELDS = (failure: AgentFailure, now: number) => ({
	status: 'failed' as const,
	failure,
	factsJson: null,
	narrativeState: 'none' as const,
	narrativeText: null,
	leaseUntil: null,
	updatedAt: now
});

/** Ends an unfinished run as failed: partial facts and narrative cleared (it still expires 7 days after creation). */
export async function markFailed(
	db: Db,
	runId: string,
	failure: AgentFailure,
	now: number
): Promise<void> {
	await db
		.update(agentRuns)
		.set(FAILED_FIELDS(failure, now))
		.where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['queued', 'running'])));
}

/**
 * The last step: both files are written, so the run is `ready` (expiring AGENT_READY_TTL_MS from now) and the two
 * reserved keys leave the outbox, in one batch. A run that moved on or ended meanwhile changes nothing and its
 * keys stay due for deletion. True when this call made the run ready.
 */
export async function markReady(
	db: Db,
	run: { id: string; type: AgentType },
	files: { csvKey: string; htmlKey: string; csvBytes: number; htmlBytes: number },
	now: number
): Promise<boolean> {
	const total = stepsOf(run.type).length;
	const holds = (column: typeof agentRuns.csvKey | typeof agentRuns.htmlKey, key: string) =>
		sql`exists (select 1 from agent_runs r where r.id = ${run.id} and r.status = 'ready'
			and r.${sql.raw(column.name)} = ${key})`;
	const [updated] = await db.batch([
		db
			.update(agentRuns)
			.set({
				status: 'ready',
				stepsDone: total,
				csvKey: files.csvKey,
				htmlKey: files.htmlKey,
				csvBytes: files.csvBytes,
				htmlBytes: files.htmlBytes,
				readyAt: now,
				expiresAt: now + AGENT_READY_TTL_MS,
				leaseUntil: null,
				updatedAt: now
			})
			.where(
				and(
					eq(agentRuns.id, run.id),
					eq(agentRuns.status, 'running'),
					eq(agentRuns.stepsDone, total - 1)
				)
			)
			.returning({ id: agentRuns.id }),
		keepKey(db, files.csvKey, holds(agentRuns.csvKey, files.csvKey)),
		keepKey(db, files.htmlKey, holds(agentRuns.htmlKey, files.htmlKey))
	]);
	return updated.length === 1;
}

export interface AgentSweep {
	expired: number;
	failed: number;
	/** Runs to re-send to the queue (ids only). */
	requeue: string[];
}

/**
 * The cron's bounded pass (before the file sweep): expired runs (ready after 30 days, unfinished or failed after
 * 7) are deleted with their keys moved to the outbox in one batch (AGENT_SWEEP_EXPIRE_MAX per tick); a run with
 * no progress for AGENT_STALL_FAIL_MS that already failed a delivery or was re-sent is failed; a run with no
 * progress for AGENT_STALL_RESEND_MS (lease expired) is re-sent once (attempts + 1). Each update is one guarded
 * statement, so a run that progressed meanwhile is never touched.
 */
export async function sweepAgentRuns(db: Db, now: number): Promise<AgentSweep> {
	const expired = await db
		.select({ id: agentRuns.id })
		.from(agentRuns)
		.where(sql`${agentRuns.expiresAt} <= ${now}`)
		.orderBy(agentRuns.expiresAt, agentRuns.id)
		.limit(AGENT_SWEEP_EXPIRE_MAX);
	if (expired.length > 0) {
		const ids = JSON.stringify(expired.map((r) => r.id));
		const among = sql`${agentRuns.id} in (select value from json_each(${ids})) and ${agentRuns.expiresAt} <= ${now}`;
		const [csv, html] = releaseAgentKeys(db, among, now);
		await db.batch([csv, html, db.delete(agentRuns).where(among)]);
	}
	const stalled = (ms: number) => sql`status in ('queued', 'running')
		and updated_at <= ${now - ms} and (lease_until is null or lease_until <= ${now})
		and expires_at > ${now}`;
	const failed = await db
		.update(agentRuns)
		.set(FAILED_FIELDS('internal', now))
		.where(
			sql`${agentRuns.id} in (select id from agent_runs
				where ${stalled(AGENT_STALL_FAIL_MS)} and attempts >= 1 limit ${AGENT_SWEEP_STALL_MAX})`
		)
		.returning({ id: agentRuns.id });
	const requeue = await db
		.update(agentRuns)
		.set({ attempts: sql`${agentRuns.attempts} + 1`, updatedAt: now })
		.where(
			sql`${agentRuns.id} in (select id from agent_runs
				where ${stalled(AGENT_STALL_RESEND_MS)} and attempts = 0 limit ${AGENT_SWEEP_STALL_MAX})`
		)
		.returning({ id: agentRuns.id });
	return { expired: expired.length, failed: failed.length, requeue: requeue.map((r) => r.id) };
}

/**
 * The re-send of `ids` could not be enqueued (red team S3): their one re-send is given back, so the next sweep tries
 * again instead of failing them 30 minutes later. Only runs still unfinished on that first re-send are touched.
 */
export async function releaseResend(db: Db, ids: readonly string[]): Promise<void> {
	if (ids.length === 0) return;
	await db
		.update(agentRuns)
		.set({ attempts: sql`${agentRuns.attempts} - 1` })
		.where(
			sql`${agentRuns.id} in (select value from json_each(${JSON.stringify(ids)}))
				and ${agentRuns.attempts} = 1 and ${agentRuns.status} in ('queued', 'running')`
		);
}
