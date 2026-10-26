import { addDays } from '#lib/shared/dates';
import { jobMessage, RetryLaterError, type JobMessage } from '#lib/shared/jobs';

type GmailCheck = Extract<JobMessage, { type: 'gmail_check' }>;

export interface QueueMessageLike {
	body: unknown;
	attempts: number;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
}

/** A notification a trigger made or found (FN-24 `createIfAbsent`). */
interface Made {
	id: string;
	created: boolean;
}

export interface JobDeps {
	recordPing(id: string): Promise<void>;
	budgetCheck(spaceId: string): Promise<Made[]>;
	billCheck(spaceId: string): Promise<Made[]>;
	dailyNudge(userId: string, date: string): Promise<Made[]>;
	/** FN-34b: the evening reminder (FN-34b `evaluateCloseReminder`). */
	closeReminder(userId: string, date: string): Promise<Made[]>;
	/** FN-34b: stores the space's budget-streak verdict for the WIB date `date` once (`snapshotBudgetDay`). */
	budgetStreakSnapshot(spaceId: string, date: string): Promise<void>;
	weeklySummary(userId: string, weekStart: string): Promise<Made[]>;
	sendPush(notificationId: string): Promise<void>;
	/**
	 * FN-36: creates the space's instances due on or before the WIB date `date`, within the D1 budget the
	 * invocation's recurring checks share; true when work was left (budget or per-message cap). Throws on a D1
	 * failure (retried).
	 */
	recurringCheck(spaceId: string, date: string): Promise<boolean>;
	/** FN-27: deletes one batch of due R2 objects; true when it was full (more may be due). Throws when R2 fails. */
	fileSweep(): Promise<boolean>;
	/**
	 * FN-19: reads one queued forwarded mail with its owner's AI key (`attempts`: this delivery's count, so the last
	 * one records `ai_failed` instead of retrying). Throws RetryLaterError on a transient provider failure.
	 */
	inboundRead(mailId: string, attempts: number): Promise<void>;
	/**
	 * FN-19 Gmail: lists one page of a scan / reads one listed message. Throw RetryLaterError on throttling or a
	 * transient provider failure; an unknown or finished row or scan is acked (nothing to do).
	 */
	gmailCheck(job: Omit<GmailCheck, 'type'>, attempts: number): Promise<void>;
	gmailRead(mailId: string, attempts: number): Promise<void>;
	/**
	 * FN-23: runs the next step of one Agen report (`attempts`: this delivery's count). Throws for a queue retry
	 * (RetryLaterError for a transient provider failure); a finished, failed, expired or unknown run is acked.
	 */
	agentRun(runId: string, attempts: number): Promise<void>;
	enqueue(messages: JobMessage[]): Promise<void>;
	/** Today's WIB date. */
	today(): string;
}

/**
 * One `send_push` per new notification. A redelivered message (attempts > 1) also re-enqueues rows it found
 * already there: the first delivery may have created them and failed before enqueueing. `send_push` claims
 * every (notification, device) pair, so this never pushes twice to one device.
 */
async function pushNew(deps: JobDeps, made: Made[], attempts: number): Promise<void> {
	const ids = made.filter((m) => m.created || attempts > 1).map((m) => m.id);
	if (ids.length > 0)
		await deps.enqueue(ids.map((notificationId) => ({ type: 'send_push', notificationId })));
}

/**
 * Ack what succeeds; retry what fails. After max_retries the queue moves a message to the DLQ. Never logs bodies.
 * `recurring_check` messages run after every other message of the batch, so their D1 use (bounded by the budget
 * they share, `RECURRING_STATEMENTS_PER_INVOCATION`) can never starve or fail another job of the batch.
 */
export async function handleBatch(
	batch: { messages: readonly QueueMessageLike[] },
	deps: JobDeps
): Promise<void> {
	const jobs: { m: QueueMessageLike; job: JobMessage }[] = [];
	for (const m of batch.messages) {
		const parsed = jobMessage.safeParse(m.body);
		if (!parsed.success) {
			console.warn('jobs: invalid message', { attempts: m.attempts });
			m.retry();
			continue;
		}
		jobs.push({ m, job: parsed.data });
	}
	const last = (j: JobMessage) => (j.type === 'recurring_check' ? 1 : 0);
	for (const { m, job } of jobs.sort((a, b) => last(a.job) - last(b.job))) {
		try {
			switch (job.type) {
				case 'ping':
					await deps.recordPing(job.id);
					break;
				case 'budget_check':
					await pushNew(deps, await deps.budgetCheck(job.spaceId), m.attempts);
					break;
				case 'bill_check':
					await pushNew(deps, await deps.billCheck(job.spaceId), m.attempts);
					break;
				case 'daily_nudge':
					// A nudge processed on a later day (long retry) is stale: dropped, never sent for the wrong day.
					if (job.date === deps.today())
						await pushNew(deps, await deps.dailyNudge(job.userId, job.date), m.attempts);
					break;
				case 'close_reminder':
					// Like the nudge: a reminder processed on a later WIB day is stale and dropped.
					if (job.date === deps.today())
						await pushNew(deps, await deps.closeReminder(job.userId, job.date), m.attempts);
					break;
				case 'budget_streak_snapshot':
					// Only yesterday's verdict, judged with the budget live this morning: a message delayed past the
					// next WIB day is dropped (the day is then a skip, never a break), and a date that is not over yet
					// is never judged.
					if (job.date === addDays(deps.today(), -1))
						await deps.budgetStreakSnapshot(job.spaceId, job.date);
					break;
				case 'weekly_summary':
					await pushNew(deps, await deps.weeklySummary(job.userId, job.weekStart), m.attempts);
					break;
				case 'send_push':
					await deps.sendPush(job.notificationId);
					break;
				case 'recurring_check': {
					// The tick's WIB date, never a later one: a delayed message never creates tomorrow's rows early
					// (a date after today, never sent by the cron, is clamped to today).
					const today = deps.today();
					const date = job.date < today ? job.date : today;
					// Left over (budget spent by this batch, or the per-message cap): a fresh message continues, so
					// this one is acked and never counts toward the DLQ.
					if (await deps.recurringCheck(job.spaceId, date))
						await deps.enqueue([{ type: 'recurring_check', spaceId: job.spaceId, date }]);
					break;
				}
				case 'file_sweep':
					// A full batch means more may be due: one follow-up message (the cron catches the rest).
					if (await deps.fileSweep()) await deps.enqueue([{ type: 'file_sweep' }]);
					break;
				case 'inbound_read':
					await deps.inboundRead(job.mailId, m.attempts);
					break;
				case 'gmail_check':
					await deps.gmailCheck(
						{ connectionId: job.connectionId, kind: job.kind, window: job.window, page: job.page },
						m.attempts
					);
					break;
				case 'gmail_read':
					await deps.gmailRead(job.mailId, m.attempts);
					break;
				case 'agent_run':
					await deps.agentRun(job.runId, m.attempts);
					break;
				default: {
					const unhandled: never = job;
					throw new Error(`unhandled job type: ${String((unhandled as JobMessage).type)}`);
				}
			}
			m.ack();
		} catch (e) {
			console.warn('jobs: handler failed', { type: job.type, attempts: m.attempts });
			if (e instanceof RetryLaterError && e.delaySeconds > 0)
				m.retry({ delaySeconds: e.delaySeconds });
			else m.retry();
		}
	}
}
