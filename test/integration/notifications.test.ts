import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { changePassword } from '#lib/server/auth/change-password';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { createPasswordSession } from '#lib/server/auth/session';
import { signInWithPassword } from '#lib/server/auth/password';
import { setBudget } from '#lib/server/budgets/repo';
import { snapshotBudgetDay } from '#lib/server/budgets/streak';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { createGoal } from '#lib/server/goals/repo';
import { deleteContribution } from '#lib/server/goals/contributions';
import { createIfAbsent, setNotificationPref } from '#lib/server/notifications/repo';
import {
	getCronCursor,
	setCronCursor,
	spacesWithBudget,
	spacesWithSubscriptions,
	sweepNotifications,
	SWEEP_BATCH,
	usersWanting
} from '#lib/server/notifications/schedule';
import {
	deliverPush,
	evaluateBills,
	evaluateBudget,
	evaluateCloseReminder,
	evaluateDailyNudge,
	evaluateWeeklySummary,
	PushRetryError
} from '#lib/server/notifications/triggers';
import { upsertSubscription } from '#lib/server/push/repo';
import { vapidKeys, type VapidKeys } from '#lib/server/push/vapid';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { periodTotals } from '#lib/server/transactions/aggregate';
import { createTransaction, deleteTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { base64urlEncode } from '#lib/shared/base64url';
import { wibDateString } from '#lib/shared/dates';
import type { JobMessage } from '#lib/shared/jobs';
import { runCronTick } from '../../workers/jobs/src/cron';
import { handleBatch, type JobDeps } from '../../workers/jobs/src/queue';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
vi.mock('$app/env', () => ({ dev: false }));

const list = await import('../../src/routes/(app)/kotak-masuk/notifikasi/+page.server');
const tabungan = await import('../../src/routes/(app)/kekayaan/tabungan/[id]/+page.server');
const settings = await import('../../src/routes/(app)/pengaturan/notifikasi/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let KEYS: VapidKeys;
const PASSWORD = 'kopi-pagi-2026';
/** Account rows are created at this instant (any time before the evaluations). */
const SETUP = Date.parse('2026-09-01T01:00:00Z');
/** 10:00 WIB, Sunday 20 September 2026: an open cron hour in September. */
const SEPT = Date.parse('2026-09-20T03:00:00Z');

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
	const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign'
	])) as CryptoKeyPair;
	KEYS = vapidKeys({
		VAPID_PUBLIC_KEY: base64urlEncode(await crypto.subtle.exportKey('raw', pair.publicKey)),
		VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', pair.privateKey)).d as string,
		VAPID_SUBJECT: 'mailto:dev@montra.local'
	})!;
});
afterAll(() => dispose());
afterEach(() => vi.restoreAllMocks());

// ---- setup helpers ----

let n = 0;
async function person(name = 'Uji') {
	const email = `notif${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		SETUP
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const scope: SpaceScope = { spaceId: personal, userId: r.userId };
	return { user: { id: r.userId, email, name, createdAt: 0 }, scope, email };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An IDR wallet and an expense helper in `scope`. */
async function ledger(scope: SpaceScope) {
	await ensurePresetCategories(db, scope.spaceId, SETUP);
	const cats = await listCategories(db, scope.spaceId);
	const w = await createWallet(
		db,
		scope,
		{
			name: 'BCA',
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		SETUP
	);
	if (!w.ok) throw new Error('wallet failed');
	const tx = async (
		amountMinor: number,
		occurredOn: string,
		over: Partial<TransactionInput> = {}
	) => {
		const r = await createTransaction(
			db,
			scope,
			{
				type: 'expense',
				amountMinor,
				currency: 'IDR',
				walletId: w.id,
				transferToWalletId: null,
				categoryId: cats.find((c) => c.tileKey === 'makan')!.id,
				title: 'Makan',
				note: null,
				occurredOn,
				occurredTime: null,
				...over
			},
			SETUP
		);
		if (!r.ok) throw new Error('tx failed');
		return r.id;
	};
	return { walletId: w.id, tx };
}

async function budget(scope: SpaceScope, amountMinor: number) {
	expect(await setBudget(db, scope, { amountMinor, currency: 'IDR' }, null, SETUP)).toBe('ok');
}

async function sharedSpace(owner: Person, member: Person, name = 'Keluarga') {
	const spaceId = (await createSharedSpace(db, owner.user.id, name, SETUP))!;
	const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, SETUP))!;
	await acceptInvite(db, invite.token, member.user.id, SETUP);
	return spaceId;
}

let devices = 0;
/** A live session and a push subscription (real P-256 keys) for `who`; returns its endpoint. */
async function device(who: Person) {
	const sessionId = crypto.randomUUID();
	await d1
		.prepare(
			'insert into sessions (id, token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?, ?)'
		)
		.bind(sessionId, crypto.randomUUID(), who.user.id, SETUP, Date.parse('2030-01-01T00:00:00Z'))
		.run();
	const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits'
	])) as CryptoKeyPair;
	const endpoint = `https://fcm.googleapis.com/fcm/send/notif-${++devices}`;
	await d1
		.prepare(
			`insert into push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, user_agent,
				created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, null, ?, ?, null)`
		)
		.bind(
			crypto.randomUUID(),
			who.user.id,
			sessionId,
			endpoint,
			base64urlEncode(await crypto.subtle.exportKey('raw', pair.publicKey)),
			base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
			SETUP,
			SETUP
		)
		.run();
	return endpoint;
}

