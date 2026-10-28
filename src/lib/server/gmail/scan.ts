import { and, eq, sql } from 'drizzle-orm';
import { gmailBackoffSeconds } from '#lib/shared/gmail/backoff';
import {
	GMAIL_PAGE_SIZE,
	GMAIL_SCAN_MAX_IDS,
	GMAIL_SCAN_MAX_PAGES,
	GMAIL_UNITS,
	type GmailScanKind
} from '#lib/shared/gmail/ledger';
import { gmailQuery } from '#lib/shared/gmail/query';
import { RetryLaterError, type JobMessage } from '#lib/shared/jobs';
import { gmailLookbackMaxDays, planOf } from '../billing/gate';
import { gmailConnections, gmailMail, gmailScans } from '../db/schema';
import type { GoogleFailure } from './google';
import {
	claimQuota,
	holdConnection,
	jobConnection,
	openScan,
	pauseSpaceLost,
	scanOf,
	type JobConnection
} from './repo';
import { accessTokenFor, forgetAccessToken, type TokenDeps } from './token';

/**
 * The jobs Worker's `gmail_check` (FN-19 Gmail PRD § 5): one page of one scan per message, ids only. The scan's
 * `pages` is the page the next message must carry, so a repeated tick, a redelivered message or a duplicate page
 * message lists nothing twice (a duplicate is acked unread); new Gmail ids go into the ledger as `listed` with
 * INSERT … ON CONFLICT DO NOTHING (unique per connection and Gmail id) and one `gmail_read` each is enqueued.
 * `checked_through` advances only once the last page of an hourly scan is done. Quota-gated per connection;
 * Google's throttling backs off (and holds the connection out of the hourly fan-out); log lines carry counts and
 * status codes only.
 */

export interface GmailJobDeps extends TokenDeps {
	enqueue(messages: JobMessage[]): Promise<void>;
	/** [0, 1): the jitter of a backoff and of a quota wait. */
	random(): number;
}

export interface GmailCheckJob {
	connectionId: string;
	kind: GmailScanKind;
	window: string;
	page: number;
}

const DAY_S = 24 * 60 * 60;

/** Seconds a call over the per-minute quota waits (spread so a backlog does not retry in lockstep). */
export const quotaWait = (random: number) =>
	30 + Math.floor(Math.min(Math.max(random, 0), 0.999) * 30);

/** A cron window (`YYYY-MM-DDTHH`) as opposed to the 5-minute bucket of "Periksa sekarang" (with minutes). */
const isCronWindow = (window: string) => !window.includes(':');

/**
 * The failure of a Gmail call as the queue sees it: throttling holds the connection and retries with Gmail's
 * backoff; a server or network failure retries with it; anything else is `final` (the caller gives up that item).
 */
export async function onGoogleFailure(
	deps: GmailJobDeps,
	conn: JobConnection,
	error: GoogleFailure,
	attempts: number
): Promise<'final'> {
	const delay = gmailBackoffSeconds(Math.max(0, attempts - 1), deps.random());
	if (error === 'rate') {
		await holdConnection(deps.db, conn.id, deps.now() + delay * 1000);
		throw new RetryLaterError('gmail: rate limited', delay);
	}
	if (error === 'server' || error === 'auth')
		throw new RetryLaterError('gmail: provider unavailable', delay);
	return 'final';
}

async function failScan(deps: GmailJobDeps, scanId: string): Promise<void> {
	await deps.db
		.update(gmailScans)
		.set({ status: 'failed', pageToken: null, updatedAt: deps.now() })
		.where(and(eq(gmailScans.id, scanId), eq(gmailScans.status, 'running')));
}

