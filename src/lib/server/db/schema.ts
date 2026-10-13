import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	index,
	type AnySQLiteColumn,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
import {
	ADJUSTMENT_DIRECTIONS,
	CATEGORY_KINDS,
	CATEGORY_SOURCES,
	TILE_KEYS,
	TRANSACTION_SOURCES,
	TRANSACTION_TYPES
} from '../../shared/transactions';
import { LEDGER_REASONS } from '../../shared/billing/credits';
import { BILLING_PERIODS, PLANS } from '../../shared/billing/plans';
import { REFUND_REASONS, REFUND_STATUSES } from '../../shared/billing/refunds';
import { CSV_FORMATS, IMPORT_SOURCES } from '../../shared/csv';
import { DRAFT_FLAGS, DRAFT_SOURCES } from '../../shared/drafts';
import { MODULES } from '../../shared/feature-flags';
import { NET_WORTH_KINDS, PRICE_SOURCES } from '../../shared/net-worth';
import { CONSENT_KINDS } from '../../shared/privacy';
import {
	NOTIFICATION_KINDS,
	SPACE_NOTIFICATION_KINDS,
	USER_NOTIFICATION_KINDS
} from '../../shared/notifications';
import {
	RECURRING_ATTENTION,
	RECURRING_FREQUENCIES,
	RECURRING_STATUSES,
	RECURRING_TYPES
} from '../../shared/recurring';
import { BUDGET_DAY_STATUSES } from '../../shared/streak';
import { BILLING_CYCLES } from '../../shared/subscriptions';
import {
	CONNECTED_APP_PROVIDERS,
	CONNECTED_APP_STATUSES
} from '../../shared/connected-apps/providers';
import { WALLET_TYPES } from '../../shared/wallets';
import { PATUNGAN_MODES, PATUNGAN_PARTICIPANT_KINDS } from '../../shared/patungan';
import {
	AGENT_FAILURES,
	AGENT_LOCALES,
	AGENT_NARRATIVE_REASONS,
	AGENT_NARRATIVE_STATES,
	AGENT_STATUSES,
	AGENT_TYPES
} from '../../shared/agent';
import {
	INBOUND_ADDRESS_STATUSES,
	INBOUND_MAIL_REASONS,
	INBOUND_MAIL_STATUSES,
	INBOUND_PARSERS,
	INBOUND_TRUST
} from '../../shared/inbound/address';
import {
	GMAIL_CONNECTION_STATUSES,
	GMAIL_MAIL_REASONS,
	GMAIL_MAIL_STATUSES,
	GMAIL_PAUSED_REASONS,
	GMAIL_RECONNECT_REASONS,
	GMAIL_SCAN_KINDS,
	GMAIL_SCAN_STATUSES,
	GMAIL_TRUST
} from '../../shared/gmail/ledger';
import { API_TOKEN_SCOPES } from '../../shared/api-tokens';
import { AUTH_EVENT_KINDS, PASSKEY_CHALLENGE_KINDS } from '../../shared/passkeys';
import { TANYA_ROLES } from '../../shared/tanya';
import { MERCHANT_CACHE_REASONS, MERCHANT_RULE_SOURCES } from '../../shared/merchants/resolve';
import {
	AI_KEY_AUDIT_ACTIONS,
	AI_KEY_PROVIDERS,
	AI_KEY_STATUSES,
	AI_KEY_TEST_RESULTS
} from '../../shared/ai-keys';

/** Small key/value table for app-level markers (demo seed, last queue ping). Not user data. */
export const appMeta = sqliteTable('app_meta', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at').notNull()
});

// Timestamps below are UTC epoch milliseconds; shown in WIB by the UI.

/** One account. `email` is stored trimmed and lower-cased (accounts.ts), so the unique index is exact. */
export const users = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull().unique(),
		name: text('name').notNull(),
		status: text('status', { enum: ['active', 'disabled'] })
			.notNull()
			.default('active'),
		/** When the person ticked "18+ or guardian permission" at sign-up (self-attested, owner decision D). */
		adultConfirmedAt: integer('adult_confirmed_at').notNull(),
		createdAt: integer('created_at').notNull(),
		lastLoginAt: integer('last_login_at')
	},
	(t) => [check('users_status_check', sql`${t.status} in ('active', 'disabled')`)]
);

/** PBKDF2-SHA256 credential plus the account lockout counter (auth/password.ts). */
export const userPasswords = sqliteTable('user_passwords', {
	userId: text('user_id')
		.primaryKey()
		.references(() => users.id),
	algo: text('algo').notNull(),
	hash: text('hash').notNull(),
	salt: text('salt').notNull(),
	iterations: integer('iterations').notNull(),
	failedCount: integer('failed_count').notNull().default(0),
	lockedUntil: integer('locked_until'),
	updatedAt: integer('updated_at').notNull()
});

/** Opaque sessions: the cookie holds the token, D1 only its SHA-256. */
export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		tokenHash: text('token_hash').notNull().unique(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		expiresAt: integer('expires_at').notNull(),
		revokedAt: integer('revoked_at'),
		lastSeenAt: integer('last_seen_at')
	},
	(t) => [index('sessions_user_idx').on(t.userId)]
);

/**
 * FN-38 public API tokens, modelled on `sessions`: the caller holds the raw token (shown once), D1 only its
 * SHA-256 and the last four characters for display. A user-level credential, not space data (no `deleted_at`
 * or sync `seq`): revoked by `revoked_at`, always expiring at `expires_at`. `restricted_space_id` limits the
 * token to one space (null: every space the user is a live member of); it is named so on purpose, not
 * `space_id`, because the row belongs to the user, not to that space (export/tables.ts). Deleting the space
 * deletes its restricted tokens (cascade); deleting the account deletes all of the user's tokens.
 */
export const apiTokens = sqliteTable(
	'api_tokens',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		name: text('name').notNull(),
		tokenHash: text('token_hash').notNull().unique(),
		lastFour: text('last_four').notNull(),
		scope: text('scope', { enum: API_TOKEN_SCOPES }).notNull(),
		restrictedSpaceId: text('restricted_space_id').references(() => spaces.id, {
			onDelete: 'cascade'
		}),
		expiresAt: integer('expires_at').notNull(),
		revokedAt: integer('revoked_at'),
		lastUsedAt: integer('last_used_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		index('api_tokens_user_idx').on(t.userId, t.expiresAt),
		check('api_tokens_scope_check', sql`${t.scope} in ('read', 'read_write')`),
		check(
			'api_tokens_content_check',
			sql`length(${t.name}) between 1 and 60 and length(${t.lastFour}) = 4
				and ${t.expiresAt} > ${t.createdAt}`
		)
	]
);

/**
 * FN-41 personal AI keys (BYOK): one row per user and provider, the key sealed with the server-held
 * AI_KEYS_ENCRYPTION_KEY (ai-keys/crypto.ts; associated data binds the row id, user and provider), plus its last
 * four characters for display. An account credential like `api_tokens` (no space, `deleted_at` or sync `seq`):
 * "Ganti kunci" replaces the row in place (a new id and ciphertext, test state cleared), "Hapus kunci" deletes it.
 */
export const aiKeys = sqliteTable(
	'ai_keys',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		provider: text('provider', { enum: AI_KEY_PROVIDERS }).notNull(),
		encryptedKey: text('encrypted_key').notNull(),
		keyNonce: text('key_nonce').notNull(),
		keyKeyId: text('key_key_id').notNull(),
		lastFour: text('last_four').notNull(),
		status: text('status', { enum: AI_KEY_STATUSES }).notNull().default('active'),
		lastTestedAt: integer('last_tested_at'),
		lastTestResult: text('last_test_result', { enum: AI_KEY_TEST_RESULTS }),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		uniqueIndex('ai_keys_user_provider_uq').on(t.userId, t.provider),
		check('ai_keys_provider_check', sql`${t.provider} in ('anthropic')`),
		check('ai_keys_status_check', sql`${t.status} in ('active')`),
		check(
			'ai_keys_test_result_check',
			sql`${t.lastTestResult} is null or ${t.lastTestResult} in ('ok', 'invalid', 'quota', 'network')`
		),
		check(
			'ai_keys_content_check',
			sql`length(${t.encryptedKey}) between 1 and 1000 and length(${t.keyNonce}) = 16
				and length(${t.keyKeyId}) = 11 and length(${t.lastFour}) = 4
				and (${t.lastTestedAt} is null) = (${t.lastTestResult} is null)`
		)
	]
);

/** FN-41: what happened to a user's AI key, content-free (no key material, no test detail). Write-only. */
export const aiKeyAudit = sqliteTable(
	'ai_key_audit',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		action: text('action', { enum: AI_KEY_AUDIT_ACTIONS }).notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		index('ai_key_audit_user_idx').on(t.userId, t.createdAt),
		check(
			'ai_key_audit_action_check',
			sql`${t.action} in ('created', 'replaced', 'removed', 'test_ok', 'test_failed')`
		)
	]
);

/**
 * FN-50 passkeys (WebAuthn credentials): a user-level credential like `api_tokens` (no space, no sync `seq`),
 * soft-deleted by `deleted_at` so a removed credential id is never confused with an unknown one while its
 * tombstone lasts; the partial unique index lets the same authenticator register again after a removal.
 * `public_key` is the COSE key as the authenticator sent it (base64url); no attestation statement is stored.
 * Deleted with the account (`deleteAccount`), never by cascade.
 */
export const passkeys = sqliteTable(
	'passkeys',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		credentialId: text('credential_id').notNull(),
		publicKey: text('public_key').notNull(),
		algorithm: integer('algorithm').notNull(),
		counter: integer('counter').notNull().default(0),
		/** JSON array of transports the browser reported (`['internal', 'hybrid']`), for the list only. */
		transports: text('transports').notNull().default('[]'),
		aaguid: text('aaguid').notNull(),
		name: text('name').notNull(),
		rpId: text('rp_id').notNull(),
		backedUp: integer('backed_up').notNull().default(0),
		createdAt: integer('created_at').notNull(),
		lastUsedAt: integer('last_used_at'),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		uniqueIndex('passkeys_credential_live_uq')
			.on(t.credentialId)
			.where(sql`deleted_at is null`),
		index('passkeys_user_idx').on(t.userId, t.createdAt),
		check('passkeys_algorithm_check', sql`${t.algorithm} in (-7, -257)`),
		check('passkeys_backed_up_check', sql`${t.backedUp} in (0, 1)`),
		check(
			'passkeys_content_check',
			sql`length(${t.credentialId}) between 16 and 1400 and length(${t.publicKey}) between 32 and 1400
				and length(${t.name}) between 1 and 160 and length(${t.aaguid}) = 36 and ${t.counter} >= 0`
		)
	]
);

/**
 * FN-50: one issued WebAuthn challenge, consumed by a single guarded UPDATE (`used_at is null and expires_at > now`)
 * in the verify path, so a response is accepted once. `user_id` is set for a registration (the signed-in user) and
 * null for a discoverable sign-in. Expired rows are swept on the next insert.
 */
export const passkeyChallenges = sqliteTable(
	'passkey_challenges',
	{
		id: text('id').primaryKey(),
		challenge: text('challenge').notNull().unique(),
		kind: text('kind', { enum: PASSKEY_CHALLENGE_KINDS }).notNull(),
		userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at').notNull(),
		expiresAt: integer('expires_at').notNull(),
		usedAt: integer('used_at'),
		/**
		 * The id of the row the consuming request wrote (the session of a sign-in, the passkey of a registration),
		 * set with `used_at` in the same guarded UPDATE: the later statements of that batch test it, so of two
		 * requests answering one challenge in the same millisecond only the one that consumed it writes.
		 */
		usedBy: text('used_by')
	},
	(t) => [
		index('passkey_challenges_expires_idx').on(t.expiresAt),
		check('passkey_challenges_kind_check', sql`${t.kind} in ('register', 'sign_in')`),
		check(
			'passkey_challenges_content_check',
			sql`length(${t.challenge}) between 32 and 64 and ${t.expiresAt} > ${t.createdAt}`
		)
	]
);

/**
 * FN-50: which passkey created a session (one row per passkey sign-in, written in the session's own batch), so
 * removing a passkey revokes exactly its sessions. A table of its own rather than a `sessions` column: `sessions`
 * keeps its shape. Goes with the session (cascade) and with the account.
 */
export const passkeySessions = sqliteTable(
	'passkey_sessions',
	{
		sessionId: text('session_id')
			.primaryKey()
			.references(() => sessions.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		passkeyId: text('passkey_id').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('passkey_sessions_passkey_idx').on(t.passkeyId)]
);

/**
 * FN-50: what happened to an account's passkeys, content-free (no IP, user agent, challenge or key material).
 * Kept 90 days (swept by the jobs Worker), not shown to the user this pass.
 */
export const authEvents = sqliteTable(
	'auth_events',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: AUTH_EVENT_KINDS }).notNull(),
		passkeyId: text('passkey_id'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		index('auth_events_user_idx').on(t.userId, t.createdAt),
		check(
			'auth_events_kind_check',
			sql`${t.kind} in ('passkey_added', 'passkey_removed', 'passkey_sign_in', 'passkey_refused', 'passkey_counter_rollback')`
		)
	]
);

/** Per-client sign-in/sign-up budget (auth/throttle.ts). The key is a SHA-256, never an address. */
export const authAttempts = sqliteTable(
	'auth_attempts',
	{
		clientHash: text('client_hash').primaryKey(),
		windowStart: integer('window_start').notNull(),
		count: integer('count').notNull().default(0)
	},
	(t) => [index('auth_attempts_window_idx').on(t.windowStart)]
);