/** Stubs fetch for push hosts: `status(endpoint)` answers; returns the list of endpoints posted to. */
function pushService(status: (endpoint: string) => number = () => 201) {
	const posted: string[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.startsWith('https://fcm.googleapis.com/')) throw new Error(`unexpected fetch ${url}`);
		posted.push(url);
		return new Response(null, { status: status(url) });
	});
	return posted;
}

type Row = { id: string; user_id: string; space_id?: string; kind: string; params: string | null };
const spaceRows = async (userId: string, kind?: string) =>
	(
		await d1
			.prepare(
				`select * from space_notifications where user_id = ? ${kind ? 'and kind = ?' : ''} order by created_at`
			)
			.bind(...(kind ? [userId, kind] : [userId]))
			.all<Row>()
	).results;
const userRows = async (userId: string, kind?: string) =>
	(
		await d1
			.prepare(
				`select * from user_notifications where user_id = ? ${kind ? 'and kind = ?' : ''} order by created_at`
			)
			.bind(...(kind ? [userId, kind] : [userId]))
			.all<Row>()
	).results;

// ---- the jobs Worker, end to end against local D1 ----

function jobDeps(now: number, keys: VapidKeys | null, queue: JobMessage[]): JobDeps {
	return {
		recordPing: async () => {},
		gmailCheck: async () => {},
		gmailRead: async () => {},
		agentRun: async () => {},
		budgetCheck: (spaceId) => evaluateBudget(db, spaceId, now),
		billCheck: (spaceId) => evaluateBills(db, spaceId, now),
		dailyNudge: (userId, date) => evaluateDailyNudge(db, userId, date, now),
		closeReminder: (userId, date) => evaluateCloseReminder(db, userId, date, now),
		budgetStreakSnapshot: async (spaceId, date) => {
			await snapshotBudgetDay(db, spaceId, date, now);
		},
		weeklySummary: (userId, weekStart) => evaluateWeeklySummary(db, userId, weekStart, now),
		sendPush: async (id) => {
			await deliverPush(db, id, keys, now);
		},
		recurringCheck: async () => false,
		fileSweep: async () => false,
		inboundRead: async () => {},
		enqueue: async (messages) => {
			queue.push(...messages);
		},
		today: () => wibDateString(now)
	};
}

/** Delivers `messages` like the Queues runtime: one batch, then whatever they enqueued, until empty. */
async function drain(messages: JobMessage[], now: number, keys: VapidKeys | null, attempts = 1) {
	const delivered: {
		body: JobMessage;
		acked: boolean;
		retried: boolean;
		delaySeconds?: number;
	}[] = [];
	let pending = [...messages];
	for (let round = 0; pending.length > 0 && round < 10; round++) {
		const next: JobMessage[] = [];
		const batch = pending.map((body) => {
			const m: {
				body: JobMessage;
				attempts: number;
				acked: boolean;
				retried: boolean;
				delaySeconds?: number;
				ack(): void;
				retry(options?: { delaySeconds?: number }): void;
			} = {
				body,
				attempts,
				acked: false,
				retried: false,
				ack() {
					m.acked = true;
				},
				retry(options) {
					m.retried = true;
					m.delaySeconds = options?.delaySeconds;
				}
			};
			return m;
		});
		await handleBatch({ messages: batch }, jobDeps(now, keys, next));
		delivered.push(...batch);
		pending = next;
	}
	return delivered;
}

/** One cron tick with its own fresh walk positions (each test starts every pass from the beginning). */
async function tick(now: number) {
	const enqueued: JobMessage[] = [];
	const cursors = new Map<string, string>();
	await runCronTick(
		{
			getCursor: async (key) => cursors.get(key) ?? null,
			gmailConnectionsDue: null,
			setCursor: async (key, value) => {
				cursors.set(key, value);
			},
			spacesWithBudget: (after, limit) => spacesWithBudget(db, after, limit),
			spacesWithSubscriptions: (after, limit) => spacesWithSubscriptions(db, after, limit),
			spacesWithDueSeries: async () => [],
			usersWanting: (kind, after, limit) => usersWanting(db, kind, after, limit),
			usersDueCloseReminder: async () => [],
			enqueue: async (m) => {
				enqueued.push(...m);
			}
		},
		now
	);
	return enqueued;
}

describe('cron → queue → notification (idempotency)', () => {
	it('a replayed tick and replayed messages never duplicate a notification or a push', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 1_000_000);
		await l.tx(850_000, '2026-09-15');
		await device(p);
		await device(p);
		const posted = pushService();

		// Budget checks only: the nudge pass of this tick would create rows other tests count.
		const budgetsOnly = (messages: JobMessage[]) =>
			messages.filter((m) => m.type === 'budget_check');
		const first = budgetsOnly(await tick(SEPT));
		expect(first).toContainEqual({ type: 'budget_check', spaceId: p.scope.spaceId });
		const delivered = await drain(first, SEPT, KEYS);
		expect(delivered.every((m) => m.acked)).toBe(true);
		expect(await spaceRows(p.user.id)).toHaveLength(1);
		expect((await spaceRows(p.user.id))[0]).toMatchObject({ kind: 'budget_80' });
		expect(posted).toHaveLength(2);

		// The same messages again (an at-least-once redelivery), first as a fresh and then as a retried
		// delivery: still one row, and no device is pushed twice.
		const sendPush = delivered.map((m) => m.body).filter((b) => b.type === 'send_push');
		expect(sendPush).toHaveLength(1);
		await drain(first, SEPT, KEYS);
		await drain([...first, ...sendPush], SEPT, KEYS, 2);
		// Another hourly tick later the same day.
		await drain(budgetsOnly(await tick(SEPT + 3_600_000)), SEPT + 3_600_000, KEYS);
		expect(await spaceRows(p.user.id)).toHaveLength(1);
		expect(posted).toHaveLength(2);
	});

	it('20 concurrent creates of one key leave exactly one row (concurrency probe)', async () => {
		const p = await person();
		const make = () =>
			createIfAbsent(
				db,
				{
					userId: p.user.id,
					kind: 'budget_80',
					spaceId: p.scope.spaceId,
					dataKey: `budget:${p.scope.spaceId}:2026-09:80`,
					params: { month: '2026-09', currency: 'IDR', budgetMinor: 10, spentMinor: 9 }
				},
				SEPT
			);
		const results = await Promise.all(Array.from({ length: 20 }, make));
		expect(results.filter((r) => r?.created)).toHaveLength(1);
		expect(new Set(results.map((r) => r?.id)).size).toBe(1);
		expect(await spaceRows(p.user.id)).toHaveLength(1);
	});
});

