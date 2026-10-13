import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { authAttempts } from '../db/schema';
import { sha256Hex } from '../util';

/**
 * Per-client throttle, ported from the earlier project (`src/lib/server/auth/throttle.ts`) without the OIDC and MFA
 * budgets. Account lockout (password.ts) stops guessing at one account; this stops one client spraying many
 * accounts, or burning key derivations through sign-up. The stored key is a SHA-256 of the scope and client
 * address, so no address is kept; a window's row is replaced once it expires.
 */
export const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
export const THROTTLE_MAX_ATTEMPTS = 20;
/**
 * The longest window any budget counts in (FN-20's sliding hourly AI budget, plus the one-minute bucket it reads
 * before the current one); expired rows older than it are swept.
 */
export const THROTTLE_LONGEST_WINDOW_MS = 61 * 60 * 1000;

/**
 * Sign-in and sign-up each have their own budget per client; so do the account page's password-proving
 * actions (FN-21: key material, password change, key activation and re-lock), which also count per user.
 * The full-account export (FN-31) counts per user with its own, smaller budget.
 */
export const THROTTLE_SCOPES = [
	'sign-in',
	'sign-up',
	'account-password',
	// FN-30: mock checkouts started, per user (voucher guesses: billing/vouchers.ts voucherAttemptLimited).
	'billing-checkout',
	'account-export',
	// FN-02: offline-queue pushes, per user (src/routes/api/v1/sync/push).
	'sync-push',
	// FN-31 red team L3: usage-statistics beacons, per user (/api/v1/track).
	'track',
	// FN-05 red team L2: transaction-creating actions, per user (transactions/create-limit.ts).
	'transaction-create',
	// FN-38: public API requests, per token (api/http.ts), so one token never spends another's budget.
	'api-request',
	// FN-38: public API requests without a valid token, per client, so token guessing is bounded.
	'api-auth',
	// FN-16a red team M1: statement uploads (preview and import), per user (/impor).
	'statement-upload',
	// FN-41: "Tes koneksi" of a personal AI key, per user, with its own smaller budget (AI_KEY_TEST_MAX_ATTEMPTS).
	'ai-key-test',
	// FN-15: receipt reads ("Baca struk", "Baca lagi"), per user, with their own budget (RECEIPT_READS_PER_WINDOW).
	'receipt-read',
	// FN-19: forwarding-address creates and rotations, per user (ADDRESS_CHANGES_PER_WINDOW).
	'inbound-address',
	// FN-22: Tanya questions, per user, with their own budget (TANYA_ASKS_PER_WINDOW).
	'tanya-ask',
	// FN-19 Gmail: connect starts, per user (GMAIL_CONNECTS_PER_WINDOW).
	'gmail-connect',
	// FN-19 Gmail: "Periksa sekarang", look-backs and re-reads, per user (GMAIL_SCAN_ACTIONS_PER_WINDOW).
	'gmail-scan',
	// FN-17: spreadsheet uploads (read, review, AI suggestion, import), per user (/impor).
	'spreadsheet-upload',
	// FN-17: "Sarankan pemetaan dengan AI", per user, with its own small budget (SHEET_AI_PER_WINDOW).
	'spreadsheet-ai',
	// FN-20: merchant AI-resolve calls, per user, in an hour window (MERCHANT_AI_CALLS_PER_HOUR).
	'merchant-ai',
	// FN-20 red team L1: merchant suggestions while typing (/riwayat/saran), per user (MERCHANT_SUGGESTS_PER_WINDOW).
	'merchant-suggest',
	// FN-50: passkey sign-in challenges issued, per client (PASSKEY_BEGIN_PER_WINDOW: conditional UI asks once per
	// /masuk load), and assertions posted, per client (the default budget).
	'passkey-begin',
	'passkey-finish',
	// FN-50: passkey management actions (register options, register, remove), per user.
	'passkey-manage'
] as const;
/** FN-50: sign-in challenges one client may be issued per window (one per `/masuk` load with JavaScript). */
export const PASSKEY_BEGIN_PER_WINDOW = 60;
export type ThrottleScope = (typeof THROTTLE_SCOPES)[number];

/** Seconds until the current budget window ends: the `Retry-After` of a 429. */
export const retryAfterSeconds = (now: number) =>
	Math.ceil((THROTTLE_WINDOW_MS - (now % THROTTLE_WINDOW_MS)) / 1000);

/**
 * The /64 an IPv6 address belongs to, written `a:b:c:d::/64`: one host usually holds a whole /64, so keying
 * by the full address would let it rotate through 2^64 budgets. An IPv4-mapped address gives its IPv4
 * address. Null when `ip` is not an IPv6 address.
 */