/** Every financial row belongs to exactly one space. FN-01 creates the personal one; FN-03 adds shared ones. */
export const spaces = sqliteTable(
	'spaces',
	{
		id: text('id').primaryKey(),
		kind: text('kind', { enum: ['personal', 'shared'] })
			.notNull()
			.default('personal'),
		name: text('name').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [check('spaces_kind_check', sql`${t.kind} in ('personal', 'shared')`)]
);

export const spaceMembers = sqliteTable(
	'space_members',
	{
		id: text('id').primaryKey(),
		// Deleting a space (delete-account.ts, only when no one else is a member) removes its memberships.
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		role: text('role', { enum: ['owner', 'member'] }).notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		uniqueIndex('space_members_space_user_uq').on(t.spaceId, t.userId),
		index('space_members_user_idx').on(t.userId),
		check('space_members_role_check', sql`${t.role} in ('owner', 'member')`)
	]
);

/**
 * Invite links to a shared space (FN-03). Only the SHA-256 of the token is stored (the link is shown once).
 * Revoking sets `deleted_at`; at most one live (`deleted_at is null`) invite per space, enforced by a partial
 * unique index. An invite dies with its space or with the account that created it.
 */
export const spaceInvites = sqliteTable(
	'space_invites',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		tokenHash: text('token_hash').notNull().unique(),
		createdByUserId: text('created_by_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		expiresAt: integer('expires_at').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		uniqueIndex('space_invites_live_uq')
			.on(t.spaceId)
			.where(sql`deleted_at is null`)
	]
);

export const AUDIT_ACTIONS = [
	'space_created',
	'invite_created',
	'invite_revoked',
	'member_joined',
	'member_removed',
	'member_left',
	'ownership_transferred',
	'app_connected',
	'app_disconnected',
	'app_auto_disconnected',
	'import_batch_moved'
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Sharing audit log (FN-03; FN-29 adds content-free app connect/disconnect events; FN-16j a content-free "import batch moved"), write-only for now. User references become null when that account is deleted:
 * the event stays for the remaining members without pointing at a deleted person.
 */
export const auditEvents = sqliteTable(
	'audit_events',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
		action: text('action', { enum: AUDIT_ACTIONS }).notNull(),
		targetUserId: text('target_user_id').references(() => users.id, { onDelete: 'set null' }),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		index('audit_events_space_idx').on(t.spaceId, t.createdAt),
		check(
			'audit_events_action_check',
			sql`${t.action} in ('space_created', 'invite_created', 'invite_revoked', 'member_joined', 'member_removed', 'member_left', 'ownership_transferred', 'app_connected', 'app_disconnected', 'app_auto_disconnected', 'import_batch_moved')`
		)
	]
);

/**
 * Per-space change counter (docs/ARCHITECTURE.md › Local-first sync). Every write to a synced table bumps it in
 * the same `db.batch` (sync/seq.ts) and stamps the row with the new value; a client never supplies `seq`.
 */
export const spaceSeq = sqliteTable('space_seq', {
	spaceId: text('space_id')
		.primaryKey()
		.references(() => spaces.id, { onDelete: 'cascade' }),
	seq: integer('seq').notNull()
});

/**
 * Wallets (FN-04). Balance = `opening_balance_minor` (integer minor units of `currency`) + the wallet's
 * transactions (FN-05; wallets/balance.ts). `last_four` holds at most the last 4 digits of an account or card
 * number. Archive = `deleted_at` (reversible this pass). At most one live favourite per space, kept by guarded
 * writes in wallets/repo.ts. A space's wallets go when the space row is deleted.
 */
export const wallets = sqliteTable(
	'wallets',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		type: text('type', { enum: WALLET_TYPES }).notNull(),
		currency: text('currency').notNull().default('IDR'),
		openingBalanceMinor: integer('opening_balance_minor').notNull().default(0),
		isFavourite: integer('is_favourite', { mode: 'boolean' }).notNull().default(false),
		lastFour: text('last_four'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('wallets_space_idx').on(t.spaceId, t.deletedAt),
		check(
			'wallets_type_check',
			sql`${t.type} in ('tunai', 'bank', 'e_wallet', 'kartu_kredit', 'lainnya')`
		),
		check(
			'wallets_last_four_check',
			sql`${t.lastFour} is null or (length(${t.lastFour}) = 4 and ${t.lastFour} not glob '*[^0-9]*')`
		)
	]
);

/**
 * Categories (FN-06). Each space gets the 17 presets on first use (categories/repo.ts) and may rename them,
 * change their tile, hide them and add its own. `tile_key` is one of the 17 tile slots (FN-39 added two; the
 * CHECK was widened by rebuilding the table in migration 0027).
 * Never hard-deleted this pass (owner decision C); `deleted_at` exists for a later delete-when-unused pass.
 */
export const categories = sqliteTable(
	'categories',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: CATEGORY_KINDS }).notNull(),
		name: text('name').notNull(),
		tileKey: text('tile_key', { enum: TILE_KEYS }).notNull(),
		isPreset: integer('is_preset', { mode: 'boolean' }).notNull().default(false),
		isHidden: integer('is_hidden', { mode: 'boolean' }).notNull().default(false),
		sortOrder: integer('sort_order').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('categories_space_idx').on(t.spaceId, t.deletedAt, t.isHidden),
		// Target of category_budgets' (space_id, category_id) foreign key (migration 0020).
		uniqueIndex('categories_space_id_uq').on(t.spaceId, t.id),
		check('categories_kind_check', sql`${t.kind} in ('expense', 'income')`),
		check(
			'categories_tile_key_check',
			sql`${t.tileKey} in ('kopi', 'makan', 'belanja-harian', 'belanja', 'transportasi', 'ojek-online', 'pesan-antar-makanan', 'tagihan', 'kesehatan', 'hiburan', 'pendidikan', 'tempat-tinggal', 'biaya-bank', 'pajak', 'tarik-tunai', 'kartu-kredit', 'transfer', 'gaji', 'bonus', 'freelance', 'hadiah', 'bunga', 'lain')`
		)
	]
);

/**
 * Import batches (FN-18; reused by FN-16/17/19): one row per confirmed import, holding only counts and the file
 * name — never the file or its rows. Every transaction an import wrote points here (`transactions.import_batch_id`),
 * so "Urungkan" tombstones the whole import in one batch and sets `undone_at`. `created_by_user_id` becomes
 * null when that account is deleted (the batch stays for the space's other members).
 */
export const importBatches = sqliteTable(
	'import_batches',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		source: text('source', { enum: IMPORT_SOURCES }).notNull(),
		format: text('format', { enum: CSV_FORMATS }),
		filename: text('filename'),
		rowCount: integer('row_count').notNull(),
		importedCount: integer('imported_count').notNull(),
		skippedCount: integer('skipped_count').notNull(),
		alreadyImportedCount: integer('already_imported_count').notNull().default(0),
		createdByUserId: text('created_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		undoneAt: integer('undone_at'),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull(),
		/**
		 * FN-48 Part B, a statement batch only (null otherwise): the wallet its rows went to, the WIB dates of the
		 * statement's first and last row, and the opening and closing balances the statement printed (IDR minor
		 * units; null when it printed none). Month-to-month continuity is checked from these.
		 */
		walletId: text('wallet_id').references(() => wallets.id),
		periodFrom: text('period_from'),
		periodTo: text('period_to'),
		openingBalanceMinor: integer('opening_balance_minor'),
		closingBalanceMinor: integer('closing_balance_minor')
	},
	(t) => [
		index('import_batches_space_idx').on(t.spaceId, t.createdAt),
		index('import_batches_wallet_period_idx').on(t.spaceId, t.walletId, t.periodFrom),
		check(
			'import_batches_source_check',
			sql`${t.source} in ('csv', 'statement', 'spreadsheet', 'gmail_lookback')`
		),
		check(
			'import_batches_format_check',
			sql`${t.format} is null or ${t.format} in ('template', 'money_manager')`
		)
	]
);

/**
 * The ledger (FN-05). A deleted row is a content-free tombstone (every content column null). Sign convention: `amount_minor` is always a positive magnitude in `currency` (the wallet's
 * currency) and the direction comes from `type`; a transfer (`transfer_to_wallet_id` set, no category) never
 * counts as income or expense. `occurred_on` is the WIB calendar date every day/month bucket uses;
 * `occurred_at` (UTC epoch ms) only orders rows within a day. `source` and `dedupe_key` are write-once at
 * creation; the partial unique index makes a capture's dedupe key idempotent per space and source.
 * `category_id` may be null for an expense/income row ("Tanpa kategori", for later captures); the form
 * always sets one.
 */
export const transactions = sqliteTable(
	'transactions',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		type: text('type', { enum: TRANSACTION_TYPES }).notNull(),
		// Content columns (amount … note) are null exactly on a tombstone (`transactions_content_check`).
		amountMinor: integer('amount_minor'),
		currency: text('currency'),
		categoryId: text('category_id').references(() => categories.id),
		walletId: text('wallet_id').references(() => wallets.id),
		transferToWalletId: text('transfer_to_wallet_id').references(() => wallets.id),
		title: text('title'),
		note: text('note'),
		occurredOn: text('occurred_on'),
		occurredAt: integer('occurred_at'),
		source: text('source', { enum: TRANSACTION_SOURCES }).notNull().default('manual'),
		dedupeKey: text('dedupe_key'),
		/** Fictional local-review row (scripts/seed-local.ts): badged "Data demo", never in a total. */
		isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull(),
		/** The import that wrote the row (FN-18); null for every other row. Kept on a tombstone (no content). */
		importBatchId: text('import_batch_id').references(() => importBatches.id),
		// Imported extras (FN-18, CSV template columns): content, cleared on a tombstone like the rest.
		paymentMethod: text('payment_method'),
		recurrence: text('recurrence'),
		tag: text('tag'),
		reference: text('reference'),
		/**
		 * A balance adjustment's sign (FN-37): set exactly on a live `adjustment` row (`amount_minor` stays a
		 * positive magnitude); content, cleared on a tombstone.
		 */
		adjustmentDirection: text('adjustment_direction', { enum: ADJUSTMENT_DIRECTIONS }),
		/**
		 * The recurring series that created the row (FN-36); null for every other row. Bookkeeping like
		 * `import_batch_id`: kept on a tombstone. Not the FN-18 `recurrence` column (free text from a CSV). ON DELETE
		 * SET NULL: a hard-deleted series leaves its transactions as plain rows.
		 */
		recurringSeriesId: text('recurring_series_id').references(() => recurringTransactions.id, {
			onDelete: 'set null'
		}),
		/**
		 * The receipt photo the user kept as proof (FN-15), in the `FILES` R2 bucket under
		 * `spaces/<space_id>/receipts/<uuid>` (photos/store.ts), with its sniffed type. Content: cleared on a
		 * tombstone, its key moved to `file_deletions` in the same batch.
		 */
		photoKey: text('photo_key'),
		photoType: text('photo_type', { enum: ['image/jpeg', 'image/png', 'image/webp'] }),
		/**
		 * Who chose `category_id` (FN-48): `auto` when a capture or import wrote it unseen, `user` when a person picked
		 * it (the compose/edit form, "Atur kategori" on a draft, a reviewed voice or receipt save). Null on rows
		 * written before migration 0037. Bookkeeping, kept on a tombstone. "Rapikan kategori" only ever proposes a
		 * new category for an `auto` row (or, for a null one, a row never edited since it was created).
		 */
		categorySource: text('category_source', { enum: CATEGORY_SOURCES }),
		/**
		 * FN-49 Patungan: the split this row is the bill (or the payer's own share) of, and the part of
		 * `amount_minor` that is the payer's own spending. Set together or not at all, only on a live expense row
		 * (`transactions_patungan_check`); content, cleared on a tombstone (TOMBSTONE_CONTENT), so deleting the row
		 * unlinks it. Every sum in transactions/aggregate.ts reads `coalesce(effective, amount_minor)`; the stored
		 * `amount_minor`, `currency`, `dedupe_key` and `source` never change because of a link. Added by ALTER
		 * (migration 0041): a column foreign key, plus two triggers that keep the split in the row's own space.
		 */
		patunganSplitId: text('patungan_split_id').references((): AnySQLiteColumn => patunganSplits.id),
		patunganEffectiveAmountMinor: integer('patungan_effective_amount_minor')
	},
	(t) => [
		index('transactions_import_batch_idx').on(t.spaceId, t.importBatchId),
		index('transactions_recurring_idx').on(t.spaceId, t.recurringSeriesId),
		index('transactions_space_day_idx').on(t.spaceId, t.deletedAt, t.occurredOn),
		index('transactions_wallet_idx').on(t.spaceId, t.walletId, t.deletedAt),
		index('transactions_transfer_to_idx').on(t.spaceId, t.transferToWalletId, t.deletedAt),
		// The file sweep's "a row still holds this key" check (photos/store.ts), without a table scan.
		index('transactions_photo_idx')
			.on(t.photoKey)
			.where(sql`photo_key is not null`),
		uniqueIndex('transactions_dedupe_uq')
			.on(t.spaceId, t.source, t.dedupeKey)
			.where(sql`dedupe_key is not null`),
		check(
			'transactions_type_check',
			sql`${t.type} in ('expense', 'income', 'transfer', 'adjustment')`
		),
		check(
			'transactions_source_check',
			sql`${t.source} in ('manual', 'gmail', 'voice', 'receipt', 'statement', 'spreadsheet', 'csv', 'slack')`
		),
		// A live row has its content (amount 1 … 10^13 minor units, validation.ts MAX_AMOUNT_MINOR) and a consistent shape
		// (a category only on expense/income; a direction exactly on an adjustment, FN-37); a tombstone keeps none of it (content-free:
		// only id, space, type, source, dedupe key, timestamps and seq remain).
		check(
			'transactions_content_check',
			sql`(${t.deletedAt} is null and ${t.amountMinor} is not null and ${t.amountMinor} between 1 and 10000000000000 and ${t.currency} is not null and ${t.walletId} is not null and ${t.occurredOn} is not null and ${t.occurredAt} is not null and (${t.type} = 'transfer') = (${t.transferToWalletId} is not null) and (${t.type} in ('expense', 'income') or ${t.categoryId} is null) and (${t.transferToWalletId} is null or ${t.transferToWalletId} <> ${t.walletId}) and (${t.type} = 'adjustment') = (${t.adjustmentDirection} is not null) and (${t.adjustmentDirection} is null or ${t.adjustmentDirection} in ('increase', 'decrease'))) or (${t.deletedAt} is not null and ${t.amountMinor} is null and ${t.currency} is null and ${t.walletId} is null and ${t.transferToWalletId} is null and ${t.categoryId} is null and ${t.occurredOn} is null and ${t.occurredAt} is null and ${t.title} is null and ${t.note} is null and ${t.adjustmentDirection} is null and ${t.photoKey} is null and ${t.photoType} is null)`
		),
		check(
			'transactions_category_source_check',
			sql`${t.categorySource} is null or ${t.categorySource} in ('auto', 'user')`
		),
		// FN-49: one live transaction per split (a tombstone holds no link at all).
		uniqueIndex('transactions_patungan_split_uq')
			.on(t.patunganSplitId)
			.where(sql`patungan_split_id is not null and deleted_at is null`),
		check(
			'transactions_patungan_check',
			sql`(${t.patunganSplitId} is null) = (${t.patunganEffectiveAmountMinor} is null)
				and (${t.patunganEffectiveAmountMinor} is null or ${t.patunganEffectiveAmountMinor} between 1 and ${t.amountMinor})
				and (${t.patunganSplitId} is null or (${t.type} = 'expense' and ${t.deletedAt} is null))`
		),
		// A kept receipt photo (FN-15): key and type together, the type one of PHOTO_TYPES (as on belongings).
		check(
			'transactions_photo_check',
			sql`(${t.photoKey} is null and ${t.photoType} is null)
				or (${t.photoKey} is not null and ${t.photoType} is not null
					and ${t.photoType} in ('image/jpeg', 'image/png', 'image/webp'))`
		)
	]
);