describe('budget thresholds', () => {
	it('80 % fires once per WIB month, 100 % once on its own, and the next month starts over', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 1_000_000);
		await l.tx(799_999, '2026-09-02');
		expect(await evaluateBudget(db, p.scope.spaceId, SEPT)).toEqual([]);
		await l.tx(1, '2026-09-03');
		const made = await evaluateBudget(db, p.scope.spaceId, SEPT);
		expect(made).toEqual([{ id: expect.any(String), created: true }]);
		expect(await evaluateBudget(db, p.scope.spaceId, SEPT + 86_400_000)).toEqual([
			{ id: made[0]!.id, created: false }
		]);
		await l.tx(200_000, '2026-09-21');
		expect((await evaluateBudget(db, p.scope.spaceId, SEPT + 86_400_000))[0]!.created).toBe(true);
		expect((await evaluateBudget(db, p.scope.spaceId, SEPT + 2 * 86_400_000))[0]!.created).toBe(
			false
		);
		expect((await spaceRows(p.user.id)).map((r) => r.kind)).toEqual(['budget_80', 'budget_100']);
		const params = JSON.parse((await spaceRows(p.user.id, 'budget_100'))[0]!.params!);
		expect(params).toEqual({
			month: '2026-09',
			currency: 'IDR',
			budgetMinor: 1_000_000,
			spentMinor: 1_000_000
		});

		// October: September's spending no longer counts; a new crossing fires a new month's alert.
		const OCT = Date.parse('2026-10-05T03:00:00Z');
		expect(await evaluateBudget(db, p.scope.spaceId, OCT)).toEqual([]);
		await l.tx(950_000, '2026-10-04');
		expect((await evaluateBudget(db, p.scope.spaceId, OCT))[0]!.created).toBe(true);
		expect(await spaceRows(p.user.id, 'budget_80')).toHaveLength(2);
	});

	it('100 % fires without 80 % first (a jump straight past the budget)', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 500_000);
		await l.tx(600_000, '2026-09-10');
		await evaluateBudget(db, p.scope.spaceId, SEPT);
		expect((await spaceRows(p.user.id)).map((r) => r.kind)).toEqual(['budget_100']);
	});

	it('WIB month boundary: 23:30 WIB on the 30th counts September; 00:30 WIB on the 1st is October', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 100_000);
		await l.tx(90_000, '2026-09-30');
		const lateSept = Date.parse('2026-09-30T16:30:00Z');
		const earlyOct = Date.parse('2026-09-30T17:30:00Z');
		expect(await evaluateBudget(db, p.scope.spaceId, earlyOct)).toEqual([]);
		expect((await evaluateBudget(db, p.scope.spaceId, lateSept))[0]!.created).toBe(true);
	});

	it('demo rows and other currencies never count toward the budget', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 100_000);
		const id = await l.tx(90_000, '2026-09-10');
		await d1.prepare('update transactions set is_demo = 1 where id = ?').bind(id).run();
		expect(await evaluateBudget(db, p.scope.spaceId, SEPT)).toEqual([]);
	});

	it('a member who turned budget alerts off gets none; the other member still does', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = await sharedSpace(owner, member);
		const l = await ledger({ spaceId, userId: owner.user.id });
		await budget({ spaceId, userId: owner.user.id }, 100_000);
		await setNotificationPref(db, member.user.id, 'budget_80', false, SETUP);
		await l.tx(85_000, '2026-09-10');
		await evaluateBudget(db, spaceId, SEPT);
		expect(await spaceRows(owner.user.id, 'budget_80')).toHaveLength(1);
		expect(await spaceRows(member.user.id, 'budget_80')).toHaveLength(0);
		// Checked before creation: turning it back on later does not resurrect a skipped alert retroactively
		// for rows that exist, but the next evaluation creates it.
		await setNotificationPref(db, member.user.id, 'budget_80', true, SETUP);
		await evaluateBudget(db, spaceId, SEPT);
		expect(await spaceRows(member.user.id, 'budget_80')).toHaveLength(1);
	});
});

