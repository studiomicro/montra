import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { wibIsoString } from '#lib/shared/dates';
import { maskAccountNumbers } from '#lib/shared/text';
import type { Db } from '../db';
import {
	accountKeys,
	aiKeyAudit,
	aiKeys,
	apiTokens,
	appMeta,
	authAttempts,
	authEvents,
	billingEvents,
	billingRefunds,
	claimMarkers,
	consentRecords,
	creditLedger,
	dayClosures,
	featureFlags,
	fileDeletions,
	gmailConnections,
	gmailMail,
	gmailRevocations,
	gmailScans,
	inboundAddresses,
	inboundMail,
	notificationDeliveries,
	notificationPrefs,
	oauthStates,
	passkeyChallenges,
	passkeySessions,
	passkeys,
	planChanges,
	pushSubscriptions,
	sessions,
	spaces,
	usageStatsPrefs,
	userNotifications,
	userPasswords,
	userPlanState,
	users,
	voucherRedemptions,
	vouchers
} from '../db/schema';
import { isLiveMember } from '../spaces/access';
import { SPACE_SCOPED_TABLES } from '../spaces/spaces';

/**
 * What the full-account export (FN-31, ruling R21: a UU PDP copy holds all of the user's data) does with every
 * table. Each space-scoped table (SPACE_SCOPED_TABLES) and each account table has an explicit decision here;
 * a test fails when a table is added to the schema without one.
 *
 * Exported tables are written as JSON, one file per table, rows as the app shows them: live rows only (no
 * tombstones), money as integer minor units with their currency column, instants as WIB ISO 8601 strings,
 * booleans as booleans, account-number-like digits in free text masked to the last 4. Never written: token,
 * hash, salt, nonce, key or push-endpoint material, another member's user id, internal dedupe or data keys.
 */
export type TableDecision =
	| {
			export: 'json';
			/** Columns never written (secrets, internal keys, other people's ids). */
			omit?: readonly string[];
			/** Only the rows addressed to the exporting user (`user_id` = them), e.g. notifications. */
			ownRowsOnly?: boolean;
			/** The photo kind of a table with `photo_key`/`photo_type` (written as `photo`, a path in the ZIP). */
			photo?: 'belongings' | 'collectibles' | 'receipts';
			/** Leaves out fictional `Data demo` rows (`is_demo = 1`), as the FN-18 CSV beside it does. */
			realRowsOnly?: boolean;
			/** Leaves out rows whose `expires_at` (epoch ms) has passed but which a purge has not removed yet. */
			unexpiredOnly?: boolean;
	  }
	| { export: 'custom' | 'none'; reason: string };

type SpaceTableName = (typeof SPACE_SCOPED_TABLES)[number]['_']['name'];