/**
 * FN-49 Patungan: one bill split between people. The payer is `created_by_user_id` (null once that account is
 * deleted; `payer_name` keeps the name they had). `total_amount_minor` is integer minor units of `currency`, equal
 * to the sum of the live participants' shares (patungan/repo.ts asserts it in every write) and, when a
 * transaction is linked as the bill, to that row's `amount_minor`. The link lives on `transactions` only. A
 * deleted split is a content-free tombstone. `is_demo`: fictional local-review row ("Data demo"), never in a total.
 */
export const patunganSplits = sqliteTable(
	'patungan_splits',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		createdByUserId: text('created_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		payerName: text('payer_name'),
		title: text('title'),
		totalAmountMinor: integer('total_amount_minor'),
		currency: text('currency'),
		occurredOn: text('occurred_on'),
		mode: text('mode', { enum: PATUNGAN_MODES }).notNull(),
		note: text('note'),
		paymentDetails: text('payment_details'),
		isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('patungan_splits_space_idx').on(t.spaceId, t.deletedAt, t.occurredOn),
		check(
			'patungan_splits_mode_check',
			sql`${t.mode} in ('equal', 'exact', 'items', 'percentage')`
		),
		check(
			'patungan_splits_content_check',
			sql`(${t.deletedAt} is null and ${t.payerName} is not null
				and length(${t.payerName}) between 1 and 80 and ${t.title} is not null
				and length(${t.title}) between 1 and 80 and ${t.totalAmountMinor} is not null
				and ${t.totalAmountMinor} between 1 and 10000000000000 and ${t.currency} is not null
				and length(${t.currency}) = 3 and ${t.occurredOn} is not null
				and (${t.note} is null or length(${t.note}) <= 500)
				and (${t.paymentDetails} is null or length(${t.paymentDetails}) <= 200))
			or (${t.deletedAt} is not null and ${t.payerName} is null and ${t.title} is null
				and ${t.totalAmountMinor} is null and ${t.currency} is null
				and ${t.occurredOn} is null and ${t.note} is null and ${t.paymentDetails} is null)`
		)
	]
);

/**
 * FN-49: one person's share of a split, the payer's own row included (exactly one live `is_payer` row per split),
 * so the live shares add up to the split's total with no special-cased remainder. `kind` member (a member of the
 * space, `member_user_id`, null once that account is deleted) or guest (a typed name); `display_name` is always a
 * snapshot. `paid_amount_minor` 0 … share, `paid_at` set exactly when it is the whole share; the payer's row is
 * always paid (nobody owes themselves). `position` orders the rows (the payer first). Settling never touches a
 * transaction or a total. A deleted row is a content-free tombstone.
 */
