import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
	INBOUND_HOLD_MS,
	INBOUND_RATE_PER_HOUR,
	INBOUND_RATE_WINDOW_MS,
	INBOUND_RETENTION_MS,
	newLocalPart,
	REPROCESSABLE_REASONS,
	type InboundMailReason,
	type InboundMailStatus,
	type InboundParser,
	type InboundTrust
} from '#lib/shared/inbound/address';
import type { Db } from '../db';
import { inboundAddresses, inboundMail } from '../db/schema';
import { isUniqueViolation, newId } from '../util';

// FN-19 e-mail forwarding. Address rows are addressed by (session user, id from the form): every write repeats
// `user_id = <session user>`, so another user's id reads exactly like a missing one. A space id from the form is
// admitted by requireSpaceAccess first and repeated as a live membership inside the write. The local part (a
// bearer secret) is never logged by anything here.

/** SQL condition: the user `user` is a live member of the live space `space` (each a column or a bound value). */
const liveMemberOf = (space: SQL, user: SQL) =>
	sql`exists (select 1 from space_members m join spaces s on s.id = m.space_id
		where m.space_id = ${space} and m.user_id = ${user} and m.deleted_at is null and s.deleted_at is null)`;

/** Address changes (create, rotate) per user per throttle window: each issues a never-reused address row. */
export const ADDRESS_CHANGES_PER_WINDOW = 10;