/** Every space-scoped table: the compiler requires a decision for each one. */
export const SPACE_TABLE_DECISIONS: Readonly<Record<SpaceTableName, TableDecision>> = {
	// FN-19: exported once per account (ACCOUNT_TABLE_DECISIONS), by user_id, so rows of a space the user has
	// left are included too (red team L5); listed here only because the rows carry a space_id (purged with it).
	inbound_mail: {
		export: 'none',
		reason: 'exported with the account (by user_id), see account tables'
	},
	inbound_addresses: {
		export: 'none',
		reason: 'exported with the account (by user_id), see account tables'
	},
	// FN-19 Gmail: likewise exported once per account (by user_id); the authorizations are never exported.
	gmail_mail: {
		export: 'none',
		reason: 'exported with the account (by user_id), see account tables'
	},
	gmail_connections: {
		export: 'none',
		reason: 'exported with the account (by user_id), see account tables'
	},
	oauth_states: {
		export: 'none',
		reason:
			'unfinished Gmail authorizations: state and session hashes, sealed verifier (10 minutes)'
	},
	// FN-22: the exporting user's own questions and answers in this space (another member's never); the token and
	// tool-call counts are internal usage metadata.
	tanya_messages: {
		export: 'json',
		ownRowsOnly: true,
		unexpiredOnly: true,
		omit: ['input_tokens', 'output_tokens', 'tool_calls']
	},
	// FN-23: the user's own generated reports; the CSV/HTML files are downloads they already hold.
	agent_runs: {
		export: 'none',
		reason: "generated reports expire after 30 days; the files are the user's own downloads"
	},
	// FN-20: the space's learned merchant rules as the settings page lists them; the member who taught one is
	// another person's id. The AI cache is derived data the app never shows.
	merchant_rules: { export: 'json', omit: ['created_by'] },
	// FN-26b: the keys the space answered "Bukan langganan" for; the member who did is another person's id.
	subscription_dismissals: { export: 'json', omit: ['created_by'] },
	merchant_cache: {
		export: 'none',
		reason: 'internal 90-day cache of AI answers, not shown in the app'
	},
	connected_apps: {
		export: 'json',
		omit: ['encrypted_token', 'token_nonce', 'token_key_id', 'created_by_user_id']
	},
	subscriptions: { export: 'json' },
	space_notifications: { export: 'json', ownRowsOnly: true, omit: ['user_id', 'data_key'] },
	net_worth_items: { export: 'json' },
	net_worth_snapshots: { export: 'json' },
	budget_streak_days: { export: 'json' },
	belongings: { export: 'json', photo: 'belongings' },
	collectibles: { export: 'json', photo: 'collectibles' },
	goal_contributions: { export: 'json', omit: ['created_by_user_id'] },
	goals: { export: 'json' },
	drafts: { export: 'json', omit: ['dedupe_key'] },
	// Every live row of every type (expense, income, transfer, balance adjustment) as JSON; the FN-18 CSV
	// beside it (transactions-NN-<space>.csv, written by account-export.ts) keeps only expense and income rows.
	transactions: { export: 'json', omit: ['dedupe_key'], realRowsOnly: true, photo: 'receipts' },
	// FN-49: each split and every share as the app shows them; account ids of other people are left out.
	patungan_splits: { export: 'json', omit: ['created_by_user_id'], realRowsOnly: true },
	patungan_participants: { export: 'json', omit: ['member_user_id'] },
	patungan_share_links: {
		export: 'none',
		reason: 'share-link token hashes are bearer-secret material'
	},
	import_batches: { export: 'json', omit: ['created_by_user_id'] },
	// FN-48 "Rapikan kategori": each clean-up and the category each changed row had before and after.
	category_cleanup_batches: { export: 'json', omit: ['created_by_user_id'] },
	category_cleanup_items: { export: 'json' },
	// FN-48 Part C "Cocokkan transfer": each confirmed merge with both rows' previous content (the user's own rows).
	transfer_links: { export: 'json' },
	// FN-36: each series as the app shows it; the member it runs for may be someone else.
	recurring_transactions: { export: 'json', omit: ['created_by_user_id'] },
	budgets: { export: 'json' },
	category_budgets: { export: 'json' },
	categories: { export: 'json' },
	wallets: { export: 'json' },
	space_seq: { export: 'none', reason: 'internal sync counter, no user data' },
	audit_events: {
		export: 'none',
		reason: 'internal security log of member changes, not shown in the app'
	},
	space_invites: {
		export: 'none',
		reason: 'invite token hashes are bearer-secret material; the link itself is shown in Ruang'
	},
	space_members: {
		export: 'custom',
		reason: 'space.json: member names and roles as Ruang shows them'
	}
};

const ACCOUNT_TABLES = [
	users,
	userPasswords,
	sessions,
	apiTokens,
	aiKeys,
	aiKeyAudit,
	accountKeys,
	featureFlags,
	inboundAddresses,
	inboundMail,
	gmailConnections,
	gmailScans,
	gmailMail,
	oauthStates,
	gmailRevocations,
	notificationPrefs,
	notificationDeliveries,
	userNotifications,
	pushSubscriptions,
	consentRecords,
	usageStatsPrefs,
	userPlanState,
	creditLedger,
	voucherRedemptions,
	billingEvents,
	billingRefunds,
	planChanges,
	dayClosures,
	passkeys,
	passkeyChallenges,
	passkeySessions,
	authEvents
] as const;
type AccountTableName = (typeof ACCOUNT_TABLES)[number]['_']['name'];