describe('cross-space isolation', () => {
	it('two spaces crossing on one tick give two notifications, each with its own space', async () => {
		const a = await person('A');
		const b = await person('B');
		const shared = await sharedSpace(a, b);
		const personal = await ledger(a.scope);
		const family = await ledger({ spaceId: shared, userId: a.user.id });
		await budget(a.scope, 100_000);
		await budget({ spaceId: shared, userId: a.user.id }, 200_000);
		await personal.tx(80_000, '2026-09-10');
		await family.tx(160_000, '2026-09-10');
		await drain(
			[
				{ type: 'budget_check', spaceId: a.scope.spaceId },
				{ type: 'budget_check', spaceId: shared }
			],
			SEPT,
			null
		);
		const rows = await spaceRows(a.user.id);
		expect(rows.map((r) => r.space_id).sort()).toEqual([a.scope.spaceId, shared].sort());
		// B is a member of the shared space only: one row, never A's personal budget.
		expect((await spaceRows(b.user.id)).map((r) => r.space_id)).toEqual([shared]);
	});

	it('a removed member sees no more rows of that space, and every action on them is a 404', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const stranger = await person('Orang lain');
		const spaceId = await sharedSpace(owner, member);
		const l = await ledger({ spaceId, userId: owner.user.id });
		await budget({ spaceId, userId: owner.user.id }, 100_000);
		await l.tx(85_000, '2026-09-10');
		await evaluateBudget(db, spaceId, SEPT);
		const row = (await spaceRows(member.user.id))[0]!;
		expect((await loadList(member)).items.map((i: { id: string }) => i.id)).toContain(row.id);

		// A stranger naming the member's notification id: same 404 as an unknown id.
		const unknown = await act(stranger, 'dismiss', crypto.randomUUID());
		expect(await act(stranger, 'dismiss', row.id)).toEqual(unknown);
		expect(await act(stranger, 'open', row.id)).toEqual(unknown);
		expect(unknown).toMatchObject({ kind: 'error', status: 404, body: { message: 'Not found' } });

		const membership = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: membership.id }, SEPT);
		expect((await loadList(member)).items).toEqual([]);
		expect(await act(member, 'dismiss', row.id)).toEqual(unknown);
		expect(await act(member, 'open', row.id)).toEqual(unknown);
		// Nothing new is created for them either.
		await l.tx(20_000, '2026-09-11');
		await evaluateBudget(db, spaceId, SEPT);
		expect(await spaceRows(member.user.id, 'budget_100')).toHaveLength(0);
		expect(await spaceRows(owner.user.id, 'budget_100')).toHaveLength(1);
	});
});

describe('push delivery', () => {
	async function withNotification() {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 100_000);
		await l.tx(85_000, '2026-09-10');
		const [made] = await evaluateBudget(db, p.scope.spaceId, SEPT);
		return { p, id: made!.id };
	}

	it('without VAPID keys nothing is sent and the in-app row stands', async () => {
		const { p, id } = await withNotification();
		await device(p);
		const posted = pushService();
		expect(await deliverPush(db, id, null, SEPT)).toBe('unconfigured');
		expect(posted).toEqual([]);
		expect(await spaceRows(p.user.id)).toHaveLength(1);
	});

	it('quiet hours (00:00–05:59 WIB) send nothing', async () => {
		const { p, id } = await withNotification();
		await device(p);
		const posted = pushService();
		expect(await deliverPush(db, id, KEYS, Date.parse('2026-09-20T22:59:00Z'))).toBe('quiet');
		expect(posted).toEqual([]);
		expect(await deliverPush(db, id, KEYS, Date.parse('2026-09-20T23:00:00Z'))).toBe('delivered');
		expect(posted).toHaveLength(1);
	});

	it('410 tombstones the subscription; 500 retries only that device; the row is never lost', async () => {
		const { p, id } = await withNotification();
		const gone = await device(p);
		const flaky = await device(p);
		const ok = await device(p);
		let flakyStatus = 500;
		const posted = pushService((url) => (url === gone ? 410 : url === flaky ? flakyStatus : 201));
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const first = await drain([{ type: 'send_push', notificationId: id }], SEPT, KEYS);
		expect(first[0]).toMatchObject({ acked: false, retried: true });
		expect(posted.sort()).toEqual([gone, flaky, ok].sort());
		const goneRow = await d1
			.prepare('select deleted_at from push_subscriptions where endpoint = ?')
			.bind(gone)
			.first<{ deleted_at: number | null }>();
		expect(goneRow?.deleted_at).not.toBeNull();
		expect(await spaceRows(p.user.id)).toHaveLength(1);

		// The queue's retry: only the failed device is tried again.
		flakyStatus = 201;
		posted.length = 0;
		const retry = await drain([{ type: 'send_push', notificationId: id }], SEPT, KEYS, 2);
		expect(retry[0]).toMatchObject({ acked: true });
		expect(posted).toEqual([flaky]);
		await expect(deliverPush(db, id, KEYS, SEPT)).resolves.toBe('delivered');
		expect(posted).toEqual([flaky]);
	});

	it('L1: when recording a sent push fails, the claim is kept and no retry sends it again', async () => {
		const { p, id } = await withNotification();
		await device(p);
		const posted = pushService();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await d1
			.prepare(
				`create trigger fail_finish before update on notification_deliveries
				when new.state = 'done' begin select raise(abort, 'd1 down'); end`
			)
			.run();
		try {
			const first = await drain([{ type: 'send_push', notificationId: id }], SEPT, KEYS);
			// Delivered (acked): the queue does not retry it.
			expect(first[0]).toMatchObject({ acked: true, retried: false });
		} finally {
			await d1.prepare('drop trigger fail_finish').run();
		}
		expect(posted).toHaveLength(1);
		// A redelivery of the same message soon after still sends nothing.
		await drain([{ type: 'send_push', notificationId: id }], SEPT + 60_000, KEYS, 2);
		expect(posted).toHaveLength(1);
	});

	it('L2: a device claimed by a dead attempt is retried after the claim goes stale, never acked as sent', async () => {
		const { p, id } = await withNotification();
		const endpoint = await device(p);
		const sub = await d1
			.prepare('select id from push_subscriptions where endpoint = ?')
			.bind(endpoint)
			.first<{ id: string }>();
		// An attempt that claimed this device and died before sending.
		await d1
			.prepare(
				`insert into notification_deliveries (notification_id, subscription_id, user_id, state, updated_at)
				values (?, ?, ?, 'sending', ?)`
			)
			.bind(id, sub!.id, p.user.id, SEPT - 60_000)
			.run();
		const posted = pushService();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const first = await drain([{ type: 'send_push', notificationId: id }], SEPT, KEYS);
		expect(first[0]).toMatchObject({ acked: false, retried: true });
		expect(first[0]!.delaySeconds).toBeGreaterThan(5 * 60);
		expect(posted).toEqual([]);
		// The delayed retry finds the claim stale, takes it over and sends once.
		const later = SEPT + first[0]!.delaySeconds! * 1000;
		const retry = await drain([{ type: 'send_push', notificationId: id }], later, KEYS, 2);
		expect(retry[0]).toMatchObject({ acked: true });
		expect(posted).toEqual([endpoint]);
	});

	it('a failing push throws PushRetryError (bounded by the queue, then the DLQ)', async () => {
		const { p, id } = await withNotification();
		await device(p);
		pushService(() => 503);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(deliverPush(db, id, KEYS, SEPT)).rejects.toBeInstanceOf(PushRetryError);
	});
});

