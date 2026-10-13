import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
	GMAIL_AI_READS_PER_DAY,
	GMAIL_AI_WINDOW_MS,
	GMAIL_CHECK_OVERLAP_S,
	GMAIL_LISTED_EXPIRE_MS,
	GMAIL_LOOKBACKS_PER_DAY,
	GMAIL_REQUEUE_AFTER_MS,
	GMAIL_REREAD_MAX,
	GMAIL_REREAD_REASONS,
	GMAIL_RETENTION_MS,
	GMAIL_SCAN_STALE_MS,
	GMAIL_UNITS_PER_MINUTE,
	type GmailConnectionStatus,
	type GmailPausedReason,
	type GmailReconnectReason,
	type GmailScanKind,
	type GmailScanStatus
} from '#lib/shared/gmail/ledger';
import type { Db } from '../db';
import {
	gmailConnections,
	gmailMail,
	gmailRevocations,
	gmailScans,
	oauthStates
} from '../db/schema';
import { discardDraftsWhere } from '../drafts/repo';
import type { Sealed } from '../server-seal';
import { isUniqueViolation, newId } from '../util';

const REREAD_REASONS = JSON.stringify(GMAIL_REREAD_REASONS);

/**
 * FN-19 Gmail persistence (PRD § 4–9). Account-level like the forwarding address: every page read and write
 * repeats `user_id = <session user>`, so another user's connection, scan or ledger reads exactly like a missing
 * one. A target space is accepted only while the user is a live member of it, checked inside the write. The
 * sealed token is selected only by the functions that open it (disconnect, the jobs Worker), never into page
 * data. Jobs never write `updated_at` except for a change the user sees (reconnect needed, paused).
 */

/** SQL condition: `user` is a live member of the live space `space` (columns or bound values). */
export const liveMemberOf = (space: SQL, user: SQL) =>
	sql`exists (select 1 from space_members m join spaces s on s.id = m.space_id
		where m.space_id = ${space} and m.user_id = ${user} and m.deleted_at is null and s.deleted_at is null)`;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** The look-back scan the settings page shows (the running one, else the latest). */
export interface ScanView {
	id: string;
	status: GmailScanStatus;
	days: number | null;
	listed: number;
	read: number;
	drafted: number;
	createdAt: number;
	updatedAt: number;
}

/** The user's connection as the settings page may see it: never the token, its nonce or key id. */
export interface ConnectionView {
	id: string;
	status: GmailConnectionStatus;
	reconnectReason: GmailReconnectReason | null;
	pausedReason: GmailPausedReason | null;
	googleAddress: string | null;
	spaceId: string;
	/** Null when the user is no longer a live member of the target space. */
	spaceName: string | null;
	spaceKind: string | null;
	autoCheck: boolean;
	lastCheckedAt: number | null;
	updatedAt: number;
	/** Mail finished (read) and drafts made in the last 7 days. */
	read7d: number;
	drafted7d: number;
	/** Payment mail left unread for a reason the user can fix (no AI key, AI not configured). */
	rereadable: number;
	lookback: ScanView | null;
}

export async function getConnection(
	db: Db,
	userId: string,
	now: number
): Promise<ConnectionView | null> {
	const row = await db.get<Omit<ConnectionView, 'autoCheck' | 'lookback'> & { autoCheck: number }>(
		sql`select c.id, c.status, c.reconnect_reason as reconnectReason, c.paused_reason as pausedReason,
			c.google_address as googleAddress, c.space_id as spaceId,
			(select s.name from spaces s where s.id = c.space_id and ${liveMemberOf(sql`c.space_id`, sql`c.user_id`)}) as spaceName,
			(select s.kind from spaces s where s.id = c.space_id and ${liveMemberOf(sql`c.space_id`, sql`c.user_id`)}) as spaceKind,
			c.auto_check as autoCheck, c.last_checked_at as lastCheckedAt, c.updated_at as updatedAt,
			(select count(*) from gmail_mail m where m.connection_id = c.id and m.status <> 'listed'
				and m.updated_at > ${now - 7 * DAY_MS}) as read7d,
			(select count(*) from gmail_mail m where m.connection_id = c.id and m.status = 'draft_created'
				and m.updated_at > ${now - 7 * DAY_MS}) as drafted7d,
			(select count(*) from gmail_mail m where m.connection_id = c.id and m.status = 'unreadable'
				and m.reason in (select value from json_each(${REREAD_REASONS}))) as rereadable
		from gmail_connections c where c.user_id = ${userId} limit 1`
	);
	if (!row) return null;
	const [lookback] = await db
		.select({
			id: gmailScans.id,
			status: gmailScans.status,
			days: gmailScans.days,
			listed: gmailScans.listed,
			read: gmailScans.read,
			drafted: gmailScans.drafted,
			createdAt: gmailScans.createdAt,
			updatedAt: gmailScans.updatedAt
		})
		.from(gmailScans)
		.where(
			and(
				eq(gmailScans.connectionId, row.id),
				eq(gmailScans.userId, userId),
				eq(gmailScans.kind, 'lookback')
			)
		)
		.orderBy(sql`${gmailScans.status} = 'running' desc`, desc(gmailScans.createdAt))
		.limit(1);
	return { ...row, autoCheck: row.autoCheck === 1, lookback: lookback ?? null };
}