/** Every account-level table (one `user_id` per row). */
export const ACCOUNT_TABLE_DECISIONS: Readonly<Record<AccountTableName, TableDecision>> = {
	users: { export: 'custom', reason: 'account.json: profile' },
	user_passwords: {
		export: 'none',
		reason: 'the password credential (hash, salt) is never exported'
	},
	sessions: { export: 'json', omit: ['token_hash'] },
	// FN-38: name, scope, restriction, last four and dates of every token; never the hash.
	api_tokens: { export: 'json', omit: ['token_hash'] },
	// FN-41: written field by field (never a row with columns left out), so a column added later cannot leak.
	ai_keys: {
		export: 'custom',
		reason:
			'account.json: whether an Anthropic key exists, when it was added and last tested; never the key'
	},
	ai_key_audit: { export: 'none', reason: 'internal security log, not shown in the app' },
	account_keys: {
		export: 'custom',
		reason: 'account.json says whether a key exists; key material is never exported'
	},
	feature_flags: { export: 'json' },
	// FN-19: the user's own forwarding addresses and mail ledger, every space included (also ones they left).
	// Never the address itself (a bearer secret), the hourly counter, mail text, a confirmation code or the
	// internal message key.
	inbound_addresses: { export: 'json', omit: ['local_part', 'window_start', 'window_count'] },
	inbound_mail: {
		export: 'json',
		omit: ['pending_text', 'confirmation_code', 'message_key', 'address_id', 'draft_id']
	},
	// FN-19 Gmail: the connection as the page shows it (address, target space, state, last check), the scans'
	// progress and the mail ledger (dates, status and reason codes, masked subject and sender domain of payment
	// mail). Never the sealed token, the quota counters, a page token, a Gmail id or a state hash.
	gmail_connections: {
		export: 'json',
		omit: [
			'encrypted_token',
			'token_nonce',
			'token_key_id',
			'quota_window_start',
			'quota_units',
			'check_after',
			'checked_through'
		]
	},
	gmail_scans: { export: 'json', omit: ['page_token', 'connection_id', 'after_s'] },
	gmail_mail: { export: 'json', omit: ['gmail_id', 'connection_id', 'scan_id', 'draft_id'] },
	oauth_states: {
		export: 'none',
		reason:
			'unfinished Gmail authorizations: state and session hashes, sealed verifier (10 minutes)'
	},
	gmail_revocations: {
		export: 'none',
		reason:
			'sealed Gmail refresh tokens waiting to be revoked at Google by the jobs Worker (red team L3/L4)'
	},
	notification_prefs: { export: 'json' },
	notification_deliveries: {
		export: 'none',
		reason: 'internal push-delivery claims (ids only, no content)'
	},
	user_notifications: { export: 'json', omit: ['data_key'] },
	push_subscriptions: {
		export: 'json',
		omit: ['endpoint', 'p256dh', 'auth', 'session_id']
	},
	consent_records: { export: 'json' },
	usage_stats_prefs: { export: 'json' },
	// FN-30: the plan, the credit history, the vouchers this user redeemed, payments and plan changes.
	user_plan_state: { export: 'json' },
	credit_ledger: { export: 'json' },
	voucher_redemptions: { export: 'json' },
	billing_events: {
		export: 'json',
		omit: ['provider_event_id', 'replay_count', 'last_seen_at']
	},
	plan_changes: { export: 'json' },
	// FN-30 hardening: this user's refund obligations (amount, status, dates), as on /pengaturan/paket.
	billing_refunds: { export: 'json' },
	// FN-34: the days this user closed (dates only).
	day_closures: { export: 'json' },
	// FN-50: each passkey as the page lists it (name, host, transports, synced, dates); never the credential id,
	// the public key or the signature counter.
	passkeys: { export: 'json', omit: ['credential_id', 'public_key', 'counter'] },
	passkey_challenges: {
		export: 'none',
		reason: 'single-use WebAuthn challenges, valid 5 minutes, no user data'
	},
	passkey_sessions: {
		export: 'none',
		reason: 'internal link from a session to the passkey that opened it (ids only)'
	},
	// FN-50: what happened to the account's passkeys and when (content-free, kept 90 days).
	auth_events: { export: 'json', omit: ['passkey_id'] }
};

