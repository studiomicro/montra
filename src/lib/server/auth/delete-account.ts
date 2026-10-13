import { and, eq, exists, isNull, notExists, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db';
import {
	accountKeys,
	agentRuns,
	aiKeyAudit,
	aiKeys,
	apiTokens,
	authEvents,
	claimMarkers,
	consentRecords,
	dayClosures,
	featureFlags,
	gmailConnections,
	gmailMail,
	gmailScans,
	inboundAddresses,
	inboundMail,
	notificationDeliveries,
	notificationPrefs,
	oauthStates,
	passkeyChallenges,
	passkeySessions,
	passkeys,
	pushSubscriptions,
	sessions,
	spaceMembers,
	spaceNotifications,
	spaces,
	tanyaMessages,
	usageStatsPrefs,
	userNotifications,
	userPasswords,
	userPlanState,
	users,
	voucherRedemptions
} from '../db/schema';
import { releaseAgentKeys } from '../agent/keys';
import { autoDisconnectItems } from '../connected-apps/repo';
import { discardDraftsWhere } from '../drafts/repo';
import { queueGmailRevocations } from '../gmail/repo';
import { purgeSpaces, sharedSpaceHandOver } from '../spaces/spaces';

/**
 * Deletes an account and what MONTRA holds about it, in one `db.batch` (one D1 transaction), every
 * statement guarded on `provenHash`: the stored password hash the user has just re-entered
 * (`signInWithPassword`). If the credential is no longer that hash, nothing is deleted.
 *
 * Order (foreign keys are enforced): shared spaces with other live members are handed over
 * (`sharedSpaceHandOver`: the longest-standing live member becomes owner), every space this user is the last
 * live member of (the personal one included) is deleted (the user's connected apps end first, FN-29) with all its rows (`purgeSpaces`), then the user's remaining memberships (shared spaces stay for the other members), sessions, API tokens (FN-38), push subscriptions, feature flags, notifications (FN-24), the
 * account key, the plan state (FN-30) and, with `claimHash`, the re-claim markers (billing/claims.ts), consent records and the statistics switch (FN-31), the closed days (FN-34), the credential, and
 * finally the user row, which goes only once the credential did.
 * FN-30's append-only history (credit_ledger, billing_events, voucher_redemptions, plan_changes) stays with
 * `user_id` set to null by the user row's delete (FK `on delete set null`): content-free of the person,
 * unreachable by any route, and a used voucher stays used. Invites the user created
 * cascade with the user row; audit rows elsewhere keep the event with the user reference set to null.
 *
 * Photos (R2) of the purged spaces are left in the file-deletion outbox, due now: the caller runs
 * `sweepSoon` (photos/store.ts) after a successful deletion, and the jobs Worker sweeps whatever that misses.
 *
 * The one deletion path: the public /hapus-akun page must call this too once it is wired to real deletion
 * (PRD FN-01 criterion 22). Returns false when the proof no longer held and nothing was deleted.
 */
export async function deleteAccount(
	db: Db,
	userId: string,
	provenHash: string,
	now: number = Date.now(),
	claimHash: string | null = null
): Promise<boolean> {
	const proof = exists(
		db
			.select({ one: sql`1` })
			.from(userPasswords)
			.where(and(eq(userPasswords.userId, userId), eq(userPasswords.hash, provenHash)))
	);
	// A member who left or was removed (FN-03 tombstone) no longer keeps a space alive.
	const noOtherLiveMember = (spaceId: SQL) =>
		sql`not exists (select 1 from space_members o where o.space_id = ${spaceId}
			and o.user_id <> ${userId} and o.deleted_at is null)`;
	// The spaces this user is the last live member of (the personal one, and shared ones nobody else is left
	// in) are deleted with everything in them. They are chosen inside the batch, never read before it: a space
	// created between a read and the batch would otherwise lose its only member and survive memberless (FN-03
	// N1). The first purge step marks them (`deleted_at = now`, guarded on the proof); every later step selects
	// the marked spaces, since the purge deletes the memberships the choice is made from. The batch is one D1
	// transaction, so no other request ever sees the mark.
	const lastMemberOf = sql`select m.space_id from space_members m
		where m.user_id = ${userId} and m.deleted_at is null and ${noOtherLiveMember(sql`m.space_id`)}`;
	const markPurged = db
		.update(spaces)
		.set({ deletedAt: now, updatedAt: now })
		.where(and(proof, isNull(spaces.deletedAt), sql`${spaces.id} in (${lastMemberOf})`));
	const marked = sql`select s.id from spaces s where s.deleted_at = ${now}
		and not exists (select 1 from space_members o where o.space_id = s.id
			and o.user_id <> ${userId} and o.deleted_at is null)`;
	const credentialDelete = db
		.delete(userPasswords)
		.where(and(eq(userPasswords.userId, userId), eq(userPasswords.hash, provenHash)))
		.returning({ userId: userPasswords.userId });
	const steps = [
		// Shared spaces with other live members: ownership passes on (FN-03).
		...sharedSpaceHandOver(db, userId, proof, now),
		// Connected apps (FN-29 red team L2): every connection this user made ends in every space, so their
		// credential never outlives the account in a shared space that stays.
		...autoDisconnectItems(db, userId, sql`1 = 1`, proof, now),
		markPurged,
		...purgeSpaces(db, marked, (spaceId) => sql`${proof} and ${noOtherLiveMember(spaceId)}`, now),
		db.delete(spaceMembers).where(and(proof, eq(spaceMembers.userId, userId))),
		// Push subscriptions reference sessions: removed first (FN-13).
		db.delete(pushSubscriptions).where(and(proof, eq(pushSubscriptions.userId, userId))),
		// Passkey session links (FN-50) point at sessions: removed first.
		db.delete(passkeySessions).where(and(proof, eq(passkeySessions.userId, userId))),
		db.delete(sessions).where(and(proof, eq(sessions.userId, userId))),
		// Passkeys (FN-50): every credential (live or tombstoned), pending challenge and sign-in event of the account.
		db.delete(passkeys).where(and(proof, eq(passkeys.userId, userId))),
		db.delete(passkeyChallenges).where(and(proof, eq(passkeyChallenges.userId, userId))),
		db.delete(authEvents).where(and(proof, eq(authEvents.userId, userId))),
		// Public API tokens (FN-38): every token of the account, restricted or not.
		db.delete(apiTokens).where(and(proof, eq(apiTokens.userId, userId))),
		// Personal AI keys (FN-41) and their audit trail: no key survives the account.
		db.delete(aiKeys).where(and(proof, eq(aiKeys.userId, userId))),
		db.delete(aiKeyAudit).where(and(proof, eq(aiKeyAudit.userId, userId))),
		// FN-19 Gmail red team L2: the account's pending drafts from its Gmail connection and its forwarding
		// addresses (found through the ledgers' draft links) become content-free tombstones, also in shared spaces
		// that stay; drafts the account saved are transactions and stay.
		...discardDraftsWhere(
			db,
			sql`select g.draft_id from gmail_mail g where g.user_id = ${userId} and g.draft_id is not null
				and ${proof}
			union all
			select i.draft_id from inbound_mail i where i.user_id = ${userId} and i.draft_id is not null and ${proof}`,
			now
		),
		// E-mail forwarding (FN-19): the ledger, then every address (active or revoked) of the account, also in
		// shared spaces that stay.
		db.delete(inboundMail).where(and(proof, eq(inboundMail.userId, userId))),
		db.delete(inboundAddresses).where(and(proof, eq(inboundAddresses.userId, userId))),
		// Gmail (FN-19): the ledger, scans, unfinished authorizations and the connection (sealed token) of the
		// account, also where they point at a shared space that stays. The caller revoked the token at Google first
		// (best effort, revokeGmailToken); the sealed token is also queued so the jobs Worker retries a revoke that
		// failed (red team L3; Google answers an already revoked token as revoked).
		queueGmailRevocations(db, sql`${proof} and ${gmailConnections.userId} = ${userId}`, now),
		db.delete(gmailMail).where(and(proof, eq(gmailMail.userId, userId))),
		db.delete(gmailScans).where(and(proof, eq(gmailScans.userId, userId))),
		db.delete(oauthStates).where(and(proof, eq(oauthStates.userId, userId))),
		db.delete(gmailConnections).where(and(proof, eq(gmailConnections.userId, userId))),
		db.delete(featureFlags).where(and(proof, eq(featureFlags.userId, userId))),
		// The account key (FN-21): its public key and wrapped private key go with the account.
		db.delete(accountKeys).where(and(proof, eq(accountKeys.userId, userId))),
		db.delete(userPlanState).where(and(proof, eq(userPlanState.userId, userId))),
		// Re-claim markers (FN-30 hardening): the starter grant and every voucher this account redeemed, keyed by
		// the address's HMAC only, so the same address signing up again cannot claim them twice. Left out while
		// CLAIM_HASH_KEY is unset: deletion is never blocked by it.
		...(claimHash ? claimMarkerSteps(db, userId, claimHash, proof, now) : []),
		// Notifications (FN-24): this user's rows in spaces that stay (shared spaces with other members) and
		// every user-level row, preference and push-delivery claim.
		db.delete(spaceNotifications).where(and(proof, eq(spaceNotifications.userId, userId))),
		db.delete(userNotifications).where(and(proof, eq(userNotifications.userId, userId))),
		db.delete(notificationPrefs).where(and(proof, eq(notificationPrefs.userId, userId))),
		db.delete(notificationDeliveries).where(and(proof, eq(notificationDeliveries.userId, userId))),
		// Privacy (FN-31): the consent records (this person's own act, not shared-space history) and the
		// usage-statistics switch go with the account.
		db.delete(consentRecords).where(and(proof, eq(consentRecords.userId, userId))),
		db.delete(usageStatsPrefs).where(and(proof, eq(usageStatsPrefs.userId, userId))),
		// The days this user closed (FN-34): account-level, no space.
		db.delete(dayClosures).where(and(proof, eq(dayClosures.userId, userId))),
		// Tanya (FN-22): this user's questions and answers in every space, shared spaces that survive included.
		db.delete(tanyaMessages).where(and(proof, eq(tanyaMessages.userId, userId))),
		// Agen (FN-23): this user's report runs in every space (shared spaces that survive included), their files
		// to the outbox first.
		...releaseAgentKeys(db, and(proof, eq(agentRuns.userId, userId)), now),
		db.delete(agentRuns).where(and(proof, eq(agentRuns.userId, userId))),
		credentialDelete,
		db.delete(users).where(
			and(
				eq(users.id, userId),
				// The previous statement (the guarded credential delete) removed exactly one row…
				sql`changes() = 1`,
				// …and no credential is left.
				notExists(
					db
						.select({ one: sql`1` })
						.from(userPasswords)
						.where(eq(userPasswords.userId, userId))
				)
			)
		)
	];
	type Step = (typeof steps)[number];
	const results = await db.batch(steps as unknown as [Step, ...Step[]]);
	const credential = results[steps.indexOf(credentialDelete)] as { userId: string }[];
	return credential.length === 1;
}

/**
 * Guarded writes, run before the user row goes: one `starter_grant` marker, and one `voucher` marker per voucher
 * the account redeemed. An address deleted again restarts its existing markers' 730 days from this deletion (red
 * team L5: before, they kept the first deletion's age), then INSERT OR IGNORE adds the missing ones.
 */
function claimMarkerSteps(db: Db, userId: string, claimHash: string, proof: SQL, now: number) {
	return [
		db
			.update(claimMarkers)
			.set({ createdAt: now })
			.where(
				and(
					proof,
					eq(claimMarkers.emailHmac, claimHash),
					sql`(${claimMarkers.kind} = 'starter_grant' or ${claimMarkers.voucherId} in
						(select r.voucher_id from voucher_redemptions r where r.user_id = ${userId}))`
				)
			),
		db
			.insert(claimMarkers)
			.select((qb) =>
				qb
					.select({
						emailHmac: sql`${claimHash}`.as('email_hmac'),
						kind: sql`'starter_grant'`.as('kind'),
						voucherId: sql`null`.as('voucher_id'),
						createdAt: sql`${now}`.as('created_at')
					})
					.from(sql`(select 1)`)
					.where(proof)
			)
			.onConflictDoNothing(),
		db
			.insert(claimMarkers)
			.select((qb) =>
				qb
					.selectDistinct({
						emailHmac: sql`${claimHash}`.as('email_hmac'),
						kind: sql`'voucher'`.as('kind'),
						voucherId: voucherRedemptions.voucherId,
						createdAt: sql`${now}`.as('created_at')
					})
					.from(voucherRedemptions)
					.where(and(proof, eq(voucherRedemptions.userId, userId)))
			)
			.onConflictDoNothing()
	] as const;
}