export type ConnectionWriteResult = 'ok' | 'stale' | 'missing';

/** A connection ref from a form: its id and the `updated_at` the page showed. */
export interface ConnectionRef {
	id: string;
	updatedAt: number;
}

const own = (userId: string, ref: ConnectionRef) =>
	and(
		eq(gmailConnections.id, ref.id),
		eq(gmailConnections.userId, userId),
		eq(gmailConnections.updatedAt, ref.updatedAt)
	);

async function missedWrite(db: Db, userId: string, id: string): Promise<'stale' | 'missing'> {
	const row = await db.get<{ id: string }>(
		sql`select id from gmail_connections where id = ${id} and user_id = ${userId}`
	);
	return row ? 'stale' : 'missing';
}

/**
 * "Dicatat ke": new mail goes to `spaceId`, a space the user is a live member of (checked in the write). A
 * connection paused because its space was lost resumes automatic checks.
 */
export async function setConnectionSpace(
	db: Db,
	userId: string,
	ref: ConnectionRef,
	spaceId: string,
	now: number
): Promise<ConnectionWriteResult> {
	const done = await db
		.update(gmailConnections)
		.set({
			spaceId,
			autoCheck: sql`case when ${gmailConnections.pausedReason} = 'space_lost' then 1 else ${gmailConnections.autoCheck} end`,
			pausedReason: null,
			updatedAt: now
		})
		.where(and(own(userId, ref), liveMemberOf(sql`${spaceId}`, sql`${userId}`)))
		.returning({ id: gmailConnections.id });
	return done.length === 1 ? 'ok' : missedWrite(db, userId, ref.id);
}

/** "Periksa otomatis" on or off. Turning it on while the target space is lost is refused (`missing`-like). */
export async function setAutoCheck(
	db: Db,
	userId: string,
	ref: ConnectionRef,
	on: boolean,
	now: number
): Promise<ConnectionWriteResult> {
	const done = await db
		.update(gmailConnections)
		.set({ autoCheck: on ? 1 : 0, updatedAt: now })
		.where(and(own(userId, ref), on ? sql`${gmailConnections.pausedReason} is null` : undefined))
		.returning({ id: gmailConnections.id });
	return done.length === 1 ? 'ok' : missedWrite(db, userId, ref.id);
}

/** The sealed refresh token of the user's connection (for revoking it), or null. Server-only. */
export async function sealedTokenOf(
	db: Db,
	userId: string
): Promise<{ id: string; updatedAt: number; sealed: Sealed } | null> {
	const [row] = await db
		.select({
			id: gmailConnections.id,
			updatedAt: gmailConnections.updatedAt,
			ciphertext: gmailConnections.encryptedToken,
			nonce: gmailConnections.tokenNonce,
			keyId: gmailConnections.tokenKeyId
		})
		.from(gmailConnections)
		.where(eq(gmailConnections.userId, userId))
		.limit(1);
	if (!row) return null;
	return {
		id: row.id,
		updatedAt: row.updatedAt,
		sealed: { ciphertext: row.ciphertext, nonce: row.nonce, keyId: row.keyId }
	};
}

/**
 * Red team L3/L4: copies the sealed refresh token of every connection matching `where` (a condition on
 * `gmail_connections`) into `gmail_revocations`, for the jobs Worker to revoke at Google
 * (`processGmailRevocations`). Runs in the same `db.batch` as the delete or overwrite that would otherwise drop the
 * token while its grant stays live. Idempotent per (connection, seal nonce).
 */