export const patunganParticipants = sqliteTable(
	'patungan_participants',
	{
		id: text('id').primaryKey(),
		splitId: text('split_id')
			.notNull()
			.references(() => patunganSplits.id, { onDelete: 'cascade' }),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		kind: text('kind', { enum: PATUNGAN_PARTICIPANT_KINDS }).notNull(),
		memberUserId: text('member_user_id').references(() => users.id, { onDelete: 'set null' }),
		displayName: text('display_name'),
		isPayer: integer('is_payer', { mode: 'boolean' }).notNull().default(false),
		shareAmountMinor: integer('share_amount_minor'),
		breakdownNote: text('breakdown_note'),
		paidAmountMinor: integer('paid_amount_minor'),
		paidAt: integer('paid_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('patungan_participants_split_idx').on(t.spaceId, t.splitId, t.deletedAt),
		uniqueIndex('patungan_participants_one_payer_uq')
			.on(t.splitId)
			.where(sql`is_payer = 1 and deleted_at is null`),
		uniqueIndex('patungan_participants_member_uq')
			.on(t.splitId, t.memberUserId)
			.where(sql`member_user_id is not null and deleted_at is null`),
		check('patungan_participants_kind_check', sql`${t.kind} in ('member', 'guest')`),
		check(
			'patungan_participants_content_check',
			sql`(${t.deletedAt} is null and ${t.displayName} is not null
				and length(${t.displayName}) between 1 and 80
				and ${t.shareAmountMinor} is not null
				and ${t.shareAmountMinor} between 1 and 10000000000000
				and ${t.paidAmountMinor} is not null
				and ${t.paidAmountMinor} between 0 and ${t.shareAmountMinor}
				and (${t.isPayer} = 0 or ${t.paidAmountMinor} = ${t.shareAmountMinor})
				and (${t.paidAmountMinor} = ${t.shareAmountMinor}) = (${t.paidAt} is not null)
				and (${t.kind} = 'member' or ${t.memberUserId} is null)
				and (${t.isPayer} = 0 or ${t.kind} = 'member')
				and (${t.breakdownNote} is null or length(${t.breakdownNote}) <= 200))
			or (${t.deletedAt} is not null and ${t.displayName} is null
				and ${t.memberUserId} is null and ${t.shareAmountMinor} is null
				and ${t.breakdownNote} is null and ${t.paidAmountMinor} is null
				and ${t.paidAt} is null)`
		)
	]
);

/**
 * FN-49 (pass 2 writes it): a read-only share link to one split, modelled on `space_invites`. Only the SHA-256 of
 * the token is stored; at most one live link per split (partial unique index); revoking sets `deleted_at`.
 */
export const patunganShareLinks = sqliteTable(
	'patungan_share_links',
	{
		id: text('id').primaryKey(),
		splitId: text('split_id')
			.notNull()
			.references(() => patunganSplits.id, { onDelete: 'cascade' }),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		tokenHash: text('token_hash').notNull().unique(),
		createdByUserId: text('created_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		expiresAt: integer('expires_at').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		uniqueIndex('patungan_share_links_live_uq')
			.on(t.splitId)
			.where(sql`deleted_at is null`)
	]
);

/**
 * FN-48 "Rapikan kategori": one row per confirmed clean-up of imported rows still in a fallback category, so the
 * whole batch can be undone in one step (like `import_batches`, but restoring a field, never deleting a row). Its
 * id is the nonce the review page was loaded with, so a resent apply finds it and changes nothing.
 */
export const categoryCleanupBatches = sqliteTable(
	'category_cleanup_batches',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		/** Transactions this batch changed (its items). */
		rowCount: integer('row_count').notNull(),
		createdByUserId: text('created_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		undoneAt: integer('undone_at'),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [index('category_cleanup_batches_space_idx').on(t.spaceId, t.createdAt)]
);

/**
 * FN-48: one changed transaction of a clean-up batch: its category before and after, and the `updated_at` the
 * change gave it. Undo restores `previous_category_id` only while the row still holds exactly that change (same
 * category and `updated_at`), so a later edit is never overwritten. Ids only, no content; no foreign key to
 * `transactions` or `categories`, so their rebuilding migrations never need to step around this table.
 */
export const categoryCleanupItems = sqliteTable(
	'category_cleanup_items',
	{
		batchId: text('batch_id')
			.notNull()
			.references(() => categoryCleanupBatches.id, { onDelete: 'cascade' }),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		transactionId: text('transaction_id').notNull(),
		previousCategoryId: text('previous_category_id').notNull(),
		newCategoryId: text('new_category_id').notNull(),
		appliedUpdatedAt: integer('applied_updated_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.batchId, t.transactionId] }),
		index('category_cleanup_items_space_idx').on(t.spaceId)
	]
);

/**
 * FN-48 Part C "Cocokkan transfer": one row per confirmed merge of an own-transfer pair (a "Transfer keluar"
 * expense in one wallet and the same-amount "Transfer masuk" income in another, within a day) into one FN-05
 * transfer row. The debit row becomes the transfer and the credit row is tombstoned; both rows' previous content
 * is kept here as JSON so the one-step undo restores them exactly (same ids, same `created_at`). Append-only: an
 * undone link stays, marked `undone_at`. Ids only, no foreign key to `transactions`, so a rebuild of that table
 * never has to step around this one. A live debit or credit row can be in one live link at a time.
 */
export const transferLinks = sqliteTable(
	'transfer_links',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		debitTransactionId: text('debit_transaction_id').notNull(),
		creditTransactionId: text('credit_transaction_id').notNull(),
		/** JSON: the debit row's previous `type`, `categoryId`, `categorySource`, `transferToWalletId`, `updatedAt`. */
		debitSnapshot: text('debit_snapshot').notNull(),
		/** JSON: every content column of the credit row (TOMBSTONE_CONTENT's fields, `categorySource`, `updatedAt`). */
		creditSnapshot: text('credit_snapshot').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		undoneAt: integer('undone_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('transfer_links_space_idx').on(t.spaceId, t.createdAt),
		uniqueIndex('transfer_links_debit_live_uq')
			.on(t.debitTransactionId)
			.where(sql`undone_at is null`),
		uniqueIndex('transfer_links_credit_live_uq')
			.on(t.creditTransactionId)
			.where(sql`undone_at is null`)
	]
);

/**
 * Recurring transaction series (FN-36): a template (type, amount, wallet, category, title, note) and a schedule
 * (`frequency` + `interval_day`: day of month 1–31, or ISO weekday 1–7) from `start_on` to `end_on` (WIB dates,
 * `end_on` null = open-ended). `next_run_on` is the WIB date of the next instance still to create; the jobs cron
 * creates it as a normal `transactions` row (source `manual`, dedupe key `recurring:<id>:<date>`) and advances
 * this date in the same batch. `status`: active, paused (skipped, resumes from today without backfill) or
 * stopped. `attention` says why the last due instance could not be created ("Perlu perhatian"). The cron writes
 * on behalf of `created_by_user_id` (set to whoever last edited or resumed the series), re-checked as a live
 * member in every insert. A deleted series is a content-free tombstone.
 */
export const recurringTransactions = sqliteTable(
	'recurring_transactions',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		type: text('type', { enum: RECURRING_TYPES }).notNull(),
		amountMinor: integer('amount_minor'),
		currency: text('currency'),
		categoryId: text('category_id').references(() => categories.id),
		walletId: text('wallet_id').references(() => wallets.id),
		title: text('title'),
		note: text('note'),
		frequency: text('frequency', { enum: RECURRING_FREQUENCIES }),
		intervalDay: integer('interval_day'),
		startOn: text('start_on'),
		endOn: text('end_on'),
		nextRunOn: text('next_run_on'),
		status: text('status', { enum: RECURRING_STATUSES }).notNull().default('active'),
		attention: text('attention', { enum: RECURRING_ATTENTION }),
		createdByUserId: text('created_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('recurring_transactions_space_idx').on(t.spaceId, t.deletedAt),
		// The cron's walk: live active series by space and due date.
		index('recurring_transactions_due_idx')
			.on(t.spaceId, t.nextRunOn)
			.where(sql`status = 'active' and deleted_at is null`),
		check('recurring_transactions_type_check', sql`${t.type} in ('expense', 'income')`),
		check(
			'recurring_transactions_status_check',
			sql`${t.status} in ('active', 'paused', 'stopped')`
		),
		check(
			'recurring_transactions_attention_check',
			sql`${t.attention} is null or ${t.attention} in ('limit', 'refs', 'member')`
		),
		check(
			'recurring_transactions_content_check',
			sql`(${t.deletedAt} is null and ${t.amountMinor} is not null and ${t.amountMinor} between 1 and 10000000000000
				and ${t.currency} is not null and ${t.walletId} is not null and ${t.categoryId} is not null
				and ((${t.frequency} = 'monthly' and ${t.intervalDay} between 1 and 31)
					or (${t.frequency} = 'weekly' and ${t.intervalDay} between 1 and 7))
				and ${t.startOn} is not null and ${t.nextRunOn} is not null
				and (${t.endOn} is null or ${t.endOn} >= ${t.startOn}))
			or (${t.deletedAt} is not null and ${t.amountMinor} is null and ${t.currency} is null
				and ${t.walletId} is null and ${t.categoryId} is null and ${t.title} is null and ${t.note} is null
				and ${t.frequency} is null and ${t.intervalDay} is null and ${t.startOn} is null
				and ${t.endOn} is null and ${t.nextRunOn} is null and ${t.attention} is null)`
		)
	]
);

/**
 * Savings goals (FN-10). A goal's saved amount is never stored: it is the SQL `SUM()` of its live
 * contributions (goals/progress.ts). A goal never moves money and is linked to no wallet or transaction.
 * Archive = `deleted_at` (reversible; its contributions stay untouched). `target_amount_minor` is integer minor
 * units of `currency` (IDR this pass).
 */
export const goals = sqliteTable(
	'goals',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		targetAmountMinor: integer('target_amount_minor').notNull(),
		currency: text('currency').notNull().default('IDR'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('goals_space_idx').on(t.spaceId, t.deletedAt),
		check('goals_target_check', sql`${t.targetAmountMinor} > 0`)
	]
);

/**
 * Append-only log of amounts put toward a goal (FN-10): always positive; the only way down is tombstoning a
 * logged row. Same space as its goal (written only through the guarded insert in goals/contributions.ts).
 * A tombstone is content-free (CHECK): a live row has its amount and time, a deleted row keeps only its ids,
 * `deleted_at`, `updated_at` and `seq`. `created_by_user_id` becomes null when that account is deleted: the
 * amount stays for the space's remaining members without pointing at a deleted person.
 */
export const goalContributions = sqliteTable(
	'goal_contributions',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		goalId: text('goal_id')
			.notNull()
			.references(() => goals.id, { onDelete: 'cascade' }),
		/** Null only on a tombstone (see the CHECK). */
		amountMinor: integer('amount_minor'),
		note: text('note'),
		createdByUserId: text('created_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		/** Null only on a tombstone (see the CHECK). */
		createdAt: integer('created_at'),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('goal_contributions_goal_idx').on(t.spaceId, t.goalId, t.deletedAt, t.createdAt),
		check(
			'goal_contributions_content_check',
			sql`(${t.deletedAt} is null and ${t.amountMinor} is not null and ${t.amountMinor} > 0
				and ${t.createdAt} is not null)
			or (${t.deletedAt} is not null and ${t.amountMinor} is null and ${t.note} is null
				and ${t.createdByUserId} is null and ${t.createdAt} is null)`
		)
	]
);

/**
 * Captured payments waiting for review (FN-11, Kotak masuk). A capture (FN-14 onward) writes a row here; "Simpan"
 * turns it into a `transactions` row through transactions/repo.ts and tombstones the draft with
 * `saved_transaction_id`. Discard and save both leave a content-free tombstone (only id, space, type, source,
 * dedupe key, demo flag, saved id, timestamps and seq remain), and the partial unique dedupe index has no
 * `deleted_at` condition, exactly like `transactions_dedupe_uq`: a discarded or saved capture is never recreated
 * from the same source. Amounts follow the ledger's sign convention (positive magnitude, direction from `type`).
 */
export const drafts = sqliteTable(
	'drafts',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		type: text('type', { enum: CATEGORY_KINDS }).notNull(),
		// Content columns (amount … flag) are null exactly on a tombstone (`drafts_content_check`).
		amountMinor: integer('amount_minor'),
		currency: text('currency'),
		title: text('title'),
		note: text('note'),
		categoryId: text('category_id').references(() => categories.id),
		walletId: text('wallet_id').references(() => wallets.id),
		occurredOn: text('occurred_on'),
		occurredAt: integer('occurred_at'),
		source: text('source', { enum: DRAFT_SOURCES }).notNull(),
		dedupeKey: text('dedupe_key'),
		flag: text('flag', { enum: DRAFT_FLAGS }),
		/** Fictional row from the dev-only seed action (drafts/repo.ts): badged "Data demo". */
		isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
		savedTransactionId: text('saved_transaction_id').references(() => transactions.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull(),
		/**
		 * FN-48: `user` once a member picked the category ("Atur kategori"); null while it is the capture's own guess.
		 * Saving the draft carries it onto the transaction's `category_source` (`auto` for null).
		 */
		categorySource: text('category_source', { enum: CATEGORY_SOURCES })
	},
	(t) => [
		index('drafts_space_day_idx').on(t.spaceId, t.deletedAt, t.occurredOn),
		uniqueIndex('drafts_dedupe_uq')
			.on(t.spaceId, t.source, t.dedupeKey)
			.where(sql`dedupe_key is not null`),
		check('drafts_type_check', sql`${t.type} in ('expense', 'income')`),
		check(
			'drafts_source_check',
			sql`${t.source} in ('gmail', 'voice', 'receipt', 'statement', 'spreadsheet', 'csv', 'slack')`
		),
		check(
			'drafts_flag_check',
			sql`${t.flag} is null or ${t.flag} in ('duplicate', 'needs_review')`
		),
		check(
			'drafts_category_source_check',
			sql`${t.categorySource} is null or ${t.categorySource} in ('auto', 'user')`
		),
		check('drafts_saved_check', sql`${t.savedTransactionId} is null or ${t.deletedAt} is not null`),
		// A live draft has its content (amount 1 … 10^13 minor units, like transactions); a tombstone keeps none.
		check(
			'drafts_content_check',
			sql`(${t.deletedAt} is null and ${t.amountMinor} is not null and ${t.amountMinor} between 1 and 10000000000000 and ${t.currency} is not null and ${t.occurredOn} is not null and ${t.occurredAt} is not null) or (${t.deletedAt} is not null and ${t.amountMinor} is null and ${t.currency} is null and ${t.title} is null and ${t.note} is null and ${t.categoryId} is null and ${t.walletId} is null and ${t.occurredOn} is null and ${t.occurredAt} is null and ${t.flag} is null)`
		)
	]
);

/**
 * Which modules a user shows in their own navigation (FN-12). Per user, not per space: a display preference,
 * not space data, so no `space_id`, `deleted_at` or `seq` (like `sessions`). No row = enabled. One row per
 * (user, module), overwritten in place by feature-flags/repo.ts; deleted with the account (delete-account.ts).
 */
export const featureFlags = sqliteTable(
	'feature_flags',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		module: text('module', { enum: MODULES }).notNull(),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		uniqueIndex('feature_flags_user_module_uq').on(t.userId, t.module),
		check(
			'feature_flags_module_check',
			sql`${t.module} in ('kekayaan', 'langganan', 'barang', 'koleksi', 'ruang', 'patungan')`
		)
	]
);

/**
 * The space's monthly budget (FN-07): one standing amount, applied to whichever WIB month is current (owner
 * decisions B and G: total only, no per-month history). Exactly one row per space at most, live or not, enforced
 * by the unique index: "Hapus anggaran" tombstones the row and clears its amount (content-free tombstone), and
 * setting a budget again revives that same row, so set/delete churn never piles up rows (budgets/repo.ts).
 */
export const budgets = sqliteTable(
	'budgets',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		amountMinor: integer('amount_minor').notNull(),
		currency: text('currency').notNull().default('IDR'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		uniqueIndex('budgets_one_per_space_uq').on(t.spaceId),
		check(
			'budgets_amount_check',
			sql`(${t.deletedAt} is null and ${t.amountMinor} > 0) or (${t.deletedAt} is not null and ${t.amountMinor} = 0)`
		)
	]
);

/**
 * A standing monthly amount for one expense category (Anggaran page, APP_PARITY § 3), beside the space's total
 * budget above and independent of it. Same lifecycle as `budgets`: at most one row per (space, category), live
 * or not (unique index); removing tombstones it with the amount cleared, setting it again revives that row
 * (budgets/category-repo.ts). The category is bound to the same space by a composite foreign key, and a trigger in
 * migration 0020 tombstones the budget in the same statement that tombstones its category.
 */
export const categoryBudgets = sqliteTable(
	'category_budgets',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		categoryId: text('category_id').notNull(),
		amountMinor: integer('amount_minor').notNull(),
		currency: text('currency').notNull().default('IDR'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		uniqueIndex('category_budgets_space_category_uq').on(t.spaceId, t.categoryId),
		// The category must be one of the same space's: bound in the database, not only in the write paths.
		foreignKey({
			columns: [t.spaceId, t.categoryId],
			foreignColumns: [categories.spaceId, categories.id],
			name: 'category_budgets_category_fk'
		}),
		check(
			'category_budgets_amount_check',
			sql`(${t.deletedAt} is null and ${t.amountMinor} > 0) or (${t.deletedAt} is not null and ${t.amountMinor} = 0)`
		)
	]
);

/**
 * One browser's Web Push subscription (FN-13): per user and per device, not per space — a device registration,
 * not space data, so no `space_id` or `seq` (like `sessions` and `feature_flags`). `endpoint` is the push
 * service URL the browser handed out; unique, so the same browser subscribing again updates its row in place.
 * `session_id` is the session that subscribed: signing that session out tombstones the row (session.ts).
 * A tombstone (`deleted_at`) keeps only the endpoint (the upsert key); the keys and user agent are blanked.
 * Deleted with the account (delete-account.ts).
 */
export const pushSubscriptions = sqliteTable(
	'push_subscriptions',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		sessionId: text('session_id').references(() => sessions.id),
		endpoint: text('endpoint').notNull(),
		p256dh: text('p256dh').notNull(),
		auth: text('auth').notNull(),
		userAgent: text('user_agent'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		uniqueIndex('push_subscriptions_endpoint_uq').on(t.endpoint),
		index('push_subscriptions_user_idx').on(t.userId, t.deletedAt),
		index('push_subscriptions_session_idx').on(t.sessionId),
		check(
			'push_subscriptions_tombstone_check',
			sql`${t.deletedAt} is null or (${t.p256dh} = '' and ${t.auth} = '' and ${t.userAgent} is null)`
		)
	]
);

/**
 * The account key (FN-21): one row per user. Only the X25519 public key and the private key wrapped on the
 * device (AES-256-GCM under a scrypt key of the password, shared/account-key.ts), never the password, a
 * derived key or the plain private key. Bytes are base64url, `kdf_params` the scrypt params as JSON.
 * `public_key` never changes after the first write (a re-wrap keeps the key pair, so sealed results stay
 * openable). Account-level like `user_passwords`: no space. Deleted with the account (delete-account.ts).
 * A key wrapped before the password last changed (`updated_at` < `user_passwords.updated_at`) is stale: it
 * opens only with the earlier password until it is re-wrapped.
 */
export const accountKeys = sqliteTable('account_keys', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.unique()
		.references(() => users.id),
	publicKey: text('public_key').notNull(),
	wrappedPrivateKey: text('wrapped_private_key').notNull(),
	wrapNonce: text('wrap_nonce').notNull(),
	kdfSalt: text('kdf_salt').notNull(),
	kdfParams: text('kdf_params').notNull(),
	/**
	 * SHA-256 (hex) of the key confirmation: HKDF of X25519(private key, own public key), computable only with
	 * the private key. A re-wrap must present the confirmation, proving the device opened the current wrap. Only
	 * the digest is stored (red team N2), so a leaked row cannot be replayed; never returned to any client.
	 */
	keyCheckHash: text('key_check_hash').notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

/**
 * In-app notifications about one space's data (FN-24): budget 80 %/100 % and goal milestones. One row per
 * recipient (every live member gets their own). `params` holds the stored figures the text is rendered from
 * (shared/notifications.ts), never rendered text. `data_key` is the natural key (`budget:{space}:{month}:80`,
 * `goal:{goal}:50`); the unique index on (user, kind, key), with no `deleted_at` condition, means a key fires
 * at most once per user ever, even after the row was dismissed. Dismiss = content-free tombstone (`params`
 * cleared). Purged with the space (SPACE_SCOPED_TABLES) and with the recipient's account.
 */
export const spaceNotifications = sqliteTable(
	'space_notifications',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: SPACE_NOTIFICATION_KINDS }).notNull(),
		dataKey: text('data_key').notNull(),
		params: text('params'),
		readAt: integer('read_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		uniqueIndex('space_notifications_key_uq').on(t.userId, t.kind, t.dataKey),
		index('space_notifications_user_idx').on(t.userId, t.deletedAt, t.createdAt),
		index('space_notifications_space_idx').on(t.spaceId),
		// The retention sweep (notifications/schedule.ts) walks rows oldest first.
		index('space_notifications_created_idx').on(t.createdAt),
		check(
			'space_notifications_kind_check',
			sql`${t.kind} in ('budget_80', 'budget_100', 'goal_milestone', 'bill_reminder')`
		),
		check(
			'space_notifications_content_check',
			sql`(${t.deletedAt} is null and ${t.params} is not null) or (${t.deletedAt} is not null and ${t.params} is null and ${t.readAt} is null)`
		)
	]
);

/**
 * In-app notifications about the user, not a space (FN-24): the daily nudge and the weekly summary. Same
 * shape and dedupe rule as `space_notifications`, without `space_id` or `seq` (not space data, like
 * `feature_flags`). Deleted with the account (delete-account.ts).
 */
export const userNotifications = sqliteTable(
	'user_notifications',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: USER_NOTIFICATION_KINDS }).notNull(),
		dataKey: text('data_key').notNull(),
		params: text('params'),
		readAt: integer('read_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		uniqueIndex('user_notifications_key_uq').on(t.userId, t.kind, t.dataKey),
		index('user_notifications_user_idx').on(t.userId, t.deletedAt, t.createdAt),
		index('user_notifications_created_idx').on(t.createdAt),
		check(
			'user_notifications_kind_check',
			sql`${t.kind} in ('daily_nudge', 'close_reminder', 'weekly_summary')`
		),
		check(
			'user_notifications_content_check',
			sql`(${t.deletedAt} is null and ${t.params} is not null) or (${t.deletedAt} is not null and ${t.params} is null and ${t.readAt} is null)`
		)
	]
);

/**
 * Per-user, per-kind opt-out (FN-24), shaped like `feature_flags`: no row = enabled; one row per
 * (user, kind), overwritten in place. Read before any notification is created. Deleted with the account.
 */
export const notificationPrefs = sqliteTable(
	'notification_prefs',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		/**
		 * FN-34b: the whole WIB hour (06–23) this kind acts at, for a kind that has one (`close_reminder`); null
		 * means the kind's default (CLOSE_REMINDER_DEFAULT_HOUR). Every other kind keeps it null.
		 */
		hour: integer('hour'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		uniqueIndex('notification_prefs_user_kind_uq').on(t.userId, t.kind),
		check(
			'notification_prefs_kind_check',
			sql`${t.kind} in ('budget_80', 'budget_100', 'goal_milestone', 'bill_reminder', 'daily_nudge', 'close_reminder', 'weekly_summary')`
		),
		check(
			'notification_prefs_hour_check',
			sql`${t.hour} is null or (${t.kind} = 'close_reminder' and ${t.hour} between 6 and 23)`
		)
	]
);

/**
 * One push attempt of one notification to one device (FN-24): the claim that makes a replayed `send_push`
 * message never push twice to the same subscription. `state` is `sending` while claimed (a claim older than
 * the stale limit may be taken over after a crash) and `done` once the push service answered 2xx/404/410.
 * Ids only, no content. Deleted with the account (delete-account.ts) and after the retention period.
 */