describe('daily nudge', () => {
	const DAY = '2026-09-20';

	it('created once when nothing is recorded today; never when a live entry is dated today', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx(10_000, '2026-09-19'); // yesterday: does not count
		const demo = await l.tx(10_000, DAY);
		await d1.prepare('update transactions set is_demo = 1 where id = ?').bind(demo).run();
		const made = await evaluateDailyNudge(db, p.user.id, DAY, SEPT);
		expect(made).toEqual([{ id: expect.any(String), created: true }]);
		expect((await evaluateDailyNudge(db, p.user.id, DAY, SEPT))[0]!.created).toBe(false);

		const q = await person();
		const lq = await ledger(q.scope);
		await lq.tx(10_000, DAY);
		expect(await evaluateDailyNudge(db, q.user.id, DAY, SEPT)).toEqual([]);
	});

	it('a deleted entry does not count; an entry in a shared space the user belongs to does', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const id = await l.tx(10_000, DAY);
		expect(await deleteTransaction(db, p.scope, id, SETUP, SETUP + 1)).toBe('ok');
		expect(await evaluateDailyNudge(db, p.user.id, '2026-09-20', SEPT)).toHaveLength(1);

		const owner = await person();
		const member = await person();
		const spaceId = await sharedSpace(owner, member);
		await (await ledger({ spaceId, userId: owner.user.id })).tx(5_000, DAY);
		expect(await evaluateDailyNudge(db, member.user.id, DAY, SEPT)).toEqual([]);
	});

	it('turned off → none', async () => {
		const p = await person();
		await setNotificationPref(db, p.user.id, 'daily_nudge', false, SETUP);
		expect(await evaluateDailyNudge(db, p.user.id, DAY, SEPT)).toEqual([]);
		expect(await userRows(p.user.id)).toEqual([]);
	});

	it('the 07:00 WIB tick nudges only the users who want it', async () => {
		const yes = await person();
		const no = await person();
		await setNotificationPref(db, no.user.id, 'daily_nudge', false, SETUP);
		const at7 = Date.parse('2026-09-20T00:00:00Z');
		const enqueued = await tick(at7);
		const nudged = enqueued.filter((m) => m.type === 'daily_nudge').map((m) => m.userId);
		expect(nudged).toContain(yes.user.id);
		expect(nudged).not.toContain(no.user.id);
		await drain(
			enqueued.filter((m) => m.type === 'daily_nudge' && m.userId === yes.user.id),
			at7,
			null
		);
		expect(await userRows(yes.user.id, 'daily_nudge')).toHaveLength(1);
	});
});

describe('weekly summary', () => {
	it('equals the periodTotals sum for last week (Monday–Sunday WIB) and is created once', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx(10_000, '2026-09-13'); // the Sunday before: outside
		await l.tx(20_000, '2026-09-14'); // Monday: inside
		await l.tx(30_000, '2026-09-20'); // Sunday: inside
		await l.tx(40_000, '2026-09-21'); // this Monday: outside
		const monday = Date.parse('2026-09-20T23:00:00Z'); // 06:00 WIB Monday 21 September
		const enqueued = await tick(monday);
		const mine = enqueued.filter((m) => m.type === 'weekly_summary' && m.userId === p.user.id);
		expect(mine).toEqual([{ type: 'weekly_summary', userId: p.user.id, weekStart: '2026-09-21' }]);
		await drain(mine, monday, null);
		await drain(mine, monday, null, 2);
		const rows = await userRows(p.user.id, 'weekly_summary');
		expect(rows).toHaveLength(1);
		const params = JSON.parse(rows[0]!.params!);
		const totals = await periodTotals(db, p.scope.spaceId, {
			from: '2026-09-14',
			to: '2026-09-20',
			type: 'expense',
			categoryId: null,
			walletId: null,
			q: null
		});
		expect(params).toEqual({
			from: '2026-09-14',
			to: '2026-09-20',
			currency: 'IDR',
			spentMinor: totals.totals[0]!.outMinor
		});
		expect(params.spentMinor).toBe(50_000);
	});
});

// ---- routes ----