export function queueGmailRevocations(db: Db, where: SQL, now: number) {
	// Columns in table order: connection_id, token_nonce, user_id, google_address, encrypted_token, token_key_id,
	// attempts, created_at.
	return db
		.insert(gmailRevocations)
		.select(
			sql`select id, token_nonce, user_id, google_address, encrypted_token, token_key_id, 0, ${now}
				from gmail_connections where ${where}`
		)
		.onConflictDoNothing();
}

/**
 * The local half of "Putuskan Gmail" (PRD § 8), one `db.batch`: every PENDING draft this connection inserted
 * becomes a content-free tombstone (its dedupe key kept, so the same mail is never recreated), then the ledger,
 * the scans, the user's unfinished authorizations and the connection itself (sealed token included) are deleted.
 * Saved transactions, forwarded-mail drafts and the forwarding ledger are not touched. Bounded by subqueries, no
 * id list is bound. True when the connection row was deleted.
 */
export async function deleteConnection(
	db: Db,
	userId: string,
	connectionId: string,
	now: number
): Promise<boolean> {
	const mine = sql`select id from gmail_connections where id = ${connectionId} and user_id = ${userId}`;
	const drafted = sql`select g.draft_id from gmail_mail g where g.connection_id in (${mine})
		and g.draft_id is not null`;
	const steps = [
		...discardDraftsWhere(db, drafted, now),
		db.delete(gmailMail).where(sql`${gmailMail.connectionId} in (${mine})`),
		db.delete(gmailScans).where(sql`${gmailScans.connectionId} in (${mine})`),
		db.delete(oauthStates).where(eq(oauthStates.userId, userId)),
		db
			.delete(gmailConnections)
			.where(and(eq(gmailConnections.id, connectionId), eq(gmailConnections.userId, userId)))
			.returning({ id: gmailConnections.id })
	] as const;
	const results = await db.batch(steps as unknown as [(typeof steps)[number]]);
	return (results.at(-1) as { id: string }[]).length === 1;
}

// ---- Scans ----------------------------------------------------------------------------------------------------

export type OpenScanResult =
	{ kind: 'opened'; scanId: string } | { kind: 'exists' | 'missing' | 'running' | 'limit' };

/**
 * Opens a scan of the user's CONNECTED connection, idempotent per (connection, kind, window): a second open of the
 * same window is `exists`. A look-back also needs no running look-back (partial unique index; 20 concurrent starts
 * leave one) and fewer than GMAIL_LOOKBACKS_PER_DAY started in the last 24 h. `afterS` null = the hourly default:
 * where the previous check got to, minus the overlap.
 */
export async function openScan(
	db: Db,
	input: {
		userId: string;
		connectionId: string;
		kind: GmailScanKind;
		window: string;
		days: number | null;
		afterS: number | null;
	},
	now: number
): Promise<OpenScanResult> {
	const id = newId();
	const after =
		input.afterS === null
			? sql`max(0, c.checked_through - ${GMAIL_CHECK_OVERLAP_S})`
			: sql`${input.afterS}`;
	const underDailyCap =
		input.kind === 'lookback'
			? sql`and (select count(*) from gmail_scans x where x.connection_id = c.id and x.kind = 'lookback'
					and x.created_at > ${now - DAY_MS}) < ${GMAIL_LOOKBACKS_PER_DAY}`
			: sql``;
	try {
		// Columns in table order: id, connection_id, user_id, kind, window, days, after_s, status, page_token,
		// pages, listed, read, drafted, created_at, updated_at.
		const rows = await db
			.insert(gmailScans)
			.select(
				sql`select ${id}, c.id, c.user_id, ${input.kind}, ${input.window}, ${input.days}, ${after},
					'running', null, 0, 0, 0, 0, ${now}, ${now}
				from gmail_connections c where c.id = ${input.connectionId} and c.user_id = ${input.userId}
					and c.status = 'connected' ${underDailyCap}`
			)
			.onConflictDoNothing()
			.returning({ id: gmailScans.id });
		if (rows.length === 1) return { kind: 'opened', scanId: id };
	} catch (e) {
		if (!isUniqueViolation(e)) throw e;
		return { kind: 'exists' };
	}
	const scan = await db.get<{ id: string }>(sql`select id from gmail_scans
		where connection_id = ${input.connectionId} and user_id = ${input.userId} and kind = ${input.kind}
			and scan_window = ${input.window}`);
	if (scan) return { kind: 'exists' };
	const conn = await db.get<{ running: number }>(sql`select exists (select 1 from gmail_scans x
			where x.connection_id = c.id and x.kind = 'lookback' and x.status = 'running') as running
		from gmail_connections c
		where c.id = ${input.connectionId} and c.user_id = ${input.userId} and c.status = 'connected'`);
	if (!conn || input.kind !== 'lookback') return { kind: 'missing' };
	return { kind: conn.running === 1 ? 'running' : 'limit' };
}