export const notificationDeliveries = sqliteTable(
	'notification_deliveries',
	{
		notificationId: text('notification_id').notNull(),
		subscriptionId: text('subscription_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		state: text('state', { enum: ['sending', 'done'] }).notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.notificationId, t.subscriptionId] }),
		index('notification_deliveries_user_idx').on(t.userId),
		index('notification_deliveries_updated_idx').on(t.updatedAt),
		check('notification_deliveries_state_check', sql`${t.state} in ('sending', 'done')`)
	]
);

/**
 * Subscriptions (FN-26, Langganan): what a space pays for regularly, typed by the user (never detected).
 * `billing_day` is 1–31 for monthly, 1–7 (ISO weekday, Monday = 1) for weekly, and the day of `billing_month`
 * for yearly (`billing_month` null otherwise); month-end days clamp to the month's last real day
 * (shared/subscriptions.ts). `next_charge_on` is the WIB date of the next charge, written by the server only
 * and recomputed on read when it is today or past. `wallet_id` is informational (the wallet it is paid from,
 * same currency); `linked_transaction_id` points at the transaction that recorded the latest payment, set
 * only by "Tandai sudah dibayar". `catalogue_id` names the catalogue entry it was added from (null: a typed
 * name). Delete = content-free tombstone (CHECK): only id, space, timestamps and seq remain.
 */
export const subscriptions = sqliteTable(
	'subscriptions',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		catalogueId: text('catalogue_id'),
		name: text('name'),
		category: text('category'),
		amountMinor: integer('amount_minor'),
		currency: text('currency'),
		billingCycle: text('billing_cycle', { enum: BILLING_CYCLES }),
		billingDay: integer('billing_day'),
		billingMonth: integer('billing_month'),
		walletId: text('wallet_id').references(() => wallets.id),
		linkedTransactionId: text('linked_transaction_id').references(() => transactions.id),
		nextChargeOn: text('next_charge_on'),
		reminderDaysBefore: integer('reminder_days_before'),
		/** Fictional local-review row ("Data demo", scripts/demo-seed.ts): badged, never in a total or reminder. */
		isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('subscriptions_space_idx').on(t.spaceId, t.deletedAt),
		check(
			'subscriptions_content_check',
			sql`(${t.deletedAt} is null and ${t.name} is not null and ${t.category} is not null
				and ${t.amountMinor} is not null and ${t.amountMinor} > 0 and ${t.currency} is not null
				and ${t.nextChargeOn} is not null and ${t.reminderDaysBefore} between 0 and 14
				and ((${t.billingCycle} = 'monthly' and ${t.billingDay} between 1 and 31 and ${t.billingMonth} is null)
					or (${t.billingCycle} = 'weekly' and ${t.billingDay} between 1 and 7 and ${t.billingMonth} is null)
					or (${t.billingCycle} = 'yearly' and ${t.billingMonth} between 1 and 12
						and ${t.billingDay} between 1 and 31)))
			or (${t.deletedAt} is not null and ${t.catalogueId} is null and ${t.name} is null
				and ${t.category} is null and ${t.amountMinor} is null and ${t.currency} is null
				and ${t.billingCycle} is null and ${t.billingDay} is null and ${t.billingMonth} is null
				and ${t.walletId} is null and ${t.linkedTransactionId} is null and ${t.nextChargeOn} is null
				and ${t.reminderDaysBefore} is null)`
		)
	]
);

/**
 * Subscription check dismissals (FN-26b): the candidates a member answered "Bukan langganan" for, so the check
 * never offers them again in this space. `match_key` is the candidate's key (`cat:<catalogue id>` or the FN-20
 * cleaned merchant key: letters, digits and single spaces, no amounts, dates or account numbers); like
 * `merchant_rules.match_key` it is an index key, not personal content, so it stays on the tombstone. One live
 * row per (space, key) through the partial unique index, so a retried or concurrent dismissal adds nothing.
 * `created_by` is cleared when that account is deleted. Purged with the space (SPACE_SCOPED_TABLES).
 */
export const subscriptionDismissals = sqliteTable(
	'subscription_dismissals',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		matchKey: text('match_key').notNull(),
		createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		uniqueIndex('subscription_dismissals_live_uq')
			.on(t.spaceId, t.matchKey)
			.where(sql`deleted_at is null`),
		check('subscription_dismissals_key_check', sql`length(${t.matchKey}) between 1 and 64`)
	]
);

/**
 * Net-worth items (FN-25): what a space owns and owes beyond its wallets. A `manual` item's value is
 * `manual_value_minor` (minor units of `currency`); a priced item (`indodax` crypto by coin code
 * `price_symbol`, `gold_api` gold) is `quantity_scaled / 10^quantity_scale` × the jobs Worker's cached IDR
 * price, falling back to `manual_value_minor` when no price is cached. Quantities are integer text (they can
 * pass 2^53, e.g. a billion meme coins × 10^8), never floats. A `debt` item subtracts. Deleting writes a
 * content-free tombstone (CHECK): only ids, `updated_at`, `deleted_at` and `seq` remain.
 */
export const netWorthItems = sqliteTable(
	'net_worth_items',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		// Content columns (kind … created_at) are null exactly on a tombstone (`net_worth_items_content_check`).
		kind: text('kind', { enum: NET_WORTH_KINDS }),
		name: text('name'),
		currency: text('currency'),
		priceSource: text('price_source', { enum: PRICE_SOURCES }),
		priceSymbol: text('price_symbol'),
		quantityScaled: text('quantity_scaled'),
		quantityScale: integer('quantity_scale'),
		manualValueMinor: integer('manual_value_minor'),
		acquiredOn: text('acquired_on'),
		note: text('note'),
		/** Fictional local-review row (`Data demo`, migration 0025): badged, read-only, never in a total. */
		isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at'),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('net_worth_items_space_idx').on(t.spaceId, t.deletedAt),
		index('net_worth_items_price_idx').on(t.priceSource, t.priceSymbol),
		check(
			'net_worth_items_content_check',
			sql`(${t.deletedAt} is null and ${t.kind} in ('cash', 'investment_stock', 'investment_crypto', 'investment_gold', 'property', 'vehicle', 'debt', 'other_asset')
				and ${t.name} is not null and ${t.currency} is not null and ${t.createdAt} is not null
				and ${t.priceSource} in ('manual', 'indodax', 'gold_api')
				and (${t.manualValueMinor} is null or ${t.manualValueMinor} between 1 and 10000000000000)
				and (${t.priceSource} <> 'manual' or (${t.manualValueMinor} is not null and ${t.priceSymbol} is null))
				and (${t.priceSource} <> 'indodax' or (${t.kind} = 'investment_crypto' and ${t.currency} = 'IDR' and ${t.quantityScaled} is not null
					and ${t.priceSymbol} is not null and length(${t.priceSymbol}) between 1 and 15 and ${t.priceSymbol} not glob '*[^a-z0-9]*'))
				and (${t.priceSource} <> 'gold_api' or (${t.kind} = 'investment_gold' and ${t.currency} = 'IDR' and ${t.quantityScaled} is not null and ${t.priceSymbol} is null))
				and ((${t.quantityScaled} is null and ${t.quantityScale} is null)
					or (${t.quantityScaled} not glob '*[^0-9]*' and ${t.quantityScaled} not glob '0*' and length(${t.quantityScaled}) between 1 and 24
						and ((${t.kind} = 'investment_crypto' and ${t.quantityScale} = 8) or (${t.kind} = 'investment_gold' and ${t.quantityScale} = 3))))
				and (${t.acquiredOn} is null or length(${t.acquiredOn}) = 10))
			or (${t.deletedAt} is not null and ${t.kind} is null and ${t.name} is null and ${t.currency} is null and ${t.priceSource} is null
				and ${t.priceSymbol} is null and ${t.quantityScaled} is null and ${t.quantityScale} is null and ${t.manualValueMinor} is null
				and ${t.acquiredOn} is null and ${t.note} is null and ${t.createdAt} is null)`
		)
	]
);

/**
 * One net-worth total per space per WIB day (FN-25), written by the jobs Worker's hourly tick (the last tick
 * of the day wins), so /kekayaan can show the change over 30 days. `total_minor` is IDR sen: wallets plus
 * items minus debts, foreign amounts converted with the cached daily rate; a day whose total is not an exact
 * safe integer is not written. Derived data, still space data: purged with the space.
 */
export const netWorthSnapshots = sqliteTable(
	'net_worth_snapshots',
	{
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		/** WIB calendar date `YYYY-MM-DD`. */
		date: text('date').notNull(),
		totalMinor: integer('total_minor'),
		currency: text('currency').notNull().default('IDR'),
		/**
		 * The day's total left something out (an item without a price, a currency without a rate). Never compared
		 * against for the 30-day change; a complete figure of the same day is never overwritten by a partial one.
		 */
		partial: integer('partial', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.spaceId, t.date] }),
		check(
			'net_worth_snapshots_total_check',
			sql`(${t.deletedAt} is null and ${t.totalMinor} is not null and abs(${t.totalMinor}) <= 9007199254740991 and length(${t.date}) = 10)
			or (${t.deletedAt} is not null and ${t.totalMinor} is null)`
		)
	]
);

/**
 * Belongings (FN-27): a physical item with what it cost, when it was bought (WIB date) and optionally the
 * user's own current value (null = the page shows the straight-line estimate, shared/belongings.ts). One
 * photo per item: `photo_key` is the R2 object key (`spaces/<space_id>/belongings/<uuid>`, never a URL, never a
 * file name), set only after the object was written, with its sniffed type in `photo_type`. Deleting is a
 * content-free tombstone (CHECK): a deleted row keeps only its ids, currency, timestamps and seq — its photo
 * key goes to `file_deletions` in the same batch.
 */
export const belongings = sqliteTable(
	'belongings',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		/** Null only on a tombstone (see the CHECK). */
		name: text('name'),
		purchasePriceMinor: integer('purchase_price_minor'),
		currency: text('currency').notNull().default('IDR'),
		purchasedOn: text('purchased_on'),
		currentValueMinor: integer('current_value_minor'),
		photoKey: text('photo_key'),
		photoType: text('photo_type', { enum: ['image/jpeg', 'image/png', 'image/webp'] }),
		note: text('note'),
		/** Fictional local-review row (`Data demo`, migration 0025): badged, read-only, never in a total. */
		isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at'),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('belongings_space_idx').on(t.spaceId, t.deletedAt, t.createdAt),
		check(
			'belongings_photo_check',
			sql`(${t.photoKey} is null and ${t.photoType} is null)
				or (${t.photoKey} is not null and ${t.photoType} in ('image/jpeg', 'image/png', 'image/webp'))`
		),
		check(
			'belongings_content_check',
			sql`(${t.deletedAt} is null and ${t.name} is not null and ${t.purchasePriceMinor} is not null
				and ${t.purchasePriceMinor} >= 0 and ${t.purchasedOn} is not null and ${t.createdAt} is not null
				and (${t.currentValueMinor} is null or ${t.currentValueMinor} >= 0))
			or (${t.deletedAt} is not null and ${t.name} is null and ${t.purchasePriceMinor} is null
				and ${t.purchasedOn} is null and ${t.currentValueMinor} is null and ${t.photoKey} is null
				and ${t.photoType} is null and ${t.note} is null and ${t.createdAt} is null)`
		)
	]
);

/**
 * R2 objects to delete (FN-27): an outbox, written in the same `db.batch` that stops referencing a key
 * (tombstone, photo replaced or removed, space purge), and before an upload starts (`due_at` in the future,
 * cleared in the batch that stores the key). Drained inline after the write and by the jobs Worker (queue
 * retry, hourly cron) once `due_at` has passed: R2 deletes are idempotent, so a repeat is harmless. Keys only,
 * no content; not space-scoped, so it outlives the space it came from.
 */
export const fileDeletions = sqliteTable(
	'file_deletions',
	{
		key: text('key').primaryKey(),
		dueAt: integer('due_at').notNull(),
		attempts: integer('attempts').notNull().default(0)
	},
	(t) => [index('file_deletions_due_idx').on(t.dueAt)]
);

/**
 * Connected apps (FN-29): one live row per space and provider. `encrypted_token` is an OAuth token sealed with
 * the server-held CONNECTED_APPS_ENCRYPTION_KEY (connected-apps/crypto.ts: AES-256-GCM, a fresh 96-bit
 * `token_nonce` per seal, `token_key_id` naming the key for rotation, the row id, space and provider bound as
 * associated data) so unattended jobs can use it; never selected for a page. `external_label` is a masked
 * display label (a domain or workspace name, never a full e-mail or number). `scope` is the granted OAuth scope
 * text, informational only. Disconnect writes a content-free tombstone (CHECK): status `disconnected`, label,
 * token, nonce, key id and scope gone. No real provider exists yet: rows come only from the dev-only seed
 * (`is_demo`, badged "Data demo"). A connection is its creator's credential: it ends (tombstone +
 * `app_auto_disconnected`) when the creator is removed, leaves or deletes the account (red team L2), so
 * `created_by_user_id` is null only on a tombstone of a deleted account.
 */
export const connectedApps = sqliteTable(
	'connected_apps',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		provider: text('provider', { enum: CONNECTED_APP_PROVIDERS }).notNull(),
		status: text('status', { enum: CONNECTED_APP_STATUSES }).notNull(),
		externalLabel: text('external_label'),
		encryptedToken: text('encrypted_token'),
		tokenNonce: text('token_nonce'),
		tokenKeyId: text('token_key_id'),
		scope: text('scope'),
		isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
		createdByUserId: text('created_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		uniqueIndex('connected_apps_live_uq')
			.on(t.spaceId, t.provider)
			.where(sql`deleted_at is null`),
		check(
			'connected_apps_provider_check',
			sql`${t.provider} in ('gmail', 'google_sheets', 'google_calendar', 'notion', 'slack')`
		),
		check(
			'connected_apps_content_check',
			sql`(${t.deletedAt} is null and ${t.status} = 'connected'
				and (${t.externalLabel} is null or length(${t.externalLabel}) between 1 and 80)
				and (${t.scope} is null or length(${t.scope}) between 1 and 500)
				and ((${t.encryptedToken} is null and ${t.tokenNonce} is null and ${t.tokenKeyId} is null)
					or (${t.encryptedToken} is not null and length(${t.encryptedToken}) <= 12000
						and ${t.tokenNonce} is not null and length(${t.tokenNonce}) = 16
						and ${t.tokenKeyId} is not null and length(${t.tokenKeyId}) = 11)))
			or (${t.deletedAt} is not null and ${t.status} = 'disconnected' and ${t.externalLabel} is null
				and ${t.encryptedToken} is null and ${t.tokenNonce} is null and ${t.tokenKeyId} is null
				and ${t.scope} is null)`
		)
	]
);

/**
 * Collectibles (FN-28): an item whose value moves on its own (cards, sneakers, figures), with what it cost, when
 * it was bought (WIB date) and the user's own current value (`manual_value_minor`, always set on a live row: no
 * automated price source is wired, see docs/features/fn-28-collectibles/ENGINEER_REPORT.md). One photo per item
 * on FN-27's convention: `photo_key` is the R2 object key (`spaces/<space_id>/collectibles/<uuid>`), with its
 * sniffed type in `photo_type`. `is_demo` marks fictional local-review rows (`Data demo`, scripts/demo-seed.ts):
 * listed with a badge, never counted in a total. Deleting is a content-free tombstone (CHECK); its photo key
 * goes to `file_deletions` in the same batch.
 */