type Handler = (event: never) => unknown;

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return { kind: 'fail' as const, status: value.status, data: value.data as unknown };
		return { kind: 'ok' as const, value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

async function eventFor(
	who: Person,
	opts: {
		routeId: string;
		url: string;
		form?: Record<string, string>;
		params?: Record<string, string>;
	}
) {
	const space = await resolveCurrentSpace(db, who.user.id, undefined);
	return fakeEvent({
		url: `http://localhost${opts.url}`,
		routeId: opts.routeId,
		db,
		user: who.user,
		space,
		form: opts.form,
		params: opts.params
	});
}

async function loadList(who: Person) {
	const { event } = await eventFor(who, {
		routeId: '/(app)/kotak-masuk/notifikasi',
		url: '/kotak-masuk/notifikasi'
	});
	return (await list.load(event as never)) as unknown as {
		items: { id: string; kind: string; title: string; body: string; unread: boolean }[];
		loadError: string | null;
	};
}

async function act(who: Person, name: 'open' | 'dismiss', id: string) {
	const { event } = await eventFor(who, {
		routeId: '/(app)/kotak-masuk/notifikasi',
		url: `/kotak-masuk/notifikasi?/${name}`,
		form: { id }
	});
	return run(async () => (list.actions as Record<string, Handler>)[name]!(event as never));
}

describe('notification list route', () => {
	it('lists newest first, opens (read + space switch + redirect) and dismisses (content-free)', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = await sharedSpace(owner, member, 'Rumah');
		const l = await ledger({ spaceId, userId: owner.user.id });
		await budget({ spaceId, userId: owner.user.id }, 100_000);
		await l.tx(85_000, '2026-09-10');
		await evaluateBudget(db, spaceId, SEPT);
		await evaluateDailyNudge(db, member.user.id, '2026-09-21', SEPT + 86_400_000);

		const page = await loadList(member);
		expect(page.loadError).toBeNull();
		expect(page.items.map((i) => i.kind)).toEqual(['daily_nudge', 'budget_80']);
		expect(page.items[1]).toMatchObject({
			title: 'Anggaran hampir habis',
			body: expect.stringContaining('Rumah'),
			unread: true
		});

		const budgetId = page.items[1]!.id;
		const { event, written } = await eventFor(member, {
			routeId: '/(app)/kotak-masuk/notifikasi',
			url: '/kotak-masuk/notifikasi?/open',
			form: { id: budgetId }
		});
		const opened = await run(async () =>
			(list.actions as Record<string, Handler>).open!(event as never)
		);
		expect(opened).toEqual({ kind: 'redirect', status: 303, location: '/' });
		expect(written.get('space')?.value).toBe(spaceId);
		expect((await loadList(member)).items[1]!.unread).toBe(false);

		const nudgeId = page.items[0]!.id;
		expect(await act(member, 'dismiss', nudgeId)).toMatchObject({
			kind: 'ok',
			value: { dismissed: true }
		});
		expect((await loadList(member)).items.map((i) => i.id)).toEqual([budgetId]);
		const tomb = await d1
			.prepare('select params, read_at, deleted_at from user_notifications where id = ?')
			.bind(nudgeId)
			.first<{ params: string | null; read_at: number | null; deleted_at: number | null }>();
		expect(tomb).toMatchObject({ params: null, read_at: null, deleted_at: expect.any(Number) });
		// Dismissed for good: the same key never comes back, and a second dismiss is a 404.
		expect(
			(await evaluateDailyNudge(db, member.user.id, '2026-09-21', SEPT + 86_400_000))[0]
		).toMatchObject({
			created: false
		});
		expect(await act(member, 'dismiss', nudgeId)).toMatchObject({ kind: 'error', status: 404 });
		// Another user's own rows are untouched by any of this.
		expect((await loadList(owner)).items.every((i) => i.unread)).toBe(true);
	});

	it('an over-long id is the same 404', async () => {
		const p = await person();
		expect(await act(p, 'open', 'x'.repeat(500))).toMatchObject({ kind: 'error', status: 404 });
	});
});

describe('goal milestones on the contribution write path', () => {
	it('50 % and 100 % fire once each, never again after a drop and a re-cross; pushes are queued', async () => {
		const sent: unknown[] = [];
		binding.JOBS_QUEUE = {
			sendBatch: async (batch: { body: unknown }[]) => {
				sent.push(...batch.map((m) => m.body));
			}
		};
		const p = await person();
		const goal = await createGoal(
			db,
			p.scope,
			{ name: 'Liburan', targetAmountMinor: 100_000_000 },
			SETUP
		);
		if (!goal.ok) throw new Error('goal failed');
		const contribute = async (amount: string) => {
			const { event } = await eventFor(p, {
				routeId: '/(app)/kekayaan/tabungan/[id]',
				url: `/kekayaan/tabungan/${goal.id}?/addContribution`,
				form: { amount, note: '' },
				params: { id: goal.id }
			});
			return run(async () =>
				(tabungan.actions as Record<string, Handler>).addContribution!(event as never)
			);
		};
		expect(await contribute('300.000')).toMatchObject({ kind: 'ok' });
		expect(await spaceRows(p.user.id)).toHaveLength(0);
		expect(await contribute('300.000')).toMatchObject({ kind: 'ok' }); // 60 %
		const half = await spaceRows(p.user.id, 'goal_milestone');
		expect(half).toHaveLength(1);
		expect(JSON.parse(half[0]!.params!)).toMatchObject({ threshold: 50, savedMinor: 60_000_000 });
		expect(sent).toEqual([{ type: 'send_push', notificationId: half[0]!.id }]);

		// Drop below 50 % and cross again: no second 50 % notification.
		const last = await d1
			.prepare(
				'select id from goal_contributions where goal_id = ? and deleted_at is null order by created_at desc limit 1'
			)
			.bind(goal.id)
			.first<{ id: string }>();
		await deleteContribution(db, p.scope, goal.id, last!.id, SEPT);
		expect(await contribute('300.000')).toMatchObject({ kind: 'ok' });
		expect(await spaceRows(p.user.id, 'goal_milestone')).toHaveLength(1);

		expect(await contribute('500.000')).toMatchObject({ kind: 'ok' }); // 110 %
		expect(await contribute('100.000')).toMatchObject({ kind: 'ok' });
		const rows = await spaceRows(p.user.id, 'goal_milestone');
		expect(rows.map((r) => JSON.parse(r.params!).threshold)).toEqual([50, 100]);
		expect(sent).toHaveLength(2);
	});

	it('a failing queue never fails the confirmed contribution', async () => {
		binding.JOBS_QUEUE = {
			sendBatch: async () => {
				throw new Error('queue down');
			}
		};
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const p = await person();
		const goal = await createGoal(
			db,
			p.scope,
			{ name: 'Motor', targetAmountMinor: 10_000_000 },
			SETUP
		);
		if (!goal.ok) throw new Error('goal failed');
		const { event } = await eventFor(p, {
			routeId: '/(app)/kekayaan/tabungan/[id]',
			url: `/kekayaan/tabungan/${goal.id}?/addContribution`,
			form: { amount: '100.000', note: '' },
			params: { id: goal.id }
		});
		const r = await run(async () =>
			(tabungan.actions as Record<string, Handler>).addContribution!(event as never)
		);
		expect(r).toMatchObject({ kind: 'ok', value: { saved: 'contributed' } });
		expect(await spaceRows(p.user.id, 'goal_milestone')).toHaveLength(1);
	});
});