export function ipv6Prefix(ip: string): string | null {
	const addr = (ip.split('%')[0] ?? '').toLowerCase();
	if (!addr.includes(':') || addr.length > 45) return null;
	const halves = addr.split('::');
	if (halves.length > 2) return null;
	const groups = (part: string) => (part ? part.split(':') : []);
	const head = groups(halves[0] ?? '');
	const tail = groups(halves[1] ?? '');
	// A trailing dotted IPv4 part stands for the last two groups.
	const lastList = tail.length ? tail : head;
	const last = lastList.at(-1) ?? '';
	if (last.includes('.')) {
		const parts = last.split('.');
		if (parts.length !== 4 || !parts.every((o) => /^\d{1,3}$/.test(o) && Number(o) < 256))
			return null;
		const v4 = parts.map(Number) as [number, number, number, number];
		lastList.splice(
			-1,
			1,
			((v4[0] << 8) | v4[1]).toString(16),
			((v4[2] << 8) | v4[3]).toString(16)
		);
	}
	const given = head.length + tail.length;
	if (halves.length === 2 ? given > 7 : given !== 8) return null;
	const all = [...head, ...Array<string>(8 - given).fill('0'), ...tail];
	if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
	const n = all.map((g) => parseInt(g, 16));
	if (n.slice(0, 5).every((g) => g === 0) && n[5] === 0xffff) {
		const a = n[6] ?? 0;
		const b = n[7] ?? 0;
		return [a >> 8, a & 255, b >> 8, b & 255].join('.');
	}
	return `${n
		.slice(0, 4)
		.map((g) => g.toString(16))
		.join(':')}::/64`;
}

/**
 * The client a request counts against. Cloudflare always sets CF-Connecting-IP (a client cannot override
 * it); the other headers are fallbacks for local runs only. An IPv6 client counts by its /64.
 */
export function clientKey(request: Request): string {
	const h = request.headers;
	const ip =
		h.get('cf-connecting-ip') ??
		h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		h.get('x-real-ip') ??
		'unknown';
	return ipv6Prefix(ip) ?? ip;
}

/**
 * One attempt against the budget named `name`; true when it is over `max`. At most three small guarded
 * statements. Concurrent first attempts all miss the UPDATE and land on the upsert, which counts them
 * instead of each resetting the window to 1; a late request whose clock was read before a newer window
 * began counts in that newer window and never moves the row back.
 */
export async function countAttempt(
	db: Db,
	name: string,
	now: number,
	max = THROTTLE_MAX_ATTEMPTS,
	windowMs = THROTTLE_WINDOW_MS
): Promise<boolean> {
	const key = await sha256Hex(name);
	const windowStart = now - (now % windowMs);
	const updated = await db
		.update(authAttempts)
		.set({ count: sql`${authAttempts.count} + 1` })
		.where(and(eq(authAttempts.clientHash, key), eq(authAttempts.windowStart, windowStart)))
		.returning({ count: authAttempts.count });
	if (updated[0]) return updated[0].count > max;
	// First attempt of this window for this client: rare, so the cleanup of old windows rides along here. Only
	// rows older than the longest window go, so a 10-minute budget never wipes a running hourly one (FN-20).
	await db
		.delete(authAttempts)
		.where(lt(authAttempts.windowStart, Math.min(windowStart, now - THROTTLE_LONGEST_WINDOW_MS)));
	const [row] = await db
		.insert(authAttempts)
		.values({ clientHash: key, windowStart, count: 1 })
		.onConflictDoUpdate({
			target: authAttempts.clientHash,
			set: {
				count: sql`case when ${authAttempts.windowStart} >= ${windowStart} then ${authAttempts.count} + 1 else 1 end`,
				windowStart: sql`max(${authAttempts.windowStart}, ${windowStart})`
			}
		})
		.returning({ count: authAttempts.count });
	return (row?.count ?? 1) > max;
}

/**
 * Every scope fails CLOSED: when D1 cannot count the attempt, it is treated as over the limit (logged).
 * - sign-in, sign-up, account-password: the credential check needs the same database, so a refusal costs
 *   nothing a working database would have allowed, and a partial failure never opens an unthrottled path;
 * - billing-checkout: a checkout started without a count is an unbounded provider call;
 * - account-export: the export is the heaviest read the app has (FN-31 red team L2: it failed open);
 * - track: a refused beacon only drops one statistic, answered as usual;
 * - transaction-create: the write that follows needs the same database;
 * - api-request: an uncounted request would be an unthrottled path into D1, so it gets 429 instead;
 * - api-auth: a failed API authentication that cannot be counted is answered 429, never 401 uncounted;
 * - statement-upload: each one parses an untrusted PDF, the costliest read a user can trigger;
 * - ai-key-test: each one is a real provider call billed to the user's own Anthropic account;
 * - receipt-read: each one is a vision call billed to the user's own Anthropic account;
 * - gmail-connect, gmail-scan: each one starts an OAuth flow or Gmail API work for the user;
 * - spreadsheet-upload: each one inflates and parses an untrusted ZIP/XML workbook;
 * - spreadsheet-ai: each one is a call billed to the user's own Anthropic account;
 * - merchant-ai: each one is a provider call billed to the user's own Anthropic account (the item then simply
 *   stays "Tanpa kategori");
 * - merchant-suggest: each one reads up to 5,000 history rows; a refused one only drops the suggestion chip;
 * - passkey-begin, passkey-finish, passkey-manage: the challenge and credential checks need the same database,
 *   and an uncounted assertion would be an unthrottled guess at a signature (FN-50);
 * - voucher guesses count through countAttempt directly and fail closed too (billing/vouchers.ts).
 */