/** Removes a scan that could not be queued (so its window can be opened again). */
export async function dropScan(db: Db, userId: string, scanId: string): Promise<void> {
	await db
		.delete(gmailScans)
		.where(and(eq(gmailScans.id, scanId), eq(gmailScans.userId, userId), eq(gmailScans.pages, 0)));
}

/**
 * "Hentikan": the user's running look-back stops; its ids not read yet are dropped from the ledger (id and date
 * only), so no further read of that scan happens (queued reads find no row and ack).
 */
export async function cancelLookback(
	db: Db,
	userId: string,
	scanId: string,
	now: number
): Promise<boolean> {
	const [cancelled] = await db.batch([
		db
			.update(gmailScans)
			.set({ status: 'cancelled', pageToken: null, updatedAt: now })
			.where(
				and(
					eq(gmailScans.id, scanId),
					eq(gmailScans.userId, userId),
					eq(gmailScans.kind, 'lookback'),
					eq(gmailScans.status, 'running')
				)
			)
			.returning({ id: gmailScans.id }),
		db
			.delete(gmailMail)
			.where(
				and(
					eq(gmailMail.scanId, scanId),
					eq(gmailMail.userId, userId),
					eq(gmailMail.status, 'listed'),
					sql`exists (select 1 from gmail_scans s where s.id = ${scanId} and s.status = 'cancelled')`
				)
			)
	]);
	return cancelled.length === 1;
}

/**
 * "Baca ulang yang tertunda": payment mail left unread for a reason the user fixed (no AI key, AI not configured) or
 * that passed (the daily AI-read cap) goes back to `listed` (id and date only again) for a fresh read from Gmail;
 * at most GMAIL_REREAD_MAX. Returns the row ids to enqueue.
 */
export async function requeueRereadable(db: Db, userId: string, now: number): Promise<string[]> {
	const rows = await db
		.update(gmailMail)
		.set({
			status: 'listed',
			reason: null,
			trust: null,
			parser: null,
			senderDomain: null,
			subject: null,
			updatedAt: now
		})
		.where(
			sql`${gmailMail.id} in (select m.id from gmail_mail m join gmail_connections c on c.id = m.connection_id
				where m.user_id = ${userId} and c.status = 'connected' and m.status = 'unreadable'
					and m.reason in (select value from json_each(${REREAD_REASONS}))
				order by m.updated_at limit ${GMAIL_REREAD_MAX})`
		)
		.returning({ id: gmailMail.id });
	return rows.map((r) => r.id);
}

// ---- Jobs Worker ----------------------------------------------------------------------------------------------

/** The connection row a job works with (sealed token included: jobs open it, pages never see it). */
export interface JobConnection {
	id: string;
	userId: string;
	spaceId: string;
	status: GmailConnectionStatus;
	autoCheck: number;
	checkedThrough: number;
	sealed: Sealed;
	/** The owner is still a live member of the target space. */
	member: number;
}

export async function jobConnection(db: Db, connectionId: string): Promise<JobConnection | null> {
	const row = await db.get<
		Omit<JobConnection, 'sealed'> & Sealed
	>(sql`select c.id, c.user_id as userId,
			c.space_id as spaceId, c.status, c.auto_check as autoCheck, c.checked_through as checkedThrough,
			c.encrypted_token as ciphertext, c.token_nonce as nonce, c.token_key_id as keyId,
			${liveMemberOf(sql`c.space_id`, sql`c.user_id`)} as member
		from gmail_connections c where c.id = ${connectionId}`);
	if (!row) return null;
	const { ciphertext, nonce, keyId, ...rest } = row;
	return { ...rest, sealed: { ciphertext, nonce, keyId } };
}

/** Connections the hourly tick checks: connected, automatic checks on, not held back, owner still a member. */
export async function connectionsDue(
	db: Db,
	now: number,
	afterId: string,
	limit: number
): Promise<string[]> {
	const rows = await db.all<{ id: string }>(sql`select c.id from gmail_connections c
		where c.status = 'connected' and c.auto_check = 1 and c.check_after <= ${now} and c.id > ${afterId}
			and ${liveMemberOf(sql`c.space_id`, sql`c.user_id`)}
		order by c.id limit ${limit}`);
	return rows.map((r) => r.id);
}