/** Tables that hold no row of any one person's data (system state, hashed client counters, the outbox). */
export const SYSTEM_TABLES: Readonly<Record<string, string>> = {
	[getTableConfig(appMeta).name]: 'app markers, not user data',
	[getTableConfig(authAttempts).name]: 'per-client throttle counters keyed by a hash, no account',
	[getTableConfig(fileDeletions).name]: 'R2 deletion outbox, keys only',
	[getTableConfig(vouchers).name]:
		'voucher definitions (hashed codes) shared by everyone; the ones this user redeemed are in voucher_redemptions',
	[getTableConfig(spaces).name]: 'each live space is described in its own space.json',
	[getTableConfig(claimMarkers).name]:
		're-claim markers of deleted accounts: an HMAC of an address, no link to any account (FN-30 hardening)'
};

/** Free-text columns that may carry an account or card number: masked to the last 4 digits on export. */
const MASKED_COLUMNS = new Set([
	'name',
	'title',
	'note',
	'tag',
	'reference',
	'payment_method',
	'recurrence',
	'filename',
	'external_label',
	'category',
	'user_agent'
]);
/** Always left out: the space (it is the folder), the user (the export is theirs), sync and tombstone bookkeeping, R2 keys. */
const ALWAYS_OMITTED = new Set([
	'space_id',
	'user_id',
	'seq',
	'deleted_at',
	'photo_key',
	'photo_type'
]);

type Kind = 'bool' | 'time' | 'mask' | 'plain';
interface Column {
	name: string;
	key: string;
	kind: Kind;
}

export interface TablePlan {
	table: string;
	columns: Column[];
	hasDeletedAt: boolean;
	decision: Extract<TableDecision, { export: 'json' }>;
}

const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function plan(table: SQLiteTable, decision: Extract<TableDecision, { export: 'json' }>): TablePlan {
	const config = getTableConfig(table);
	const omit = new Set([...ALWAYS_OMITTED, ...(decision.omit ?? [])]);
	const names = config.columns.map((c) => c.name);
	return {
		table: config.name,
		hasDeletedAt: names.includes('deleted_at'),
		decision,
		columns: config.columns
			.filter((c) => !omit.has(c.name))
			.map((c) => ({
				name: c.name,
				key: camel(c.name),
				kind:
					c.columnType === 'SQLiteBoolean'
						? 'bool'
						: c.columnType === 'SQLiteInteger' && c.name.endsWith('_at')
							? 'time'
							: MASKED_COLUMNS.has(c.name)
								? 'mask'
								: 'plain'
			}))
	};
}

const isJson = (d: TableDecision): d is Extract<TableDecision, { export: 'json' }> =>
	d.export === 'json';

/** The space tables written as JSON, in SPACE_SCOPED_TABLES order. */
export const SPACE_JSON_TABLES: readonly TablePlan[] = SPACE_SCOPED_TABLES.flatMap((t) => {
	const decision = SPACE_TABLE_DECISIONS[getTableConfig(t).name as SpaceTableName];
	return isJson(decision) ? [plan(t, decision)] : [];
});

/** The account tables written as JSON. */
export const ACCOUNT_JSON_TABLES: readonly TablePlan[] = ACCOUNT_TABLES.flatMap((t) => {
	const decision = ACCOUNT_TABLE_DECISIONS[getTableConfig(t).name as AccountTableName];
	return isJson(decision) ? [plan(t, decision)] : [];
});