export async function processGmailCheck(
	deps: GmailJobDeps,
	job: GmailCheckJob,
	attempts: number
): Promise<'listed' | 'done' | 'skipped'> {
	const { db } = deps;
	const conn = await jobConnection(db, job.connectionId);
	if (!conn || conn.status !== 'connected') return 'skipped';
	if (conn.member !== 1) {
		await pauseSpaceLost(db, conn.id, deps.now());
		return 'skipped';
	}
	if (job.kind === 'hourly') {
		// Turning "Periksa otomatis" off stops the hourly checks already queued too (a manual check still runs).
		if (isCronWindow(job.window) && conn.autoCheck !== 1) return 'skipped';
		if (job.page === 0)
			await openScan(
				db,
				{
					userId: conn.userId,
					connectionId: conn.id,
					kind: 'hourly',
					window: job.window,
					days: null,
					afterS: null
				},
				deps.now()
			);
	}
	let scan = await scanOf(db, conn.id, job.kind, job.window);
	if (!scan || scan.status !== 'running' || scan.pages !== job.page) return 'skipped';

	if (scan.kind === 'lookback' && scan.pages === 0 && scan.days !== null) {
		// The plan is read again here: a plan that lapsed since the click reads no further than it now allows.
		const max = gmailLookbackMaxDays(await planOf(db, conn.userId, deps.now()));
		if (scan.days > max) {
			const afterS = Math.floor(scan.createdAt / 1000) - max * DAY_S;
			await db
				.update(gmailScans)
				.set({ days: max, afterS })
				.where(and(eq(gmailScans.id, scan.id), eq(gmailScans.pages, 0)));
			scan = { ...scan, days: max, afterS };
		}
	}

	const quota = await claimQuota(db, conn.id, GMAIL_UNITS.list, deps.now());
	if (quota === 'gone') return 'skipped';
	if (quota === 'over') throw new RetryLaterError('gmail: over quota', quotaWait(deps.random()));
	let token = await accessTokenFor(deps, conn);
	if (token === null) {
		await failScan(deps, scan.id);
		return 'skipped';
	}
	const input = {
		q: gmailQuery(scan.afterS),
		pageToken: scan.pageToken,
		maxResults: GMAIL_PAGE_SIZE
	};
	let page = await deps.google.list(token, input);
	if (!page.ok && page.error === 'auth') {
		forgetAccessToken(deps, conn);
		token = await accessTokenFor(deps, conn);
		if (token === null) {
			await failScan(deps, scan.id);
			return 'skipped';
		}
		page = await deps.google.list(token, input);
	}
	if (!page.ok) {
		await onGoogleFailure(deps, conn, page.error, attempts);
		await failScan(deps, scan.id);
		return 'skipped';
	}

	const now = deps.now();
	const room = Math.max(0, GMAIL_SCAN_MAX_IDS - scan.listed);
	const ids = page.ids.slice(0, room);
	const done =
		page.nextPageToken === null ||
		scan.pages + 1 >= GMAIL_SCAN_MAX_PAGES ||
		page.ids.length > room ||
		scan.listed + ids.length >= GMAIL_SCAN_MAX_IDS;
	const [inserted, advanced] = await db.batch([
		// Columns in table order: id, connection_id, user_id, space_id, gmail_id, received_at, status, reason,
		// trust, parser, sender_domain, subject, draft_id, scan_id, updated_at, reread_at (FN-19b).
		db
			.insert(gmailMail)
			.select(
				sql`select lower(hex(randomblob(16))), c.id, c.user_id, c.space_id, j.value, ${now}, 'listed',
					null, null, null, null, null, null, ${scan.id}, ${now}, null
				from json_each(${JSON.stringify(ids)}) j join gmail_connections c on c.id = ${conn.id}
				where c.status = 'connected'`
			)
			.onConflictDoNothing({ target: [gmailMail.connectionId, gmailMail.gmailId] })
			.returning({ id: gmailMail.id }),
		db
			.update(gmailScans)
			.set({
				pages: sql`${gmailScans.pages} + 1`,
				pageToken: done ? null : page.nextPageToken,
				listed: sql`(select count(*) from gmail_mail m where m.scan_id = ${scan.id})`,
				status: done ? 'done' : 'running',
				updatedAt: now
			})
			.where(
				and(
					eq(gmailScans.id, scan.id),
					eq(gmailScans.pages, job.page),
					eq(gmailScans.status, 'running')
				)
			)
			.returning({ id: gmailScans.id })
	]);
	// Another delivery of this page got there first: it enqueues the reads and the next page.
	if (advanced.length === 0) return 'skipped';
	if (done && scan.kind === 'hourly')
		await db
			.update(gmailConnections)
			.set({
				checkedThrough: sql`max(${gmailConnections.checkedThrough}, ${Math.floor(scan.createdAt / 1000)})`,
				lastCheckedAt: now
			})
			.where(eq(gmailConnections.id, conn.id));
	const messages: JobMessage[] = inserted.map((r) => ({ type: 'gmail_read', mailId: r.id }));
	if (messages.length > 0) await deps.enqueue(messages);
	if (!done)
		await deps.enqueue([
			{
				type: 'gmail_check',
				connectionId: conn.id,
				kind: scan.kind,
				window: scan.window,
				page: job.page + 1
			}
		]);
	return done ? 'done' : 'listed';
}