/** The user's active address as the settings page shows it. */
export interface ActiveAddress {
	id: string;
	localPart: string;
	spaceId: string;
	/** Null when the user is no longer a live member of the target space (mail is then refused). */
	spaceName: string | null;
	lastReceivedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export async function getActiveAddress(db: Db, userId: string): Promise<ActiveAddress | null> {
	const row =
		await db.get<ActiveAddress>(sql`select a.id, a.local_part as localPart, a.space_id as spaceId,
			(select s.name from spaces s where s.id = a.space_id and ${liveMemberOf(sql`a.space_id`, sql`${userId}`)}) as spaceName,
			a.last_received_at as lastReceivedAt, a.created_at as createdAt, a.updated_at as updatedAt
		from inbound_addresses a where a.user_id = ${userId} and a.status = 'active' limit 1`);
	return row ?? null;
}

export type CreateAddressResult = 'created' | 'exists' | 'space';

/**
 * "Buat alamat": one active address for the user, pointing at `spaceId` (already admitted by
 * requireSpaceAccess, repeated here). The partial unique index makes concurrent creates leave one row.
 */
export async function createAddress(
	db: Db,
	userId: string,
	spaceId: string,
	now: number
): Promise<CreateAddressResult> {
	try {
		const inserted = await db.all<{ id: string }>(sql`insert into inbound_addresses
				(id, user_id, space_id, local_part, status, window_start, window_count, created_at, updated_at)
			select ${newId()}, ${userId}, ${spaceId}, ${newLocalPart()}, 'active', ${now}, 0, ${now}, ${now}
			where ${liveMemberOf(sql`${spaceId}`, sql`${userId}`)}
				and not exists (select 1 from inbound_addresses x where x.user_id = ${userId} and x.status = 'active')
			returning id`);
		if (inserted.length === 1) return 'created';
	} catch (e) {
		if (!isUniqueViolation(e)) throw e;
		return 'exists';
	}
	return (await getActiveAddress(db, userId)) ? 'exists' : 'space';
}

export type AddressWriteResult = 'ok' | 'stale' | 'missing';

/** The result of a guarded write that touched nothing: `stale` when the row is still the user's active one. */
async function missedWrite(db: Db, userId: string, id: string): Promise<'stale' | 'missing'> {
	const active = await getActiveAddress(db, userId);
	return active?.id === id ? 'stale' : 'missing';
}

const own = (userId: string, id: string, updatedAt: number) =>
	and(
		eq(inboundAddresses.id, id),
		eq(inboundAddresses.userId, userId),
		eq(inboundAddresses.status, 'active'),
		eq(inboundAddresses.updatedAt, updatedAt)
	);

/** "Matikan": the address stops at once; its local part is never issued again. */
export async function revokeAddress(
	db: Db,
	userId: string,
	ref: { id: string; updatedAt: number },
	now: number
): Promise<AddressWriteResult> {
	const done = await db
		.update(inboundAddresses)
		.set({ status: 'revoked', revokedAt: now, updatedAt: now })
		.where(own(userId, ref.id, ref.updatedAt))
		.returning({ id: inboundAddresses.id });
	return done.length === 1 ? 'ok' : missedWrite(db, userId, ref.id);
}

/**
 * "Putar ulang alamat": the old address is revoked and a new one for the same space is issued, in one
 * `db.batch` (one D1 transaction): the old one stops at the same moment the new one starts.
 */
export async function rotateAddress(
	db: Db,
	userId: string,
	ref: { id: string; updatedAt: number },
	now: number
): Promise<AddressWriteResult> {
	const [revoked] = await db.batch([
		db
			.update(inboundAddresses)
			.set({ status: 'revoked', revokedAt: now, updatedAt: now })
			.where(own(userId, ref.id, ref.updatedAt))
			.returning({ id: inboundAddresses.id }),
		// Columns in table order: id, user_id, space_id, local_part, status, window_start, window_count,
		// last_received_at, created_at, updated_at, revoked_at.
		db.insert(inboundAddresses).select(
			sql`select ${newId()}, ${userId}, o.space_id, ${newLocalPart()}, 'active', ${now}, 0, null,
				${now}, ${now}, null
			from inbound_addresses o where o.id = ${ref.id} and o.user_id = ${userId}
				and o.status = 'revoked' and o.revoked_at = ${now} and o.updated_at = ${now}`
		)
	]);
	return revoked.length === 1 ? 'ok' : missedWrite(db, userId, ref.id);
}

/** "Dicatat ke": the space new mail is recorded in, one the user is a live member of (checked in the write). */
export async function setAddressSpace(
	db: Db,
	userId: string,
	ref: { id: string; updatedAt: number },
	spaceId: string,
	now: number
): Promise<AddressWriteResult> {
	const done = await db
		.update(inboundAddresses)
		.set({ spaceId, updatedAt: now })
		.where(and(own(userId, ref.id, ref.updatedAt), liveMemberOf(sql`${spaceId}`, sql`${userId}`)))
		.returning({ id: inboundAddresses.id });
	return done.length === 1 ? 'ok' : missedWrite(db, userId, ref.id);
}

/** One ledger row as the settings page lists it: status and reason codes; a subject only for payment mail. */
export interface MailView {
	id: string;
	receivedAt: number;
	status: InboundMailStatus;
	reason: InboundMailReason | null;
	trust: InboundTrust | null;
	subject: string | null;
	/** Only on a `confirmation` row younger than 24 h. */
	confirmationCode: string | null;
}

const MAIL_LIST_MAX = 20;

/** The user's most recent mail (their own rows only), newest first, at most MAIL_LIST_MAX. */
export async function listRecentMail(db: Db, userId: string, now: number): Promise<MailView[]> {
	return db
		.select({
			id: inboundMail.id,
			receivedAt: inboundMail.receivedAt,
			status: inboundMail.status,
			reason: inboundMail.reason,
			trust: inboundMail.trust,
			subject: inboundMail.subject,
			confirmationCode: sql<
				string | null
			>`case when ${inboundMail.receivedAt} > ${now - INBOUND_HOLD_MS} then ${inboundMail.confirmationCode} end`
		})
		.from(inboundMail)
		.where(eq(inboundMail.userId, userId))
		.orderBy(desc(inboundMail.receivedAt), desc(inboundMail.id))
		.limit(MAIL_LIST_MAX);
}

// ---- Inbound Worker -------------------------------------------------------------------------------------------

/** Who a mail is for: an active address whose owner is still a live member of its space. */
export interface Recipient {
	addressId: string;
	userId: string;
	spaceId: string;
	ownerEmail: string;
}

/** Unknown, revoked and owner-removed addresses all give null (the Worker answers them identically). */
export async function findRecipient(db: Db, localPart: string): Promise<Recipient | null> {
	const row = await db.get<Recipient>(sql`select a.id as addressId, a.user_id as userId,
			a.space_id as spaceId, u.email as ownerEmail
		from inbound_addresses a join users u on u.id = a.user_id
		where a.local_part = ${localPart} and a.status = 'active' and ${liveMemberOf(sql`a.space_id`, sql`a.user_id`)}
		limit 1`);
	return row ?? null;
}

/**
 * Counts one mail against the address's hourly budget in one guarded statement (owner decision 5). False when
 * the budget is spent (the mail is dropped). `updated_at` is left alone so an open settings form never goes stale.
 */
export async function claimRateSlot(db: Db, addressId: string, now: number): Promise<boolean> {
	const expired = sql`window_start <= ${now - INBOUND_RATE_WINDOW_MS}`;
	const rows = await db.all<{ id: string }>(sql`update inbound_addresses set
			window_start = case when ${expired} then ${now} else window_start end,
			window_count = case when ${expired} then 1 else window_count + 1 end,
			last_received_at = ${now}
		where id = ${addressId} and status = 'active'
			and (${expired} or window_count < ${INBOUND_RATE_PER_HOUR})
		returning id`);
	return rows.length === 1;
}

/** One ledger row to record (only the columns its status allows; the schema CHECKs enforce the rest). */
export interface MailRecord {
	recipient: Recipient;
	messageKey: string;
	receivedAt: number;
	status: InboundMailStatus;
	reason?: InboundMailReason | null;
	trust?: InboundTrust | null;
	parser?: InboundParser | null;
	senderDomain?: string | null;
	subject?: string | null;
	pendingText?: string | null;
	confirmationCode?: string | null;
}

/**
 * The upsert recording `r`, idempotent per (address, message key): a repeat of a mail already recorded writes
 * nothing — except a mail left `unreadable` for a reason the user can fix (no AI key, AI not configured), which
 * is reprocessed (PRD § 4.8). `computed` decides status and reason in SQL inside the same batch (draft.ts).
 */
export function upsertMail(
	db: Db,
	r: MailRecord,
	computed?: { status: SQL; reason: SQL; draftId: SQL }
) {
	const status = computed?.status ?? sql`${r.status}`;
	const reason = computed?.reason ?? sql`${r.reason ?? null}`;
	const draftId = computed?.draftId ?? sql`null`;
	const reprocessable = sql.join(
		REPROCESSABLE_REASONS.map((x) => sql`${x}`),
		sql`, `
	);
	const excluded = (column: string) => sql.raw(`excluded.${column}`);
	// Columns in table order: id, space_id, address_id, user_id, message_key, received_at, status, reason, trust,
	// parser, sender_domain, subject, pending_text, confirmation_code, updated_at, draft_id. `where 1`: SQLite needs
	// a WHERE on an INSERT … SELECT before ON CONFLICT.
	return db
		.insert(inboundMail)
		.select(
			sql`select ${newId()}, ${r.recipient.spaceId}, ${r.recipient.addressId}, ${r.recipient.userId},
				${r.messageKey}, ${r.receivedAt}, ${status}, ${reason}, ${r.trust ?? null}, ${r.parser ?? null},
				${r.senderDomain ?? null}, ${r.subject ?? null}, ${r.pendingText ?? null},
				${r.confirmationCode ?? null}, ${r.receivedAt}, ${draftId} where 1`
		)
		.onConflictDoUpdate({
			target: [inboundMail.addressId, inboundMail.messageKey],
			set: {
				spaceId: excluded('space_id'),
				receivedAt: excluded('received_at'),
				status: excluded('status'),
				reason: excluded('reason'),
				trust: excluded('trust'),
				parser: excluded('parser'),
				senderDomain: excluded('sender_domain'),
				subject: excluded('subject'),
				pendingText: excluded('pending_text'),
				confirmationCode: excluded('confirmation_code'),
				updatedAt: excluded('updated_at'),
				draftId: excluded('draft_id')
			},
			setWhere: sql`${inboundMail.status} = 'unreadable' and ${inboundMail.reason} in (${reprocessable})`
		})
		.returning({ id: inboundMail.id });
}

/** Records `r`; the row id when this delivery wrote it (new or reprocessed), null for a repeat. */
export async function recordMail(db: Db, r: MailRecord): Promise<string | null> {
	const rows = await upsertMail(db, r);
	return rows[0]?.id ?? null;
}

/** Whether the user has a stored Anthropic key (existence only; nothing is opened here). */
export async function hasAnthropicKey(db: Db, userId: string): Promise<boolean> {
	const row = await db.get<{ one: number }>(
		sql`select 1 as one from ai_keys where user_id = ${userId} and provider = 'anthropic' limit 1`
	);
	return row !== undefined && row !== null;
}

// ---- Jobs Worker: sweep ---------------------------------------------------------------------------------------

/** Rows one sweep step touches per tick. */
export const INBOUND_SWEEP_BATCH = 200;
/** Most reads re-sent per tick (one Queues `sendBatch` holds at most 100 messages). */
const INBOUND_REQUEUE_BATCH = 100;
/** A queued read older than this is sent to the queue again (its first send may have failed). */
const INBOUND_REQUEUE_AFTER_MS = 10 * 60 * 1000;

export interface InboundSweep {
	expired: number;
	requeue: string[];
	codesCleared: number;
	deleted: number;
}

/**
 * The hourly retention sweep (PRD § 8), each step one bounded statement: (a) queued reads older than 24 h lose
 * their text and become `unreadable/expired`; (b) queued reads older than 10 min are returned for re-enqueueing;
 * (c) confirmation codes older than 24 h are cleared; (d) rows older than 90 days are deleted.
 */
export async function sweepInboundMail(db: Db, now: number): Promise<InboundSweep> {
	const hold = now - INBOUND_HOLD_MS;
	const batch = (where: SQL) =>
		sql`(select id from inbound_mail where ${where} order by received_at limit ${INBOUND_SWEEP_BATCH})`;
	const among = (where: SQL) => sql`${inboundMail.id} in ${batch(where)}`;
	const [expired, codes, deleted, requeue] = await db.batch([
		db
			.update(inboundMail)
			.set({ status: 'unreadable', reason: 'expired', pendingText: null, updatedAt: now })
			.where(among(sql`status = 'queued' and received_at < ${hold}`))
			.returning({ id: inboundMail.id }),
		db
			.update(inboundMail)
			.set({ confirmationCode: null, updatedAt: now })
			.where(among(sql`confirmation_code is not null and received_at < ${hold}`))
			.returning({ id: inboundMail.id }),
		db
			.delete(inboundMail)
			// A row still pointing at a pending draft stays (Gmail red team L2): account deletion finds the account's
			// pending forwarded drafts through it.
			.where(
				among(sql`received_at < ${now - INBOUND_RETENTION_MS} and (draft_id is null or not exists
					(select 1 from drafts d where d.id = inbound_mail.draft_id and d.deleted_at is null))`)
			)
			.returning({ id: inboundMail.id }),
		db
			.select({ id: inboundMail.id })
			.from(inboundMail)
			.where(
				and(
					eq(inboundMail.status, 'queued'),
					sql`${inboundMail.receivedAt} < ${now - INBOUND_REQUEUE_AFTER_MS}`
				)
			)
			.orderBy(inboundMail.receivedAt)
			.limit(INBOUND_REQUEUE_BATCH)
	]);
	return {
		expired: expired.length,
		codesCleared: codes.length,
		deleted: deleted.length,
		requeue: requeue.map((r) => r.id)
	};
}