export const collectibles = sqliteTable(
	'collectibles',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		/** Null only on a tombstone (see the CHECK). */
		name: text('name'),
		purchasePriceMinor: integer('purchase_price_minor'),
		currency: text('currency').notNull().default('IDR'),
		purchasedOn: text('purchased_on'),
		manualValueMinor: integer('manual_value_minor'),
		photoKey: text('photo_key'),
		photoType: text('photo_type', { enum: ['image/jpeg', 'image/png', 'image/webp'] }),
		note: text('note'),
		isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at'),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		index('collectibles_space_idx').on(t.spaceId, t.deletedAt, t.createdAt),
		check(
			'collectibles_photo_check',
			sql`(${t.photoKey} is null and ${t.photoType} is null)
				or (${t.photoKey} is not null and ${t.photoType} in ('image/jpeg', 'image/png', 'image/webp'))`
		),
		check(
			'collectibles_content_check',
			sql`(${t.deletedAt} is null and ${t.name} is not null and ${t.purchasePriceMinor} is not null
				and ${t.purchasePriceMinor} >= 0 and ${t.purchasedOn} is not null and ${t.createdAt} is not null
				and ${t.manualValueMinor} is not null and ${t.manualValueMinor} >= 0)
			or (${t.deletedAt} is not null and ${t.name} is null and ${t.purchasePriceMinor} is null
				and ${t.purchasedOn} is null and ${t.manualValueMinor} is null and ${t.photoKey} is null
				and ${t.photoType} is null and ${t.note} is null and ${t.createdAt} is null)`
		)
	]
);

// ---------------------------------------------------------------------------------------------------------
// FN-30 billing. Account-scoped (who pays), never space data: no `space_id`, not in SPACE_SCOPED_TABLES.
// The four history tables (credit_ledger, voucher_redemptions, billing_events, plan_changes) are append-only:
// migration 0018 adds triggers that refuse every DELETE and every UPDATE except (a) `user_id` → null once that
// user row no longer exists (the FK `on delete set null` of account deletion; a live account's rows can never
// be detached) and (b) on billing_events, `replay_count + 1` with `last_seen_at`, so a grant or a payment stays
// a permanent fact.
// ---------------------------------------------------------------------------------------------------------

/**
 * The plan an account is on (FN-30): one row per user, written at sign-up (`gratis`) and changed only by a
 * verified payment or a `plan_days` voucher (billing/plan-state.ts), each change audited in `plan_changes`.
 * A paid plan is in force while `current_period_end` is in the future (shared/billing/plans.ts effectivePlan).
 * Deleted with the account (delete-account.ts).
 */
export const userPlanState = sqliteTable(
	'user_plan_state',
	{
		userId: text('user_id')
			.primaryKey()
			.references(() => users.id),
		plan: text('plan', { enum: PLANS }).notNull().default('gratis'),
		billingPeriod: text('billing_period', { enum: BILLING_PERIODS }),
		currentPeriodEnd: integer('current_period_end'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		check(
			'user_plan_state_plan_check',
			sql`${t.plan} in ('gratis', 'pro', 'agen')
				and (${t.billingPeriod} is null or ${t.billingPeriod} in ('weekly', 'monthly'))
				and (${t.plan} = 'gratis' or ${t.currentPeriodEnd} is not null)`
		)
	]
);

/**
 * Append-only credit ledger (FN-30). A row is a fact: positive `delta` = grant, negative = spend, never zero
 * and never above MAX_LEDGER_DELTA in size (CHECK). A mistaken grant is corrected by a second, negative row,
 * never by editing the first. The balance is SUM(delta) in SQL (billing/gate.ts creditBalance), never stored.
 * `user_id` becomes null when the account is deleted: the history stays, unreachable by any route.
 */
export const creditLedger = sqliteTable(
	'credit_ledger',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
		delta: integer('delta').notNull(),
		reason: text('reason', { enum: LEDGER_REASONS }).notNull(),
		/** A voucher id or a billing-event id; null for the starter grant. */
		referenceId: text('reference_id'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		index('credit_ledger_user_idx').on(t.userId, t.createdAt, t.id),
		check(
			'credit_ledger_delta_check',
			sql`typeof(${t.delta}) = 'integer' and ${t.delta} <> 0
				and ${t.delta} between -1000000000 and 1000000000
				and ${t.reason} in ('starter_grant', 'monthly_grant', 'voucher_redeemed', 'gmail_lookback_purchase', 'admin_adjustment', 'ai_capture_spend')`
		)
	]
);

export const VOUCHER_KINDS = ['credits', 'plan_days'] as const;
export type VoucherKind = (typeof VOUCHER_KINDS)[number];

/**
 * Voucher codes (FN-30). Only the SHA-256 of the code is stored (like `space_invites.token_hash`): a leaked
 * row is not a usable code. `redemption_count` changes only through the guarded redeem batch
 * (billing/vouchers.ts) and can never pass `max_redemptions` (CHECK). Revoked = `deleted_at` set.
 */
export const vouchers = sqliteTable(
	'vouchers',
	{
		id: text('id').primaryKey(),
		codeHash: text('code_hash').notNull().unique(),
		kind: text('kind', { enum: VOUCHER_KINDS }).notNull(),
		creditsAmount: integer('credits_amount'),
		plan: text('plan', { enum: PLANS }),
		planDays: integer('plan_days'),
		maxRedemptions: integer('max_redemptions').notNull(),
		redemptionCount: integer('redemption_count').notNull().default(0),
		expiresAt: integer('expires_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check(
			'vouchers_content_check',
			sql`${t.maxRedemptions} >= 1 and ${t.redemptionCount} between 0 and ${t.maxRedemptions}
				and ((${t.kind} = 'credits' and ${t.creditsAmount} between 1 and 1000000000
						and ${t.plan} is null and ${t.planDays} is null)
					or (${t.kind} = 'plan_days' and ${t.creditsAmount} is null and ${t.plan} in ('pro', 'agen')
						and ${t.planDays} between 1 and 366))`
		)
	]
);

/**
 * One row per (voucher, user): the unique index itself refuses a second redemption by the same account, so no
 * application check can be raced past. Append-only; `user_id` → null on account deletion (the code stays
 * used, without the account).
 */
export const voucherRedemptions = sqliteTable(
	'voucher_redemptions',
	{
		id: text('id').primaryKey(),
		voucherId: text('voucher_id')
			.notNull()
			.references(() => vouchers.id),
		userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
		redeemedAt: integer('redeemed_at').notNull()
	},
	(t) => [uniqueIndex('voucher_redemptions_voucher_user_uq').on(t.voucherId, t.userId)]
);

export const BILLING_PROVIDERS = ['mock', 'xendit', 'midtrans'] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];
export const BILLING_EVENT_KINDS = [
	'checkout_created',
	'payment_succeeded',
	'payment_failed',
	// A verified payment that granted nothing (a lower tier while a higher plan runs, or its checkout had
	// expired): money a real provider would have taken, so it needs a refund (billing/refunds.ts).
	'paid_not_applied'
] as const;
export type BillingEventKind = (typeof BILLING_EVENT_KINDS)[number];

/**
 * One row per payment-provider interaction (FN-30), append-only. The unique (provider, provider_event_id)
 * index IS the replay protection: a second delivery of an event cannot insert a second row, so the webhook's
 * effect is applied only by the batch whose insert added the row (billing/webhook.ts). A second
 * `payment_succeeded` for the same checkout `reference` is refused by its own partial unique index, so even a
 * provider re-sending one payment under a new event id never grants twice. The raw webhook body is never
 * stored, only these fields.
 */
export const billingEvents = sqliteTable(
	'billing_events',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
		provider: text('provider', { enum: BILLING_PROVIDERS }).notNull(),
		providerEventId: text('provider_event_id').notNull(),
		kind: text('kind', { enum: BILLING_EVENT_KINDS }).notNull(),
		/** The provider's checkout reference the event belongs to. */
		reference: text('reference'),
		/** The plan a checkout is for (set on `checkout_created` and on the payment it completes). */
		plan: text('plan', { enum: PLANS }),
		amountMinor: integer('amount_minor'),
		currency: text('currency'),
		signatureValid: integer('signature_valid', { mode: 'boolean' }).notNull(),
		createdAt: integer('created_at').notNull(),
		/** Repeated deliveries of this event (or of this checkout's payment): counted here, never new rows. */
		replayCount: integer('replay_count').notNull().default(0),
		lastSeenAt: integer('last_seen_at')
	},
	(t) => [
		uniqueIndex('billing_events_provider_event_uq').on(t.provider, t.providerEventId),
		uniqueIndex('billing_events_paid_reference_uq')
			.on(t.provider, t.reference)
			.where(sql`kind in ('payment_succeeded', 'paid_not_applied')`),
		uniqueIndex('billing_events_checkout_reference_uq')
			.on(t.provider, t.reference)
			.where(sql`kind = 'checkout_created'`),
		index('billing_events_user_idx').on(t.userId, t.createdAt),
		index('billing_events_kind_idx').on(t.kind, t.createdAt),
		check(
			'billing_events_kind_check',
			sql`${t.provider} in ('mock', 'xendit', 'midtrans')
				and ${t.kind} in ('checkout_created', 'payment_succeeded', 'payment_failed', 'paid_not_applied')
				and ${t.replayCount} >= 0
				and (${t.plan} is null or ${t.plan} in ('pro', 'agen'))
				and (${t.amountMinor} is null or ${t.amountMinor} between 0 and 9007199254740991)`
		)
	]
);

/**
 * A refund obligation (FN-30 hardening): one row per `paid_not_applied` billing event, written in the webhook's
 * own batch from that stored event (billing/webhook.ts), so the kind and the obligation never disagree. MONTRA
 * moves no money: a row is a record that a person, or a later provider integration, closes once
 * (`recordRefundOutcome`, billing/refunds.ts). Triggers in migration 0031 refuse every DELETE and every UPDATE
 * except the FK's `user_id` → null after the account is gone and the one move from `pending` to `refunded` or
 * `cancelled`. `reason = 'unknown'` only for rows backfilled by the migration.
 */
export const billingRefunds = sqliteTable(
	'billing_refunds',
	{
		id: text('id').primaryKey(),
		billingEventId: text('billing_event_id')
			.notNull()
			.unique()
			.references(() => billingEvents.id),
		userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
		provider: text('provider', { enum: BILLING_PROVIDERS }).notNull(),
		reference: text('reference'),
		amountMinor: integer('amount_minor'),
		currency: text('currency'),
		reason: text('reason', { enum: REFUND_REASONS }).notNull(),
		status: text('status', { enum: REFUND_STATUSES }).notNull(),
		/** The provider's refund id, once a refund was made there (at most 100 of `[A-Za-z0-9_.:-]`). */
		providerRefundId: text('provider_refund_id'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		resolvedAt: integer('resolved_at')
	},
	(t) => [
		index('billing_refunds_status_idx').on(t.status, t.createdAt),
		index('billing_refunds_user_idx').on(t.userId, t.createdAt),
		check(
			'billing_refunds_check',
			sql`${t.provider} in ('mock', 'xendit', 'midtrans')
				and ${t.reason} in ('checkout_expired', 'plan_higher', 'unknown')
				and ${t.status} in ('pending', 'refunded', 'cancelled')
				and (${t.amountMinor} is null or ${t.amountMinor} between 0 and 9007199254740991)
				and ((${t.status} = 'pending') = (${t.resolvedAt} is null))
				and (${t.providerRefundId} is null or (length(${t.providerRefundId}) between 1 and 100
					and ${t.providerRefundId} not glob '*[^A-Za-z0-9_.:-]*'))`
		)
	]
);

export const CLAIM_MARKER_KINDS = ['starter_grant', 'voucher'] as const;
export type ClaimMarkerKind = (typeof CLAIM_MARKER_KINDS)[number];

/**
 * Re-claim markers (FN-30 hardening, red team L4): written only when an account is deleted, so the same address
 * signing up again cannot take the starter credits or a per-person voucher a second time. `email_hmac` is an
 * HMAC of the canonical address under the Worker secret CLAIM_HASH_KEY (billing/claims.ts): never the address.
 * No `user_id`: a marker cannot be linked to any account. Swept 730 days after it was written (jobs Worker).
 */
export const claimMarkers = sqliteTable(
	'claim_markers',
	{
		emailHmac: text('email_hmac').notNull(),
		kind: text('kind', { enum: CLAIM_MARKER_KINDS }).notNull(),
		/** Set only for `voucher`: the voucher this address already redeemed. */
		voucherId: text('voucher_id'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		uniqueIndex('claim_markers_uq').on(t.emailHmac, t.kind, sql`ifnull(${t.voucherId}, '')`),
		index('claim_markers_created_idx').on(t.createdAt),
		check(
			'claim_markers_check',
			sql`length(${t.emailHmac}) = 43
				and ${t.kind} in ('starter_grant', 'voucher')
				and ((${t.kind} = 'voucher') = (${t.voucherId} is not null))`
		)
	]
);

export const PLAN_CHANGE_SOURCES = ['payment', 'voucher'] as const;

/**
 * Audit of every plan change (FN-30), append-only: written in the same batch as the `user_plan_state` write,
 * under the same guard, so a change without its audit row (or the reverse) cannot happen. `reference_id` is
 * the billing event or voucher redemption that caused it. `user_id` → null on account deletion.
 */
export const planChanges = sqliteTable(
	'plan_changes',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
		fromPlan: text('from_plan', { enum: PLANS }).notNull(),
		toPlan: text('to_plan', { enum: PLANS }).notNull(),
		periodEnd: integer('period_end').notNull(),
		source: text('source', { enum: PLAN_CHANGE_SOURCES }).notNull(),
		referenceId: text('reference_id').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		index('plan_changes_user_idx').on(t.userId, t.createdAt),
		check(
			'plan_changes_check',
			sql`${t.fromPlan} in ('gratis', 'pro', 'agen') and ${t.toPlan} in ('pro', 'agen')
				and ${t.source} in ('payment', 'voucher')`
		)
	]
);
/**
 * What a person agreed to at sign-up (FN-31, UU PDP): one row per consent kind, with the id (`version`, the
 * date the shown text last changed) of the text accepted. Account-scoped like `account_keys`: no space.
 * Append-only: a trigger in the migration refuses every UPDATE; a newer version is a new row. Removed with
 * the account (delete-account.ts), since it records this person's own action, not shared-space history.
 */
export const consentRecords = sqliteTable(
	'consent_records',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: CONSENT_KINDS }).notNull(),
		version: text('version').notNull(),
		acceptedAt: integer('accepted_at').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		index('consent_records_user_idx').on(t.userId, t.acceptedAt),
		check(
			'consent_records_kind_check',
			sql`${t.kind} in ('terms', 'privacy_policy', 'cross_border_notice')`
		)
	]
);

