import { z } from 'zod';
import { isDateString } from './dates.ts';
import { GMAIL_SCAN_KINDS, GMAIL_SCAN_MAX_PAGES } from './gmail/ledger.ts';

const id = z.string().min(1).max(64);
const date = z.string().refine(isDateString);

/**
 * Every message on JOBS_QUEUE. Add new job types here as a new union member. Messages carry ids (and the WIB
 * date they are for) only, never amounts, names or text: a failed message may be logged or land in the DLQ.
 */
export const jobMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ping'), id }),
	/** FN-24: is this space's month-to-date spending at 80 %/100 % of its budget? */
	z.object({ type: z.literal('budget_check'), spaceId: id }),
	/** FN-26: which of this space's subscriptions are due for a bill reminder today (WIB)? */
	z.object({ type: z.literal('bill_check'), spaceId: id }),
	/** FN-24: "catat hari ini" for `userId` on the WIB date `date` (dropped when processed on another day). */
	z.object({ type: z.literal('daily_nudge'), userId: id, date }),
	/**
	 * FN-34b: the evening "belum ditutup" reminder for `userId` on the WIB date `date` (dropped when processed on
	 * another day; the user's hour and today's closure are checked when it runs).
	 */
	z.object({ type: z.literal('close_reminder'), userId: id, date }),
	/**
	 * FN-34b: store the budget-streak verdict of this space for the WIB date `date` (yesterday when enqueued;
	 * dropped when processed on a later day). Idempotent: one row per space and date, never revised.
	 */
	z.object({ type: z.literal('budget_streak_snapshot'), spaceId: id, date }),
	/** FN-24: last week's spending for `userId`; `weekStart` is the Monday (WIB) of the week it is sent in. */
	z.object({ type: z.literal('weekly_summary'), userId: id, weekStart: date }),
	/** FN-24: push one stored notification to every live device of its recipient. */
	z.object({ type: z.literal('send_push'), notificationId: id }),
	/**
	 * FN-36: create this space's instances due on or before `date`, the WIB day of the tick that enqueued it (a
	 * delayed message never creates the next day's rows early). Idempotent per series and date (dedupe key
	 * `recurring:<series>:<date>`), so a redelivery or an overlapping tick creates nothing twice.
	 */
	z.object({ type: z.literal('recurring_check'), spaceId: id, date }),
	/** FN-27: delete the R2 objects whose deletion is due (file_deletions); no keys on the queue. */
	z.object({ type: z.literal('file_sweep') }),
	/**
	 * FN-19: read one queued forwarded mail (`inbound_mail` row) with its owner's own AI key. The text stays in D1
	 * (at most 24 h); only the row id travels. Idempotent: a row no longer `queued` is acked unread.
	 */
	z.object({ type: z.literal('inbound_read'), mailId: id }),
	/**
	 * FN-19 Gmail: list one page (`page`, from 0) of the scan `window` of this connection (`kind` hourly: the WIB
	 * hour `YYYY-MM-DDTHH`, or the 5-minute bucket of a manual check; lookback: `lb-<ms>`). Idempotent: a page the
	 * scan has already passed is acked unread.
	 */
	z.object({
		type: z.literal('gmail_check'),
		connectionId: id,
		kind: z.enum(GMAIL_SCAN_KINDS),
		window: z.string().min(1).max(40),
		page: z.number().int().min(0).max(GMAIL_SCAN_MAX_PAGES)
	}),
	/** FN-19 Gmail: read one listed Gmail message (`gmail_mail` row). A row no longer `listed` is acked unread. */
	z.object({ type: z.literal('gmail_read'), mailId: id }),
	/**
	 * FN-23 Agen: run the next step of one report (`agent_runs` row). Idempotent: the step is claimed with a lease
	 * and stored by compare-and-set; a finished, failed, expired or unknown run is acked untouched.
	 */
	z.object({ type: z.literal('agent_run'), runId: id })
]);

export type JobMessage = z.infer<typeof jobMessage>;

/** A handler failure the queue should retry no sooner than `delaySeconds` from now (Queues `retry({ delaySeconds })`). */
export class RetryLaterError extends Error {
	// A plain field, not a parameter property: node's type stripping (the owner-run compat scripts) cannot run those.
	readonly delaySeconds: number;
	constructor(message: string, delaySeconds: number) {
		super(message);
		this.delaySeconds = delaySeconds;
	}
}