describe('settings: per-kind preferences', () => {
	it('load shows defaults (all on); setPref stores per user; an unknown kind is a 400', async () => {
		const p = await person();
		const other = await person();
		const call = async (form?: Record<string, string>) => {
			const { event } = await eventFor(p, {
				routeId: '/(app)/pengaturan/notifikasi',
				url: form ? '/pengaturan/notifikasi?/setPref' : '/pengaturan/notifikasi',
				form
			});
			return run(async () =>
				form
					? (settings.actions as Record<string, Handler>).setPref!(event as never)
					: settings.load(event as never)
			);
		};
		const before = await call();
		expect(before).toMatchObject({ kind: 'ok', value: { prefsError: null, configured: false } });
		expect(
			(before as unknown as { value: { prefs: Record<string, boolean> } }).value.prefs
				.weekly_summary
		).toBe(true);
		expect(await call({ kind: 'weekly_summary' })).toMatchObject({
			kind: 'ok',
			value: { savedPref: 'weekly_summary', enabled: false }
		});
		expect(await call({ kind: 'mystery', enabled: 'on' })).toMatchObject({
			kind: 'fail',
			status: 400
		});
		const after = (await call()) as unknown as { value: { prefs: Record<string, boolean> } };
		expect(after.value.prefs).toMatchObject({ weekly_summary: false, budget_80: true });
		// Another user's preference is untouched.
		expect(await usersWanting(db, 'weekly_summary', '', 10_000)).toContain(other.user.id);
		expect(await usersWanting(db, 'weekly_summary', '', 10_000)).not.toContain(p.user.id);
	});
});

describe('account deletion', () => {
	it('removes the user’s notifications, preferences and delivery claims; shared-space rows of others stay', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = await sharedSpace(owner, member);
		const l = await ledger({ spaceId, userId: owner.user.id });
		await budget({ spaceId, userId: owner.user.id }, 100_000);
		await l.tx(85_000, '2026-09-10');
		await evaluateBudget(db, spaceId, SEPT);
		const personal = await ledger(member.scope);
		await budget(member.scope, 10_000);
		await personal.tx(9_000, '2026-09-10');
		await evaluateBudget(db, member.scope.spaceId, SEPT);
		await evaluateDailyNudge(db, member.user.id, '2026-09-20', SEPT);
		await setNotificationPref(db, member.user.id, 'weekly_summary', false, SETUP);
		await device(member);
		pushService();
		const [nudge] = await userRows(member.user.id);
		await deliverPush(db, nudge!.id, KEYS, SEPT);

		const proof = await signInWithPassword(db, member.email, PASSWORD, SEPT);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await deleteAccount(db, member.user.id, proof.hash, SEPT)).toBe(true);
		const count = async (table: string) =>
			(await d1
				.prepare(`select count(*) as n from ${table} where user_id = ?`)
				.bind(member.user.id)
				.first<{ n: number }>())!.n;
		for (const table of [
			'space_notifications',
			'user_notifications',
			'notification_prefs',
			'notification_deliveries'
		])
			expect(await count(table)).toBe(0);
		const personalLeft = await d1
			.prepare('select count(*) as n from space_notifications where space_id = ?')
			.bind(member.scope.spaceId)
			.first<{ n: number }>();
		expect(personalLeft!.n).toBe(0);
		expect(await spaceRows(owner.user.id)).toHaveLength(1);
	});
});