/** One exported row: the plan's columns, converted; `photo` set by the caller for photo tables. */
export function exportRow(
	p: TablePlan,
	row: Record<string, unknown>,
	photo?: (row: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const c of p.columns) {
		const v = row[c.name];
		out[c.key] =
			v === null || v === undefined
				? null
				: c.kind === 'bool'
					? v === 1 || v === true
					: c.kind === 'time' && typeof v === 'number'
						? wibIsoString(v)
						: c.kind === 'mask' && typeof v === 'string'
							? maskAccountNumbers(v)
							: v;
	}
	return photo ? { ...out, ...photo(row) } : out;
}

/** The rows of one table an export reads: `scope` names the space or the account. */
export type RowScope =
	{ kind: 'space'; spaceId: string; userId: string } | { kind: 'account'; userId: string };

/** The WHERE clause of `p` for `scope`; a space scope repeats the live membership on every page. */
export function scopeWhere(p: TablePlan, scope: RowScope): SQL {
	const parts: SQL[] = [];
	if (scope.kind === 'space') {
		parts.push(sql`space_id = ${scope.spaceId}`, isLiveMember(scope.spaceId, scope.userId));
		if (p.decision.ownRowsOnly) parts.push(sql`user_id = ${scope.userId}`);
	} else parts.push(sql`user_id = ${scope.userId}`);
	if (p.hasDeletedAt) parts.push(sql`deleted_at is null`);
	if (p.decision.realRowsOnly) parts.push(sql`is_demo = 0`);
	if (p.decision.unexpiredOnly) parts.push(sql`expires_at > ${Date.now()}`);
	return sql.join(parts, sql` and `);
}

/** Rows one page reads. */
export const EXPORT_TABLE_PAGE = 500;

/** Pages of `p`'s rows in `scope`, in rowid order (deterministic), each at most EXPORT_TABLE_PAGE rows. */
export async function* tablePages(
	db: Db,
	p: TablePlan,
	scope: RowScope,
	photoColumns = false
): AsyncGenerator<Record<string, unknown>[]> {
	const columns = sql.join(
		[
			...p.columns.map((c) => sql.identifier(c.name)),
			...(photoColumns ? [sql.identifier('photo_key'), sql.identifier('photo_type')] : [])
		],
		sql`, `
	);
	let after = -1;
	for (;;) {
		const rows = await db.all<Record<string, unknown> & { _rowid: number }>(
			sql`select rowid as _rowid, ${columns} from ${sql.identifier(p.table)}
				where ${scopeWhere(p, scope)} and rowid > ${after}
				order by rowid limit ${EXPORT_TABLE_PAGE}`
		);
		if (rows.length === 0) return;
		yield rows;
		after = (rows.at(-1) as { _rowid: number })._rowid;
		if (rows.length < EXPORT_TABLE_PAGE) return;
	}
}

/**
 * How many rows `p` holds for the export, counted up to `cap + 1`: across all of the user's live spaces
 * (`liveSpaceIds`, an SQL subquery) for a space table, the user's own rows for an account table.
 */
export async function countRows(
	db: Db,
	p: TablePlan,
	scope: { kind: 'space'; liveSpaceIds: SQL; userId: string } | { kind: 'account'; userId: string },
	cap: number
): Promise<number> {
	const parts: SQL[] =
		scope.kind === 'space'
			? [
					sql`space_id in ${scope.liveSpaceIds}`,
					...(p.decision.ownRowsOnly ? [sql`user_id = ${scope.userId}`] : [])
				]
			: [sql`user_id = ${scope.userId}`];
	if (p.hasDeletedAt) parts.push(sql`deleted_at is null`);
	if (p.decision.realRowsOnly) parts.push(sql`is_demo = 0`);
	if (p.decision.unexpiredOnly) parts.push(sql`expires_at > ${Date.now()}`);
	const row = await db.get<{ n: number }>(
		sql`select count(*) as n from (select 1 from ${sql.identifier(p.table)}
			where ${sql.join(parts, sql` and `)} limit ${cap + 1})`
	);
	return row?.n ?? 0;
}
