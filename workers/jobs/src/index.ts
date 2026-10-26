import { releaseResend, sweepAgentRuns } from '#lib/server/agent/repo';
import { runNextStep } from '#lib/server/agent/steps';
import { sweepAuthEvents } from '#lib/server/auth/passkeys';
import { sweepClaimMarkers } from '#lib/server/billing/claim-sweep';
import { snapshotBudgetDay } from '#lib/server/budgets/streak';
import { getDb } from '#lib/server/db';
import { countStatements } from '#lib/server/db/statement-count';
import {
	deliverPush,
	evaluateBills,
	evaluateBudget,
	evaluateCloseReminder,
	evaluateDailyNudge,
	evaluateWeeklySummary
} from '#lib/server/notifications/triggers';
import {
	getCronCursor,
	setCronCursor,
	spacesWithBudget,
	spacesWithSubscriptions,
	sweepNotifications,
	usersDueCloseReminder,
	usersWanting
} from '#lib/server/notifications/schedule';
import { isGmailJobConfigured } from '#lib/server/gmail/config';
import { googleClient } from '#lib/server/gmail/google';
import { processGmailRevocations } from '#lib/server/gmail/oauth';
import { processGmailRead } from '#lib/server/gmail/read';
import { connectionsDue, sweepGmail } from '#lib/server/gmail/repo';
import { processGmailCheck } from '#lib/server/gmail/scan';
import { resealGmailTokens, type AccessTokenCache } from '#lib/server/gmail/token';
import { processInboundRead } from '#lib/server/inbound/consume';
import { sweepInboundMail } from '#lib/server/inbound/repo';
import { FILE_DELETE_BATCH, sweepFileDeletions } from '#lib/server/photos/store';
import { recordPing } from '#lib/server/ping';
import { recurringChecker, spacesWithDueSeries } from '#lib/server/recurring/repo';
import { errorLabel } from '#lib/server/util';
import { vapidKeys } from '#lib/server/push/vapid';
import { wibTodayString } from '#lib/shared/dates';
import type { JobMessage } from '#lib/shared/jobs';
import { runCronTick } from './cron';
import { runNetWorthTick } from './net-worth';
import { handleBatch } from './queue';

export { StatementWorkflow } from './statement-workflow';

/** Sends up to 100 messages per call (the Queues batch limit; callers page at SCHEDULE_PAGE_SIZE = 100). */
const enqueueWith = (queue: Queue) => async (messages: JobMessage[]) => {
	if (messages.length > 0) await queue.sendBatch(messages.map((body) => ({ body })));
};

/**
 * One bounded step of the cron tick: its counts, or `fallback` when it fails. The failure is logged by class only,
 * and it never stops the tick's other steps.
 */
async function tickStep<T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		console.warn(`jobs: ${label} failed`, errorLabel(e));
		return fallback;
	}
}

/** FN-19 Gmail: access tokens of this isolate (memory only, at most 50 min each; gmail/token.ts). */
const gmailTokens: AccessTokenCache = new Map();