describe('retention sweep (L4)', () => {
	const DAY = 86_400_000;

	async function oldNotification(
		table: 'user' | 'space',
		who: Person,
		kind: string,
		ageDays: number
	) {
		const id = crypto.randomUUID();
		const at = SEPT - ageDays * DAY;
		if (table === 'user')
			await d1
				.prepare(
					`insert into user_notifications (id, user_id, kind, data_key, params, created_at, updated_at)
					values (?, ?, ?, ?, '{}', ?, ?)`
				)
				.bind(id, who.user.id, kind, `old:${id}`, at, at)
				.run();
		else
			await d1
				.prepare(
					`insert into space_notifications (id, space_id, user_id, kind, data_key, params, created_at,
						updated_at, seq) values (?, ?, ?, ?, ?, '{}', ?, ?, 0)`
				)
				.bind(id, who.scope.spaceId, who.user.id, kind, `old:${id}`, at, at)
				.run();
		return id;
	}
	const row = (table: string, id: string) =>
		d1
			.prepare(`select deleted_at, params, data_key from ${table} where id = ?`)
			.bind(id)
			.first<{ deleted_at: number | null; params: string | null; data_key: string }>();

	it('removes rows past 90 days, tombstones old goal milestones (key kept) and keeps recent rows', async () => {
		const p = await person();
		const oldNudge = await oldNotification('user', p, 'daily_nudge', 91);
		const newNudge = await oldNotification('user', p, 'daily_nudge', 89);
		const oldBudget = await oldNotification('space', p, 'budget_80', 91);
		const oldGoal = await oldNotification('space', p, 'goal_milestone', 91);
		const newGoal = await oldNotification('space', p, 'goal_milestone', 10);
		await d1
			.prepare(
				`insert into notification_deliveries (notification_id, subscription_id, user_id, state, updated_at)
				values (?, 'sub-old', ?, 'done', ?), (?, 'sub-new', ?, 'done', ?)`
			)
			.bind(oldNudge, p.user.id, SEPT - 91 * DAY, newNudge, p.user.id, SEPT - DAY)
			.run();
		await sweepNotifications(db, SEPT);
		expect(await row('user_notifications', oldNudge)).toBeNull();
		expect(await row('user_notifications', newNudge)).toMatchObject({ deleted_at: null });
		expect(await row('space_notifications', oldBudget)).toBeNull();
		expect(await row('space_notifications', oldGoal)).toMatchObject({
			deleted_at: SEPT,
			params: null,
			data_key: `old:${oldGoal}`
		});
		expect(await row('space_notifications', newGoal)).toMatchObject({ deleted_at: null });
		const deliveries = await d1
			.prepare('select subscription_id as s from notification_deliveries where user_id = ?')
			.bind(p.user.id)
			.all<{ s: string }>();
		expect(deliveries.results.map((d) => d.s)).toEqual(['sub-new']);
	});

	it('works through a backlog in bounded steps', async () => {
		const p = await person();
		await d1
			.prepare(
				`with recursive n(i) as (select 1 union all select i + 1 from n where i < ${SWEEP_BATCH + 1})
				insert into user_notifications (id, user_id, kind, data_key, params, created_at, updated_at)
				select 'bulk-' || i, ?, 'daily_nudge', 'bulk:' || i, '{}', ?, ? from n`
			)
			.bind(p.user.id, SEPT - 200 * DAY, SEPT - 200 * DAY)
			.run();
		await sweepNotifications(db, SEPT);
		expect(await userRows(p.user.id)).toHaveLength(1);
		await sweepNotifications(db, SEPT);
		expect(await userRows(p.user.id)).toHaveLength(0);
	});

	it('a removed member’s rows of that space lose their content; the owner’s stay', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = await sharedSpace(owner, member);
		const l = await ledger({ spaceId, userId: owner.user.id });
		await budget({ spaceId, userId: owner.user.id }, 100_000);
		await l.tx(85_000, '2026-09-10');
		await evaluateBudget(db, spaceId, SEPT);
		const membership = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: membership.id }, SEPT);
		await sweepNotifications(db, SEPT);
		const [gone] = await spaceRows(member.user.id);
		expect(gone).toMatchObject({ params: null });
		expect((gone as unknown as { deleted_at: number }).deleted_at).toBe(SEPT);
		expect((await spaceRows(owner.user.id))[0]!.params).not.toBeNull();
	});
});

describe('cron walk positions in D1', () => {
	it('are stored per key and overwritten in place', async () => {
		expect(await getCronCursor(db, 'cron:test')).toBeNull();
		await setCronCursor(db, 'cron:test', 'a', SEPT);
		await setCronCursor(db, 'cron:test', 'b', SEPT + 1);
		expect(await getCronCursor(db, 'cron:test')).toBe('b');
		const n = await d1
			.prepare("select count(*) as n from app_meta where key = 'cron:test'")
			.first<{ n: number }>();
		expect(n!.n).toBe(1);
	});
});

describe('password change (FN-21) and push delivery', () => {
	it('after a password change, only the device of the kept session gets the push', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 100_000);
		await l.tx(85_000, '2026-09-10');
		const [made] = await evaluateBudget(db, p.scope.spaceId, SEPT);
		const proof = await signInWithPassword(db, p.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('sign-in failed');
		const sessionOf = async () =>
			(await createPasswordSession(db, p.user.id, proof.hash, Date.now()))!.token;
		const subscribe = async (token: string) => {
			const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
				'deriveBits'
			])) as CryptoKeyPair;
			const endpoint = `https://fcm.googleapis.com/fcm/send/pw-${++devices}`;
			const ok = await upsertSubscription(
				db,
				{ userId: p.user.id, sessionToken: token },
				{
					endpoint,
					p256dh: base64urlEncode(await crypto.subtle.exportKey('raw', pair.publicKey)),
					auth: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
					userAgent: null
				},
				Date.now()
			);
			expect(ok).toBe(true);
			return endpoint;
		};
		const kept = await sessionOf();
		const other = await sessionOf();
		const keptDevice = await subscribe(kept);
		await subscribe(other);
		expect(
			await changePassword(db, p.user.id, proof.hash, kept, 'sandi-baru-2026-x', null, Date.now())
		).toBe(true);
		const posted = pushService();
		expect(await deliverPush(db, made!.id, KEYS, SEPT)).toBe('delivered');
		expect(posted).toEqual([keptDevice]);
	});
});