/**
 * Spends `units` of the connection's per-minute Gmail budget in one guarded statement: `over` when the budget is
 * spent (the caller retries later), `gone` when the connection is no longer connected (nothing to do). Never
 * touches `updated_at`.
 */
export async function claimQuota(
	db: Db,
	connectionId: string,
	units: number,
	now: number
): Promise<'ok' | 'over' | 'gone'> {
	const expired = sql`quota_window_start <= ${now - MINUTE_MS}`;
	const rows = await db.all<{ id: string }>(sql`update gmail_connections set
			quota_window_start = case when ${expired} then ${now} else quota_window_start end,
			quota_units = case when ${expired} then ${units} else quota_units + ${units} end
		where id = ${connectionId} and status = 'connected'
			and (${expired} or quota_units + ${units} <= ${GMAIL_UNITS_PER_MINUTE})
		returning id`);
	if (rows.length === 1) return 'ok';
	const live = await db.get<{ id: string }>(
		sql`select id from gmail_connections where id = ${connectionId} and status = 'connected'`
	);
	return live ? 'over' : 'gone';
}

/**
 * Counts one AI read against the connection's 24-hour budget (GMAIL_AI_READS_PER_DAY, red team L6) in one guarded
 * statement, so concurrent reads never pass the cap. False when the budget is spent or the connection is gone.
 */
export async function claimAiRead(db: Db, connectionId: string, now: number): Promise<boolean> {
	const expired = sql`ai_window_start <= ${now - GMAIL_AI_WINDOW_MS}`;
	const rows = await db.all<{ id: string }>(sql`update gmail_connections set
			ai_window_start = case when ${expired} then ${now} else ai_window_start end,
			ai_reads = case when ${expired} then 1 else ai_reads + 1 end
		where id = ${connectionId} and status = 'connected'
			and (${expired} or ai_reads < ${GMAIL_AI_READS_PER_DAY})
		returning id`);
	return rows.length === 1;
}

/**
 * Re-seals the connection's refresh token with the current key (red team L7) when it was opened with `_PREVIOUS`,
 * guarded on the nonce it was read with, so a reconnect meanwhile is never overwritten.
 */
export async function resealToken(
	db: Db,
	connectionId: string,
	oldNonce: string,
	sealed: Sealed
): Promise<boolean> {
	// `updated_at` is left alone: nothing the user sees changed, so an open settings form never goes stale.
	const rows = await db.all<{ id: string }>(sql`update gmail_connections set
			encrypted_token = ${sealed.ciphertext}, token_nonce = ${sealed.nonce}, token_key_id = ${sealed.keyId}
		where id = ${connectionId} and token_nonce = ${oldNonce}
		returning id`);
	return rows.length === 1;
}

/** Google refused the refresh token, or it no longer opens: checks stop until the user reconnects. */
export async function markNeedsReconnect(
	db: Db,
	connectionId: string,
	reason: GmailReconnectReason,
	now: number
): Promise<void> {
	await db
		.update(gmailConnections)
		.set({ status: 'needs_reconnect', reconnectReason: reason, updatedAt: now })
		.where(and(eq(gmailConnections.id, connectionId), eq(gmailConnections.status, 'connected')));
}

/** The owner left the target space: automatic checks pause until a new "Dicatat ke" is chosen. */
export async function pauseSpaceLost(db: Db, connectionId: string, now: number): Promise<void> {
	await db
		.update(gmailConnections)
		.set({ autoCheck: 0, pausedReason: 'space_lost', updatedAt: now })
		.where(
			and(
				eq(gmailConnections.id, connectionId),
				sql`not ${liveMemberOf(sql`${gmailConnections.spaceId}`, sql`${gmailConnections.userId}`)}`
			)
		);
}

/** Google throttled this connection: the hourly fan-out skips it until `until`. */
export async function holdConnection(db: Db, connectionId: string, until: number): Promise<void> {
	await db
		.update(gmailConnections)
		.set({ checkAfter: sql`max(${gmailConnections.checkAfter}, ${until})` })
		.where(eq(gmailConnections.id, connectionId));
}

/** The scan a `gmail_check` message names, while it belongs to that connection. */
export async function scanOf(db: Db, connectionId: string, kind: GmailScanKind, window: string) {
	const [row] = await db
		.select()
		.from(gmailScans)
		.where(
			and(
				eq(gmailScans.connectionId, connectionId),
				eq(gmailScans.kind, kind),
				eq(gmailScans.window, window)
			)
		)
		.limit(1);
	return row ?? null;
}