/**
 * The usage-statistics switch (FN-31), shaped like `notification_prefs`: no row = statistics on; one row per
 * user, overwritten in place. Read by `trackEvent` before any write. Deleted with the account.
 */
export const usageStatsPrefs = sqliteTable('usage_stats_prefs', {
	userId: text('user_id')
		.primaryKey()
		.references(() => users.id, { onDelete: 'cascade' }),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

/**
 * "Tutup hari" (FN-34): one row per WIB date the user closed. Account-scoped, not space data (owner decision A:
 * one streak across every space), carries no money and is never edited or deleted, so it has no `space_id`,
 * `deleted_at` or sync sequence. The unique index makes a second close of the same day a no-op.
 */
export const dayClosures = sqliteTable(
	'day_closures',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** The WIB calendar date closed (`YYYY-MM-DD`), never the UTC date; any other form is refused by triggers (0024). */
		closedOn: text('closed_on').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [uniqueIndex('day_closures_user_day_idx').on(t.userId, t.closedOn)]
);

/**
 * FN-34b budget streak: one verdict per space and WIB date, `within` when that day's real expense spending (in
 * the budget's currency, demo rows and transfers excluded) stayed at or under that day's safe-to-spend, `over`
 * otherwise. Written once by the jobs Worker on the first open tick of the next WIB day, from the budget live
 * at that moment (owner decision F), and never updated: a later edit of that day's transactions never rewrites
 * the verdict. A day without a live budget has no row (a skip, never a break). Derived data with no money in
 * it, not synced; purged with the space (SPACE_SCOPED_TABLES). `date` must be `YYYY-MM-DD` (triggers, 0038).
 */
export const budgetStreakDays = sqliteTable(
	'budget_streak_days',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		/** The WIB calendar date judged, never the UTC date. */
		date: text('date').notNull(),
		status: text('status', { enum: BUDGET_DAY_STATUSES }).notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		uniqueIndex('budget_streak_days_space_date_uq').on(t.spaceId, t.date),
		check('budget_streak_days_status_check', sql`${t.status} in ('within', 'over')`)
	]
);

/**
 * FN-19 e-mail forwarding: one secret address per user, pointing at one space ("Dicatat ke"). An account
 * credential like `ai_keys` (per user, never synced): no `deleted_at` or `seq`. `local_part` is unique across every
 * row, revoked ones included, so a revoked address is never issued again; one active address per user (partial
 * unique index). `window_start`/`window_count` are the hourly receive budget (one guarded UPDATE per mail).
 */
export const inboundAddresses = sqliteTable(
	'inbound_addresses',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		localPart: text('local_part').notNull(),
		status: text('status', { enum: INBOUND_ADDRESS_STATUSES }).notNull(),
		windowStart: integer('window_start').notNull(),
		windowCount: integer('window_count').notNull().default(0),
		lastReceivedAt: integer('last_received_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		revokedAt: integer('revoked_at')
	},
	(t) => [
		uniqueIndex('inbound_addresses_local_uq').on(t.localPart),
		uniqueIndex('inbound_addresses_active_uq')
			.on(t.userId)
			.where(sql`status = 'active'`),
		index('inbound_addresses_space_idx').on(t.spaceId),
		check('inbound_addresses_status_check', sql`${t.status} in ('active', 'revoked')`),
		check(
			'inbound_addresses_revoked_check',
			sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`
		),
		check(
			'inbound_addresses_content_check',
			sql`length(${t.localPart}) = 28 and substr(${t.localPart}, 1, 2) = 'm-' and ${t.windowCount} >= 0`
		)
	]
);

/**
 * FN-19: what happened to each received mail (the ledger the settings page lists, and the idempotency record of
 * the inbound Worker: unique per address and `message_key`, a hex128 SHA-256 of the Message-ID). The CHECKs keep
 * the privacy rules in the schema itself: a `not_payment` row holds the id and date only; mail text
 * (`pending_text`) exists only while `queued` (the AI read); a confirmation code only on a `confirmation` row.
 * Deleted after 90 days by the jobs Worker's sweep (owner decision 4).
 */
export const inboundMail = sqliteTable(
	'inbound_mail',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		addressId: text('address_id')
			.notNull()
			.references(() => inboundAddresses.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		messageKey: text('message_key').notNull(),
		receivedAt: integer('received_at').notNull(),
		status: text('status', { enum: INBOUND_MAIL_STATUSES }).notNull(),
		reason: text('reason', { enum: INBOUND_MAIL_REASONS }),
		trust: text('trust', { enum: INBOUND_TRUST }),
		parser: text('parser', { enum: INBOUND_PARSERS }),
		senderDomain: text('sender_domain'),
		subject: text('subject'),
		pendingText: text('pending_text'),
		confirmationCode: text('confirmation_code'),
		updatedAt: integer('updated_at').notNull(),
		// The draft this delivery inserted (Gmail red team L2, migration 0035): account deletion discards the
		// account's pending forwarded drafts through it. No FK, like gmail_mail.draft_id; added last by ALTER.
		draftId: text('draft_id')
	},
	(t) => [
		uniqueIndex('inbound_mail_message_uq').on(t.addressId, t.messageKey),
		index('inbound_mail_status_idx').on(t.status, t.receivedAt),
		index('inbound_mail_user_idx').on(t.userId, t.receivedAt),
		index('inbound_mail_space_idx').on(t.spaceId),
		check(
			'inbound_mail_status_check',
			sql`${t.status} in ('queued', 'draft_created', 'not_payment', 'unreadable', 'confirmation')`
		),
		check(
			'inbound_mail_reason_check',
			sql`(${t.reason} is null or ${t.reason} in ('malformed', 'no_ai_key', 'ai_unconfigured', 'ai_failed', 'ai_invalid', 'expired', 'inbox_full', 'currency', 'unparsed'))
				and ((${t.status} = 'unreadable') = (${t.reason} is not null))`
		),
		check(
			'inbound_mail_trust_check',
			sql`${t.trust} is null or ${t.trust} in ('verified', 'forwarded', 'unverified')`
		),
		check(
			'inbound_mail_parser_check',
			sql`${t.parser} is null or ${t.parser} in ('bank-qris', 'ewallet-payment', 'bank-transfer-in', 'bank-transfer-out', 'ai')`
		),
		check(
			'inbound_mail_content_check',
			sql`length(${t.messageKey}) = 32
				and (${t.subject} is null or length(${t.subject}) <= 200)
				and (${t.senderDomain} is null or length(${t.senderDomain}) <= 80)
				and (${t.pendingText} is null or (${t.status} = 'queued' and length(${t.pendingText}) <= 6000))
				and (${t.confirmationCode} is null or (${t.status} = 'confirmation'
					and length(${t.confirmationCode}) between 1 and 12 and ${t.confirmationCode} not glob '*[^0-9]*'))`
		),
		check(
			'inbound_mail_not_payment_check',
			sql`${t.status} <> 'not_payment' or (${t.subject} is null and ${t.senderDomain} is null
				and ${t.parser} is null and ${t.trust} is null and ${t.pendingText} is null)`
		)
	]
);

/**
 * FN-19 Gmail auto-capture (docs/features/fn-19-gmail/PRD.md § 9): one Gmail connection per user (an account
 * credential like `ai_keys`: no `deleted_at` or `seq`), recording into one space ("Dicatat ke"). The refresh token
 * is sealed with CONNECTED_APPS_ENCRYPTION_KEY under Gmail's own labels (gmail/crypto.ts); an access token is never
 * stored. `checked_through` (epoch s) is where the next hourly check lists from; `quota_window_start`/`quota_units`
 * are the per-minute Gmail quota gate (one guarded UPDATE per call); `check_after` holds back a throttled
 * connection. Jobs never touch `updated_at`, so an open settings form only goes stale on a user-visible change.
 */
export const gmailConnections = sqliteTable(
	'gmail_connections',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		status: text('status', { enum: GMAIL_CONNECTION_STATUSES }).notNull(),
		reconnectReason: text('reconnect_reason', { enum: GMAIL_RECONNECT_REASONS }),
		pausedReason: text('paused_reason', { enum: GMAIL_PAUSED_REASONS }),
		googleAddress: text('google_address'),
		encryptedToken: text('encrypted_token').notNull(),
		tokenNonce: text('token_nonce').notNull(),
		tokenKeyId: text('token_key_id').notNull(),
		scope: text('scope').notNull(),
		autoCheck: integer('auto_check').notNull().default(1),
		checkedThrough: integer('checked_through').notNull(),
		checkAfter: integer('check_after').notNull().default(0),
		quotaWindowStart: integer('quota_window_start').notNull().default(0),
		quotaUnits: integer('quota_units').notNull().default(0),
		lastCheckedAt: integer('last_checked_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		// Red team L6: AI reads of this connection in its current 24-hour window (GMAIL_AI_READS_PER_DAY). Last, as
		// 0045 added them, so the insert-select in oauth.ts (columns in table order) matches.
		aiWindowStart: integer('ai_window_start').notNull().default(0),
		aiReads: integer('ai_reads').notNull().default(0)
	},
	(t) => [
		uniqueIndex('gmail_connections_user_uq').on(t.userId),
		index('gmail_connections_due_idx').on(t.status, t.autoCheck, t.id),
		index('gmail_connections_space_idx').on(t.spaceId),
		check('gmail_connections_status_check', sql`${t.status} in ('connected', 'needs_reconnect')`),
		check(
			'gmail_connections_reconnect_check',
			sql`(${t.reconnectReason} is null or ${t.reconnectReason} in ('revoked', 'key'))
				and ((${t.status} = 'needs_reconnect') = (${t.reconnectReason} is not null))`
		),
		check(
			'gmail_connections_paused_check',
			sql`${t.pausedReason} is null or (${t.pausedReason} in ('space_lost') and ${t.autoCheck} = 0)`
		),
		check(
			'gmail_connections_content_check',
			sql`length(${t.encryptedToken}) between 1 and 12000 and length(${t.tokenNonce}) = 16
				and length(${t.tokenKeyId}) = 11 and length(${t.scope}) between 1 and 2000
				and (${t.googleAddress} is null or length(${t.googleAddress}) <= 320)
				and ${t.autoCheck} in (0, 1) and ${t.quotaUnits} >= 0 and ${t.checkedThrough} >= 0`
		)
	]
);

/**
 * FN-19 Gmail: one listing pass over a connection's mailbox, hourly (`window` = the WIB hour, or the 5-minute
 * bucket of "Periksa sekarang") or a look-back (`days`). Unique per (connection, kind, window), so a repeated tick
 * or a redelivered message never opens a second scan; at most one running look-back per connection. `pages` is the
 * page the next `gmail_check` message must carry (a duplicate page message is acked unread); `after_s` is the
 * listing's lower bound (epoch s), fixed for the scan so every page answers the same query. Counters drive the
 * progress shown on the settings page.
 */
export const gmailScans = sqliteTable(
	'gmail_scans',
	{
		id: text('id').primaryKey(),
		connectionId: text('connection_id')
			.notNull()
			.references(() => gmailConnections.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: GMAIL_SCAN_KINDS }).notNull(),
		window: text('scan_window').notNull(),
		days: integer('days'),
		afterS: integer('after_s').notNull(),
		status: text('status', { enum: GMAIL_SCAN_STATUSES }).notNull(),
		pageToken: text('page_token'),
		pages: integer('pages').notNull().default(0),
		listed: integer('listed').notNull().default(0),
		read: integer('read').notNull().default(0),
		drafted: integer('drafted').notNull().default(0),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		uniqueIndex('gmail_scans_window_uq').on(t.connectionId, t.kind, t.window),
		uniqueIndex('gmail_scans_lookback_running_uq')
			.on(t.connectionId)
			.where(sql`kind = 'lookback' and status = 'running'`),
		index('gmail_scans_status_idx').on(t.status, t.updatedAt),
		check('gmail_scans_kind_check', sql`${t.kind} in ('hourly', 'lookback')`),
		check(
			'gmail_scans_status_check',
			sql`${t.status} in ('running', 'done', 'cancelled', 'failed')`
		),
		check(
			'gmail_scans_content_check',
			sql`length(${t.window}) between 1 and 40 and ${t.pages} between 0 and 20
				and ${t.listed} >= 0 and ${t.read} >= 0 and ${t.drafted} >= 0 and ${t.afterS} >= 0
				and (${t.pageToken} is null or length(${t.pageToken}) <= 512)
				and ((${t.kind} = 'lookback') = (${t.days} is not null))
				and (${t.days} is null or ${t.days} between 1 and 365)`
		)
	]
);

/**
 * FN-19 Gmail: what happened to each listed Gmail message (the ledger the settings page counts, and the
 * idempotency record: unique per connection and Gmail id). No column can hold mail text. The CHECKs keep the
 * privacy rules in the schema itself: a `listed` or `not_payment` row holds the id and date only; a reason exists
 * exactly on an `unreadable` row. `draft_id` is set only on the row whose read inserted that draft (a disconnect
 * discards those still pending). Deleted after 90 days by the jobs Worker's sweep.
 */
export const gmailMail = sqliteTable(
	'gmail_mail',
	{
		id: text('id').primaryKey(),
		connectionId: text('connection_id')
			.notNull()
			.references(() => gmailConnections.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		gmailId: text('gmail_id').notNull(),
		receivedAt: integer('received_at').notNull(),
		status: text('status', { enum: GMAIL_MAIL_STATUSES }).notNull(),
		reason: text('reason', { enum: GMAIL_MAIL_REASONS }),
		trust: text('trust', { enum: GMAIL_TRUST }),
		parser: text('parser', { enum: INBOUND_PARSERS }),
		senderDomain: text('sender_domain'),
		subject: text('subject'),
		draftId: text('draft_id'),
		scanId: text('scan_id'),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		uniqueIndex('gmail_mail_message_uq').on(t.connectionId, t.gmailId),
		index('gmail_mail_status_idx').on(t.status, t.updatedAt),
		index('gmail_mail_user_idx').on(t.userId, t.receivedAt),
		index('gmail_mail_scan_idx').on(t.scanId),
		index('gmail_mail_space_idx').on(t.spaceId),
		check(
			'gmail_mail_status_check',
			sql`${t.status} in ('listed', 'draft_created', 'not_payment', 'unreadable')`
		),
		check(
			'gmail_mail_reason_check',
			sql`(${t.reason} is null or ${t.reason} in ('malformed', 'too_large', 'gone', 'fetch_failed', 'no_ai_key', 'ai_unconfigured', 'ai_failed', 'ai_invalid', 'expired', 'inbox_full', 'currency', 'unparsed', 'key', 'ai_limit'))
				and ((${t.status} = 'unreadable') = (${t.reason} is not null))`
		),
		check(
			'gmail_mail_trust_check',
			sql`${t.trust} is null or ${t.trust} in ('verified', 'unverified')`
		),
		check(
			'gmail_mail_parser_check',
			sql`${t.parser} is null or ${t.parser} in ('bank-qris', 'ewallet-payment', 'bank-transfer-in', 'bank-transfer-out', 'ai')`
		),
		check(
			'gmail_mail_content_check',
			sql`length(${t.gmailId}) between 1 and 64
				and (${t.subject} is null or length(${t.subject}) <= 200)
				and (${t.senderDomain} is null or length(${t.senderDomain}) <= 80)
				and (${t.draftId} is null or ${t.status} = 'draft_created')`
		),
		check(
			'gmail_mail_id_only_check',
			sql`${t.status} not in ('listed', 'not_payment') or (${t.subject} is null and ${t.senderDomain} is null
				and ${t.parser} is null and ${t.trust} is null and ${t.draftId} is null)`
		)
	]
);

/**
 * FN-19 Gmail: one unfinished OAuth authorization (PRD § 3). Keyed by the SHA-256 of `state` (never the state
 * itself), bound to the user and the session that started it (`session_hash` = `sessions.token_hash`), single-use
 * (the callback deletes it in the statement that reads it) and valid 10 minutes. The PKCE verifier is sealed with
 * the Gmail key, bound to the state hash. At most 5 per user; expired rows are swept hourly.
 */
export const oauthStates = sqliteTable(
	'oauth_states',
	{
		stateHash: text('state_hash').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		sessionHash: text('session_hash').notNull(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		purpose: text('purpose', { enum: ['gmail'] }).notNull(),
		ciphertext: text('ciphertext').notNull(),
		nonce: text('nonce').notNull(),
		keyId: text('key_id').notNull(),
		createdAt: integer('created_at').notNull(),
		expiresAt: integer('expires_at').notNull()
	},
	(t) => [
		index('oauth_states_user_idx').on(t.userId, t.createdAt),
		index('oauth_states_expiry_idx').on(t.expiresAt),
		check('oauth_states_purpose_check', sql`${t.purpose} in ('gmail')`),
		check(
			'oauth_states_content_check',
			sql`length(${t.stateHash}) = 64 and length(${t.sessionHash}) = 64
				and length(${t.ciphertext}) between 1 and 400 and length(${t.nonce}) = 16
				and length(${t.keyId}) = 11 and ${t.expiresAt} > ${t.createdAt}`
		)
	]
);

/**
 * Gmail grants waiting to be revoked at Google by the jobs Worker (red team L3/L4, migration 0035): the sealed
 * refresh token of a connection a space purge deleted (another member's, paused) or account deletion removed, or of
 * a grant a second authorization for another Google account replaced. The seal stays bound to (connection id, user
 * id), so neither column has a foreign key: the row must outlive both. Each row is tried a bounded number of times,
 * then dropped; it is never shown, exported or used for anything but the revoke call.
 */
export const gmailRevocations = sqliteTable(
	'gmail_revocations',
	{
		connectionId: text('connection_id').notNull(),
		tokenNonce: text('token_nonce').notNull(),
		userId: text('user_id').notNull(),
		googleAddress: text('google_address'),
		encryptedToken: text('encrypted_token').notNull(),
		tokenKeyId: text('token_key_id').notNull(),
		attempts: integer('attempts').notNull().default(0),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.connectionId, t.tokenNonce] }),
		index('gmail_revocations_created_idx').on(t.createdAt),
		check(
			'gmail_revocations_content_check',
			sql`length(${t.encryptedToken}) between 1 and 12000 and length(${t.tokenNonce}) = 16
				and length(${t.tokenKeyId}) = 11
				and (${t.googleAddress} is null or length(${t.googleAddress}) <= 320) and ${t.attempts} >= 0`
		)
	]
);

/**
 * Tanya (FN-22): one running conversation per (user, space), question and answer rows. Not synced and never
 * edited, so it has no `deleted_at` or sync sequence (like `ai_keys`): "Percakapan baru", "Hapus semua percakapan"
 * and the 30-day expiry delete rows outright. `body` is the question or the checked answer text (never an
 * unverified figure), `cards_json` the server-computed figure cards of an answer. Token counts and the number of
 * tool calls are kept on the answer row for the later usage page (FN-42); the API key and raw tool results are
 * never stored. Purged with the space (SPACE_SCOPED_TABLES) and with the account.
 */
export const tanyaMessages = sqliteTable(
	'tanya_messages',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		role: text('role', { enum: TANYA_ROLES }).notNull(),
		body: text('body').notNull(),
		cardsJson: text('cards_json'),
		inputTokens: integer('input_tokens'),
		outputTokens: integer('output_tokens'),
		toolCalls: integer('tool_calls'),
		createdAt: integer('created_at').notNull(),
		expiresAt: integer('expires_at').notNull()
	},
	(t) => [
		index('tanya_messages_user_space_idx').on(t.userId, t.spaceId, t.createdAt),
		check('tanya_messages_role_check', sql`${t.role} in ('user', 'assistant')`),
		check(
			'tanya_messages_content_check',
			sql`length(${t.body}) between 1 and 4000
				and (${t.cardsJson} is null or length(${t.cardsJson}) <= 32768)
				and (${t.role} = 'assistant' or (${t.cardsJson} is null and ${t.inputTokens} is null
					and ${t.outputTokens} is null and ${t.toolCalls} is null))
				and ${t.expiresAt} > ${t.createdAt}`
		)
	]
);

/**
 * Merchant rules (FN-20): what a space learned from its members' category corrections. One live rule per (space,
 * normalised descriptor key, kind); a second correction updates it (`hits` + 1), never a second row. The key is
 * the cleaned descriptor (letters, digits, single spaces; no digit runs, account numbers, amounts or dates), the
 * name its Title Case form. Deleting a rule leaves a content-free tombstone (name and category cleared); the
 * partial unique index then allows the same key to be learned again. `created_by` is cleared when that account
 * is deleted (the rule stays with the space). Purged with the space (SPACE_SCOPED_TABLES).
 */
export const merchantRules = sqliteTable(
	'merchant_rules',
	{
		id: text('id').primaryKey(),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		matchKey: text('match_key').notNull(),
		merchantName: text('merchant_name'),
		categoryId: text('category_id').references(() => categories.id),
		kind: text('kind', { enum: CATEGORY_KINDS }).notNull(),
		hits: integer('hits').notNull().default(1),
		source: text('source', { enum: MERCHANT_RULE_SOURCES }).notNull(),
		createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at'),
		seq: integer('seq').notNull()
	},
	(t) => [
		uniqueIndex('merchant_rules_live_uq')
			.on(t.spaceId, t.matchKey, t.kind)
			.where(sql`deleted_at is null`),
		index('merchant_rules_space_idx').on(t.spaceId, t.deletedAt, t.updatedAt),
		check('merchant_rules_kind_check', sql`${t.kind} in ('expense', 'income')`),
		check('merchant_rules_source_check', sql`${t.source} in ('correction', 'manual')`),
		check(
			'merchant_rules_content_check',
			sql`length(${t.matchKey}) between 1 and 60 and ${t.hits} >= 1
				and (${t.deletedAt} is not null or (${t.merchantName} is not null
					and length(${t.merchantName}) between 1 and 80 and ${t.categoryId} is not null))
				and (${t.deletedAt} is null or (${t.merchantName} is null and ${t.categoryId} is null))`
		)
	]
);

/**
 * The AI step's answers (FN-20), per space and normalised key, for 90 days: a second batch with the same
 * descriptors makes no provider call. Holds only the cleaned key, the cleaned name and the category the model
 * chose from the space's own list (null: the model named none); never raw descriptors, amounts, dates or account
 * numbers. A failed call is never cached. Rows past `expires_at` are ignored and swept in small bounded deletes.
 * Not synced (a cache, like `tanya_messages`). Purged with the space (SPACE_SCOPED_TABLES).
 */
export const merchantCache = sqliteTable(
	'merchant_cache',
	{
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		matchKey: text('match_key').notNull(),
		kind: text('kind', { enum: CATEGORY_KINDS }).notNull(),
		merchantName: text('merchant_name'),
		categoryId: text('category_id').references(() => categories.id),
		reason: text('reason', { enum: MERCHANT_CACHE_REASONS }).notNull(),
		createdAt: integer('created_at').notNull(),
		expiresAt: integer('expires_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.spaceId, t.matchKey, t.kind] }),
		index('merchant_cache_expiry_idx').on(t.spaceId, t.expiresAt),
		check('merchant_cache_kind_check', sql`${t.kind} in ('expense', 'income')`),
		check('merchant_cache_reason_check', sql`${t.reason} in ('ai')`),
		check(
			'merchant_cache_content_check',
			sql`length(${t.matchKey}) between 1 and 60
				and (${t.merchantName} is null or length(${t.merchantName}) between 1 and 80)
				and ${t.expiresAt} > ${t.createdAt}`
		)
	]
);

/**
 * Agen (beta) report runs (FN-23): one row per requested report, the step machine the jobs Worker advances
 * (`steps_done`, a 120 s `lease_until`, compare-and-set on every step) and, once ready, the two R2 files
 * (`spaces/<space>/agent/<run>/<uuid>.<ext>`). Only the member who created a run sees or downloads it. The id is a
 * hash of the user and the form's one-time request id, so a double submit is the same row. `facts_json` holds
 * the figures computed by code (nulled when a run fails); `narrative_text` the guarded AI narrative. Not a synced
 * table (no `deleted_at`/seq, like `tanya_messages`): derived, never edited, deleted outright by "Hapus", the
 * 30-day (ready) or 7-day (unfinished/failed) expiry, account delete and space delete, its keys going to the
 * file-deletion outbox in the same batch.
 */
export const agentRuns = sqliteTable(
	'agent_runs',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		spaceId: text('space_id')
			.notNull()
			.references(() => spaces.id, { onDelete: 'cascade' }),
		type: text('type', { enum: AGENT_TYPES }).notNull(),
		period: text('period').notNull(),
		withNarrative: integer('with_narrative', { mode: 'boolean' }).notNull(),
		locale: text('locale', { enum: AGENT_LOCALES }).notNull(),
		status: text('status', { enum: AGENT_STATUSES }).notNull(),
		stepsDone: integer('steps_done').notNull().default(0),
		failure: text('failure', { enum: AGENT_FAILURES }),
		narrativeState: text('narrative_state', { enum: AGENT_NARRATIVE_STATES })
			.notNull()
			.default('none'),
		narrativeReason: text('narrative_reason', { enum: AGENT_NARRATIVE_REASONS }),
		factsJson: text('facts_json'),
		narrativeText: text('narrative_text'),
		csvKey: text('csv_key'),
		htmlKey: text('html_key'),
		csvBytes: integer('csv_bytes'),
		htmlBytes: integer('html_bytes'),
		aiInputTokens: integer('ai_input_tokens'),
		aiOutputTokens: integer('ai_output_tokens'),
		attempts: integer('attempts').notNull().default(0),
		leaseUntil: integer('lease_until'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		readyAt: integer('ready_at'),
		expiresAt: integer('expires_at').notNull(),
		// Red team S2: "Hapus" within 24 h of creation leaves a contentless tombstone (failed, no keys, no facts)
		// until `created_at` + 24 h, so the daily caps still count it; list, download and the live cap skip it.
		deletedAt: integer('deleted_at')
	},
	(t) => [
		index('agent_runs_user_space_idx').on(t.userId, t.spaceId, t.createdAt),
		index('agent_runs_space_idx').on(t.spaceId, t.createdAt),
		index('agent_runs_status_idx').on(t.status, t.updatedAt),
		index('agent_runs_expiry_idx').on(t.expiresAt),
		// The file sweep's "still referenced" guard looks keys up (photos/store.ts sweepFileDeletions).
		index('agent_runs_csv_key_idx').on(t.csvKey),
		index('agent_runs_html_key_idx').on(t.htmlKey),
		check('agent_runs_type_check', sql`${t.type} in ('monthly', 'annual', 'spt_assets')`),
		check('agent_runs_status_check', sql`${t.status} in ('queued', 'running', 'ready', 'failed')`),
		check('agent_runs_locale_check', sql`${t.locale} in ('id', 'en')`),
		check(
			'agent_runs_failure_check',
			sql`${t.failure} is null or ${t.failure} in ('plan', 'empty', 'access', 'internal')`
		),
		check(
			'agent_runs_narrative_check',
			sql`${t.narrativeState} in ('none', 'ai', 'skipped')
				and (${t.narrativeReason} is null or ${t.narrativeReason} in ('off', 'ai_unconfigured', 'no_key',
					'invalid', 'quota', 'refusal', 'malformed', 'max_tokens', 'model_unavailable', 'network', 'timeout',
					'guard'))
				and (${t.narrativeText} is null or length(${t.narrativeText}) between 1 and 2000)
				and ((${t.narrativeState} = 'ai') = (${t.narrativeText} is not null))`
		),
		check(
			'agent_runs_content_check',
			sql`((${t.type} = 'monthly' and length(${t.period}) = 7
					and ${t.period} glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]')
				or (${t.type} <> 'monthly' and length(${t.period}) = 4 and ${t.period} glob '[0-9][0-9][0-9][0-9]'))
				and ${t.withNarrative} in (0, 1)
				and ${t.stepsDone} between 0 and 5 and ${t.attempts} >= 0
				and (${t.factsJson} is null or length(${t.factsJson}) <= 262144)
				and ${t.expiresAt} > ${t.createdAt}
				and ((${t.status} = 'failed') = (${t.failure} is not null))
				and (${t.status} <> 'ready' or (${t.csvKey} is not null and ${t.htmlKey} is not null
					and ${t.csvBytes} is not null and ${t.htmlBytes} is not null and ${t.readyAt} is not null))
				and (${t.status} = 'ready' or (${t.csvKey} is null and ${t.htmlKey} is null
					and ${t.csvBytes} is null and ${t.htmlBytes} is null and ${t.readyAt} is null))`
		)
	]
);