function failClosed(scope: ThrottleScope, e: unknown): true {
	console.error('throttle unavailable', scope, e instanceof Error ? e.message : 'unknown');
	return true;
}

/**
 * Counts one attempt of `scope` for this request's client, before any key derivation, so a flood costs one
 * indexed row read and write. A database failure refuses the attempt (failClosed).
 */
export async function overAttemptLimit(
	db: Db,
	request: Request,
	now: number,
	scope: ThrottleScope,
	max = THROTTLE_MAX_ATTEMPTS
): Promise<boolean> {
	try {
		return await countAttempt(db, `${scope}:${clientKey(request)}`, now, max);
	} catch (e) {
		return failClosed(scope, e);
	}
}

/**
 * Counts one attempt of `scope` against the signed-in user `userId` (not the client), for actions that derive
 * a password key on behalf of a session: a session holder rotating addresses still has one budget. Fails
 * closed like overAttemptLimit.
 */
export async function overUserAttemptLimit(
	db: Db,
	userId: string,
	now: number,
	scope: ThrottleScope,
	max = THROTTLE_MAX_ATTEMPTS,
	windowMs = THROTTLE_WINDOW_MS
): Promise<boolean> {
	try {
		return await countAttempt(db, `${scope}:user:${userId}`, now, max, windowMs);
	} catch (e) {
		return failClosed(scope, e);
	}
}

/** Bucket width of a sliding budget (overUserSlidingLimit). */
export const SLIDING_BUCKET_MS = 60 * 1000;

/**
 * Counts one attempt of `scope` against the signed-in user `userId` like overUserAttemptLimit, but over a
 * sliding window (FN-16a red team L5: a fixed window let `2 × max` through around its edge). Each attempt is
 * counted in its own one-minute bucket row; it is over the limit when the buckets of the last `windowMs`
 * (THROTTLE_WINDOW_MS unless given; at most THROTTLE_LONGEST_WINDOW_MS, which the cleanup keeps) before the current
 * minute plus the current minute's count hold more than `max`. So no such span ever holds more than `max` allowed
 * attempts. The earlier minutes are read first and no longer change; the current minute's count comes from the
 * guarded increment itself, so concurrent attempts are counted exactly. Refused attempts are not counted, so a
 * retrying client is free again as soon as its allowed attempts age out. Fails closed.
 */
export async function overUserSlidingLimit(
	db: Db,
	userId: string,
	now: number,
	scope: ThrottleScope,
	max: number,
	windowMs = THROTTLE_WINDOW_MS
): Promise<boolean> {
	try {
		const name = (bucket: number) => `${scope}:user:${userId}:minute:${bucket}`;
		const current = now - (now % SLIDING_BUCKET_MS);
		const buckets = windowMs / SLIDING_BUCKET_MS;
		const earlier = await Promise.all(
			Array.from({ length: buckets }, (_, i) =>
				sha256Hex(name(current - (i + 1) * SLIDING_BUCKET_MS))
			)
		);
		const [row] = await db
			.select({ total: sql<number>`coalesce(sum(${authAttempts.count}), 0)` })
			.from(authAttempts)
			.where(
				and(
					sql`${authAttempts.clientHash} in (select value from json_each(${JSON.stringify(earlier)}))`,
					gte(authAttempts.windowStart, current - buckets * SLIDING_BUCKET_MS)
				)
			);
		const room = max - Number(row?.total ?? 0);
		if (room <= 0) return true;
		// Only an allowed attempt is counted (red team cycle 2 L1: refused retries kept the lock alive for
		// another window): one guarded upsert adds 1 while the current minute stays below `room`.
		const key = await sha256Hex(name(current));
		const counted = await db.all<{ count: number }>(sql`insert into auth_attempts
				(client_hash, window_start, count) values (${key}, ${current}, 1)
			on conflict (client_hash) do update set count = auth_attempts.count + 1
				where auth_attempts.count < ${room}
			returning count`);
		if (counted[0]?.count === 1)
			// First attempt of this minute: old buckets and windows go, as in countAttempt.
			await db
				.delete(authAttempts)
				.where(lt(authAttempts.windowStart, now - THROTTLE_LONGEST_WINDOW_MS));
		return counted.length === 0;
	} catch (e) {
		return failClosed(scope, e);
	}
}

/**
 * Counts one attempt of `scope` against the API token `tokenId` (FN-38), so every token has its own budget
 * whoever holds it and from wherever. Fails closed like overAttemptLimit.
 */
export async function overTokenAttemptLimit(
	db: Db,
	tokenId: string,
	now: number,
	scope: ThrottleScope,
	max = THROTTLE_MAX_ATTEMPTS
): Promise<boolean> {
	try {
		return await countAttempt(db, `${scope}:token:${tokenId}`, now, max);
	} catch (e) {
		return failClosed(scope, e);
	}
}