export interface GmailSweep {
	expired: number;
	failedScans: number;
	deleted: number;
	states: number;
	paused: number;
	requeueReads: string[];
	stalledScans: { connectionId: string; kind: GmailScanKind; window: string; page: number }[];
}

const SWEEP_BATCH = 200;
const REQUEUE_BATCH = 100;

/**
 * The hourly Gmail sweep (PRD § 5.3), each step one bounded statement: listed rows older than 48 h become
 * `unreadable/expired`; scans running for over 6 h become `failed`; ledger rows older than 90 days are deleted;
 * expired authorizations are deleted; connections whose owner left the target space are paused; and, for
 * re-enqueueing, listed rows of connected connections untouched for 15 min and running scans whose next page was
 * not picked up within 15 min.
 */
export async function sweepGmail(db: Db, now: number): Promise<GmailSweep> {
	const among = (where: SQL) =>
		sql`${gmailMail.id} in (select id from gmail_mail where ${where} order by updated_at limit ${SWEEP_BATCH})`;
	const [expired, failed, deleted, states, paused, reads, scans] = await db.batch([
		db
			.update(gmailMail)
			.set({ status: 'unreadable', reason: 'expired', updatedAt: now })
			.where(among(sql`status = 'listed' and updated_at < ${now - GMAIL_LISTED_EXPIRE_MS}`))
			.returning({ id: gmailMail.id }),
		db
			.update(gmailScans)
			.set({ status: 'failed', pageToken: null, updatedAt: now })
			.where(
				sql`${gmailScans.id} in (select id from gmail_scans where status = 'running'
					and created_at < ${now - GMAIL_SCAN_STALE_MS} order by created_at limit ${SWEEP_BATCH})`
			)
			.returning({ id: gmailScans.id }),
		db
			.delete(gmailMail)
			// A row still pointing at a pending draft stays (red team L1): it is how "Putuskan Gmail" and account
			// deletion find the drafts this connection inserted, however long they wait in Kotak masuk.
			.where(
				among(sql`updated_at < ${now - GMAIL_RETENTION_MS} and (draft_id is null or not exists
					(select 1 from drafts d where d.id = gmail_mail.draft_id and d.deleted_at is null))`)
			)
			.returning({ id: gmailMail.id }),
		db
			.delete(oauthStates)
			.where(
				sql`${oauthStates.stateHash} in (select state_hash from oauth_states where expires_at <= ${now}
					order by expires_at limit ${SWEEP_BATCH})`
			)
			.returning({ id: oauthStates.stateHash }),
		db
			.update(gmailConnections)
			.set({ autoCheck: 0, pausedReason: 'space_lost', updatedAt: now })
			.where(
				sql`${gmailConnections.id} in (select c.id from gmail_connections c where c.auto_check = 1
					and not ${liveMemberOf(sql`c.space_id`, sql`c.user_id`)} order by c.id limit ${SWEEP_BATCH})`
			)
			.returning({ id: gmailConnections.id }),
		db
			.select({ id: gmailMail.id })
			.from(gmailMail)
			.innerJoin(gmailConnections, eq(gmailConnections.id, gmailMail.connectionId))
			.where(
				sql`${gmailMail.status} = 'listed' and ${gmailMail.updatedAt} < ${now - GMAIL_REQUEUE_AFTER_MS}
					and ${gmailMail.updatedAt} >= ${now - GMAIL_LISTED_EXPIRE_MS} and ${gmailConnections.status} = 'connected'`
			)
			.orderBy(gmailMail.updatedAt)
			.limit(REQUEUE_BATCH),
		db
			.select({
				connectionId: gmailScans.connectionId,
				kind: gmailScans.kind,
				window: gmailScans.window,
				page: gmailScans.pages
			})
			.from(gmailScans)
			.innerJoin(gmailConnections, eq(gmailConnections.id, gmailScans.connectionId))
			.where(
				sql`${gmailScans.status} = 'running' and ${gmailScans.updatedAt} < ${now - GMAIL_REQUEUE_AFTER_MS}
					and ${gmailScans.createdAt} >= ${now - GMAIL_SCAN_STALE_MS} and ${gmailConnections.status} = 'connected'`
			)
			.orderBy(gmailScans.updatedAt)
			.limit(REQUEUE_BATCH)
	]);
	return {
		expired: expired.length,
		failedScans: failed.length,
		deleted: deleted.length,
		states: states.length,
		paused: paused.length,
		requeueReads: reads.map((r) => r.id),
		stalledScans: scans
	};
}