export default {
	async queue(batch, env) {
		// Every statement of this invocation is counted, so the recurring checks (run last) take only what the
		// other jobs left of D1's per-invocation cap (FN-36; red team L3).
		const counted = countStatements(env.DB);
		const db = getDb(counted.d1);
		const recurring = recurringChecker(db, counted.statements);
		const gmail = () => ({
			db,
			env,
			google: googleClient((url, init) => fetch(url, init)),
			tokens: gmailTokens,
			now: () => Date.now(),
			random: () => Math.random(),
			enqueue: enqueueWith(env.JOBS_QUEUE)
		});
		await handleBatch(batch, {
			recordPing: (id) => recordPing(counted.d1, id, Date.now()),
			budgetCheck: (spaceId) => evaluateBudget(db, spaceId, Date.now()),
			billCheck: (spaceId) => evaluateBills(db, spaceId, Date.now()),
			dailyNudge: (userId, date) => evaluateDailyNudge(db, userId, date, Date.now()),
			closeReminder: (userId, date) => evaluateCloseReminder(db, userId, date, Date.now()),
			budgetStreakSnapshot: async (spaceId, date) => {
				await snapshotBudgetDay(db, spaceId, date, Date.now());
			},
			weeklySummary: (userId, weekStart) =>
				evaluateWeeklySummary(db, userId, weekStart, Date.now()),
			sendPush: async (id) => {
				await deliverPush(db, id, vapidKeys(env), Date.now());
			},
			recurringCheck: async (spaceId, date) => {
				const run = await recurring(spaceId, date, Date.now());
				// Counts only: never ids, amounts or titles.
				if (run.limit + run.refs + run.member > 0)
					console.warn('jobs: recurring instances refused', run);
				return run.more;
			},
			fileSweep: async () =>
				(await sweepFileDeletions(db, env.FILES, Date.now())) >= FILE_DELETE_BATCH,
			inboundRead: async (mailId, attempts) => {
				await processInboundRead(db, env, mailId, attempts, Date.now());
			},
			gmailCheck: async (job, attempts) => {
				await processGmailCheck(gmail(), job, attempts);
			},
			gmailRead: async (mailId, attempts) => {
				await processGmailRead(gmail(), mailId, attempts);
			},
			agentRun: async (runId, attempts) => {
				await runNextStep(
					{
						db,
						env,
						files: env.FILES,
						cache: env.CACHE,
						enqueue: enqueueWith(env.JOBS_QUEUE),
						now: () => Date.now()
					},
					runId,
					attempts
				);
			},
			enqueue: enqueueWith(env.JOBS_QUEUE),
			today: () => wibTodayString()
		});
	},

	async scheduled(controller, env) {
		// Every statement of this invocation is counted, so the net-worth snapshots (run last) use what the cron's
		// other work left of D1's per-invocation cap (FN-25 red team L4).
		const counted = countStatements(env.DB);
		const db = getDb(counted.d1);
		const enqueue = enqueueWith(env.JOBS_QUEUE);
		const counts = await runCronTick(
			{
				spacesWithBudget: (after, limit) => spacesWithBudget(db, after, limit),
				spacesWithSubscriptions: (after, limit) => spacesWithSubscriptions(db, after, limit),
				spacesWithDueSeries: (today, after, limit) => spacesWithDueSeries(db, today, after, limit),
				usersWanting: (kind, after, limit) => usersWanting(db, kind, after, limit),
				usersDueCloseReminder: (today, hour, after, limit) =>
					usersDueCloseReminder(db, today, hour, after, limit),
				gmailConnectionsDue: isGmailJobConfigured(env)
					? (after, limit) => connectionsDue(db, controller.scheduledTime, after, limit)
					: null,
				enqueue,
				getCursor: (key) => getCronCursor(db, key),
				setCursor: (key, value) => setCronCursor(db, key, value, Date.now())
			},
			controller.scheduledTime
		);
		// Retention (90 days) and removed members' rows, a bounded batch per tick.
		await sweepNotifications(db, controller.scheduledTime);
		// FN-30 hardening: re-claim markers older than 730 days, one bounded batch (≤ 500) per tick. Needs no key.
		const markers = await tickStep('claim marker sweep', 0, () =>
			sweepClaimMarkers(db, controller.scheduledTime)
		);
		// FN-50: passkey sign-in events older than 90 days, one bounded batch (≤ 500) per tick.
		const authEvents = await tickStep('auth event sweep', 0, () =>
			sweepAuthEvents(db, controller.scheduledTime)
		);
		// FN-23: expired Agen reports (keys to the outbox, rows deleted), stalled runs failed or re-sent. Before the
		// file sweep, so expired report files go in this same tick.
		const agent = await tickStep(
			'agent sweep',
			{ expired: 0, failed: 0, requeued: 0 },
			async () => {
				const swept = await sweepAgentRuns(db, controller.scheduledTime);
				try {
					await enqueue(swept.requeue.map((runId) => ({ type: 'agent_run', runId })));
				} catch (e) {
					// Red team S3: the re-send was spent before this send; give it back so the next tick retries.
					await releaseResend(db, swept.requeue);
					throw e;
				}
				return { expired: swept.expired, failed: swept.failed, requeued: swept.requeue.length };
			}
		);
		// FN-27: R2 photos whose deletion is due and was not finished inline (one bounded batch per tick; a
		// full batch hands the rest to the queue).
		const files = await tickStep('file sweep', 0, () =>
			sweepFileDeletions(db, env.FILES, controller.scheduledTime)
		);
		if (files >= FILE_DELETE_BATCH)
			await tickStep('file sweep', undefined, () => env.JOBS_QUEUE.send({ type: 'file_sweep' }));
		// FN-19: forwarded-mail retention (24 h text, 24 h codes, 90-day ledger) and re-sends of reads whose
		// first enqueue failed.
		const inbound = await tickStep(
			'inbound sweep',
			{ expired: 0, requeued: 0, codesCleared: 0, deleted: 0 },
			async () => {
				const swept = await sweepInboundMail(db, controller.scheduledTime);
				await enqueue(swept.requeue.map((mailId) => ({ type: 'inbound_read', mailId })));
				return {
					expired: swept.expired,
					requeued: swept.requeue.length,
					codesCleared: swept.codesCleared,
					deleted: swept.deleted
				};
			}
		);
		// FN-19 Gmail: listed reads and stalled scan pages re-sent, expiry, retention, expired authorizations and
		// paused connections.
		const gmailSweep = await tickStep(
			'gmail sweep',
			{ expired: 0, requeued: 0, deleted: 0, failedScans: 0, paused: 0 },
			async () => {
				const swept = await sweepGmail(db, controller.scheduledTime);
				await enqueue(swept.requeueReads.map((mailId) => ({ type: 'gmail_read', mailId })));
				await enqueue(swept.stalledScans.map((s) => ({ type: 'gmail_check', ...s })));
				return {
					expired: swept.expired,
					requeued: swept.requeueReads.length + swept.stalledScans.length,
					deleted: swept.deleted,
					failedScans: swept.failedScans,
					paused: swept.paused
				};
			}
		);
		// FN-19 Gmail red team L7 / N4: tokens still sealed under the previous key are re-sealed without Google,
		// paused and needs-reconnect connections included (one bounded batch per tick).
		const gmailResealed = await tickStep('gmail re-seal', 0, () => resealGmailTokens(db, env));
		// FN-19 Gmail red team L3/L4: grants a space purge, an account deletion or a replaced authorization left to
		// revoke at Google, one bounded batch (≤ GMAIL_REVOKE_BATCH calls) per tick.
		const gmailRevocations = await tickStep(
			'gmail revocations',
			{ revoked: 0, dropped: 0, retried: 0 },
			() =>
				processGmailRevocations(
					db,
					env,
					googleClient((url, init) => fetch(url, init)),
					controller.scheduledTime
				)
		);
		// Counts only: never ids or message bodies.
		console.log('jobs: tick', {
			cron: controller.cron,
			gmailResealed,
			at: controller.scheduledTime,
			...counts,
			files,
			inbound,
			gmail: gmailSweep,
			gmailRevocations,
			agent,
			markers,
			authEvents
		});
		// FN-25: prices into KV, then today's net-worth snapshots. Only this Worker calls the price hosts.
		await runNetWorthTick(
			db,
			env.CACHE,
			(url, init) => fetch(url, init),
			Date.now(),
			counted.statements
		);
	}
} satisfies ExportedHandler<Env>;
