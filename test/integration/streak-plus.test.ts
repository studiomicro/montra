import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { setBudget } from '#lib/server/budgets/repo';
import { budgetStreakSummary, snapshotBudgetDay } from '#lib/server/budgets/streak';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import {
	getCloseReminderHour,
	setCloseReminderHour,
	setNotificationPref
} from '#lib/server/notifications/repo';
import {
	spacesWithBudget,
	usersDueCloseReminder,
	usersWanting
} from '#lib/server/notifications/schedule';
import { deliverPush, evaluateCloseReminder } from '#lib/server/notifications/triggers';
import { vapidKeys, type VapidKeys } from '#lib/server/push/vapid';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace } from '#lib/server/spaces/spaces';
import { closeDay, streakSummary } from '#lib/server/streak/repo';
import { createTransaction, deleteTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { base64urlEncode } from '#lib/shared/base64url';
import { addDays, monthOf, shiftMonth, wibDateString, wibTodayString } from '#lib/shared/dates';
import type { JobMessage } from '#lib/shared/jobs';
import { runCronTick } from '../../workers/jobs/src/cron';
import { handleBatch, type JobDeps, type QueueMessageLike } from '../../workers/jobs/src/queue';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

// FN-34b: the evening reminder (cron → queue → guarded insert → push, mocked), the budget-streak snapshot and
// /beruntun's load, against local D1. No real push service: fetch is stubbed for the push host.

const binding: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
vi.mock('$app/env', () => ({ dev: false }));

const beruntun = await import('../../src/routes/(app)/beruntun/+page.server');
const beranda = await import('../../src/routes/(app)/+page.server');
const settings = await import('../../src/routes/(app)/pengaturan/notifikasi/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let KEYS: VapidKeys;
const PASSWORD = 'kopi-pagi-2026';
const SETUP = Date.parse('2026-09-01T01:00:00Z');
/** `hour`:00 WIB on WIB date `date` as a UTC instant. */
const wib = (date: string, hour: number, minute = 0) =>
	Date.parse(`${date}T00:00:00Z`) + ((hour - 7) * 60 + minute) * 60_000;

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
	const email = `beruntun${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		SETUP
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const scope: SpaceScope = { spaceId: personal, userId: r.userId };
	return { user: { id: r.userId, email, name, createdAt: 0 }, scope };
}
type Person = Awaited<ReturnType<typeof person>>;

/** Two IDR wallets and a transaction helper in `scope`. */
async function ledger(scope: SpaceScope) {
	await ensurePresetCategories(db, scope.spaceId, SETUP);
	const cats = await listCategories(db, scope.spaceId);
	const wallet = async (name: string, isFavourite: boolean) => {
		const w = await createWallet(
			db,
			scope,
			{ name, type: 'bank', currency: 'IDR', openingBalanceMinor: 0, isFavourite, lastFour: null },
			SETUP
		);
		if (!w.ok) throw new Error('wallet failed');
		return w.id;
	};
	const walletId = await wallet('BCA', true);
	const otherId = await wallet('Dana', false);
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
				walletId,
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
		if (!r.ok) throw new Error(`tx failed: ${JSON.stringify(r)}`);
		return r.id;
	};
	const income = (amountMinor: number, occurredOn: string) =>
		tx(amountMinor, occurredOn, {
			type: 'income',
			categoryId: cats.find((c) => c.tileKey === 'gaji')!.id,
			title: 'Gaji'
		});
	const transfer = (amountMinor: number, occurredOn: string) =>
		tx(amountMinor, occurredOn, {
			type: 'transfer',
			categoryId: null,
			transferToWalletId: otherId,
			title: 'Pindah'
		});
	return { tx, income, transfer };
}

const budgetOf = async (scope: SpaceScope) =>
	(
		await d1
			.prepare('select updated_at as u from budgets where space_id = ? and deleted_at is null')
			.bind(scope.spaceId)
			.first<{ u: number }>()
	)?.u ?? null;
async function budget(scope: SpaceScope, amountMinor: number) {
	expect(
		await setBudget(db, scope, { amountMinor, currency: 'IDR' }, await budgetOf(scope), SETUP)
	).toBe('ok');
}

async function sharedSpace(owner: Person, member: Person, name = 'Keluarga') {
	const spaceId = (await createSharedSpace(db, owner.user.id, name, SETUP))!;
	const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, SETUP))!;
	await acceptInvite(db, invite.token, member.user.id, SETUP);
	return spaceId;
}

let devices = 0;
/** A live session and a push subscription (real P-256 keys) for `who`. */
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
	await d1
		.prepare(
			`insert into push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, user_agent,
				created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, null, ?, ?, null)`
		)
		.bind(
			crypto.randomUUID(),
			who.user.id,
			sessionId,
			`https://fcm.googleapis.com/fcm/send/beruntun-${++devices}`,
			base64urlEncode(await crypto.subtle.exportKey('raw', pair.publicKey)),
			base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
			SETUP,
			SETUP
		)
		.run();
}

/** Stubs fetch for the push host; returns the endpoints posted to. */
function pushService() {
	const posted: string[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.startsWith('https://fcm.googleapis.com/')) throw new Error(`unexpected fetch ${url}`);
		posted.push(url);
		return new Response(null, { status: 201 });
	});
	return posted;
}

const reminders = async (userId: string) =>
	(
		await d1
			.prepare(
				`select data_key as dataKey from user_notifications where user_id = ? and kind = 'close_reminder'`
			)
			.bind(userId)
			.all<{ dataKey: string }>()
	).results;
const verdicts = async (spaceId: string) =>
	(
		await d1
			.prepare('select date, status from budget_streak_days where space_id = ? order by date')
			.bind(spaceId)
			.all<{ date: string; status: string }>()
	).results;

// ---- the jobs Worker against local D1 ----

function jobDeps(now: number, keys: VapidKeys | null, queue: JobMessage[]): JobDeps {
	const none = async () => [];
	return {
		recordPing: async () => {},
		gmailCheck: async () => {},
		gmailRead: async () => {},
		agentRun: async () => {},
		budgetCheck: none,
		billCheck: none,
		dailyNudge: none,
		weeklySummary: none,
		closeReminder: (userId, date) => evaluateCloseReminder(db, userId, date, now),
		budgetStreakSnapshot: async (spaceId, date) => {
			await snapshotBudgetDay(db, spaceId, date, now);
		},
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

function queueMessage(body: JobMessage, attempts = 1) {
	const m: QueueMessageLike & { acked: boolean; retried: boolean } = {
		body,
		attempts,
		acked: false,
		retried: false,
		ack() {
			m.acked = true;
		},
		retry() {
			m.retried = true;
		}
	};
	return m;
}

/** Delivers `messages` like the Queues runtime (one batch, then what they enqueued, until empty). */
async function drain(messages: JobMessage[], now: number, keys: VapidKeys | null) {
	const delivered: ReturnType<typeof queueMessage>[] = [];
	let pending = [...messages];
	for (let round = 0; pending.length > 0 && round < 10; round++) {
		const next: JobMessage[] = [];
		const batch = pending.map((body) => queueMessage(body));
		await handleBatch({ messages: batch }, jobDeps(now, keys, next));
		delivered.push(...batch);
		pending = next;
	}
	return delivered;
}

/** One cron tick with fresh walk positions; only the FN-34b messages for the users or spaces in `only`. */
async function tick(now: number, only: readonly string[]) {
	const enqueued: JobMessage[] = [];
	const cursors = new Map<string, string>();
	await runCronTick(
		{
			getCursor: async (key) => cursors.get(key) ?? null,
			setCursor: async (key, value) => {
				cursors.set(key, value);
			},
			gmailConnectionsDue: null,
			spacesWithBudget: (after, limit) => spacesWithBudget(db, after, limit),
			spacesWithSubscriptions: async () => [],
			spacesWithDueSeries: async () => [],
			usersWanting: (kind, after, limit) => usersWanting(db, kind, after, limit),
			usersDueCloseReminder: (today, hour, after, limit) =>
				usersDueCloseReminder(db, today, hour, after, limit),
			enqueue: async (m) => {
				enqueued.push(...m);
			}
		},
		now
	);
	return enqueued.filter(
		(m) =>
			(m.type === 'close_reminder' && only.includes(m.userId)) ||
			(m.type === 'budget_streak_snapshot' && only.includes(m.spaceId))
	);
}

// ---- evening reminder ----

describe('evening close reminder (FN-34b)', () => {
	const DAY = '2026-10-08';

	it('default 20:00 WIB: nothing on earlier ticks, exactly one row and one push per device at 20:00 (criterion 10)', async () => {
		const p = await person();
		await device(p);
		await device(p);
		const posted = pushService();
		// Red team L1: before the user's hour nothing is even enqueued (it used to be every active user, every tick).
		for (const hour of [6, 12, 19]) expect(await tick(wib(DAY, hour), [p.user.id])).toEqual([]);
		expect(await reminders(p.user.id)).toEqual([]);
		const eight = wib(DAY, 20);
		const delivered = await drain(await tick(eight, [p.user.id]), eight, KEYS);
		expect(delivered.every((m) => m.acked)).toBe(true);
		expect(await reminders(p.user.id)).toEqual([{ dataKey: `close:${DAY}` }]);
		expect(posted).toHaveLength(2);
		// Later ticks the same evening: the same row, no new push.
		for (const hour of [21, 22, 23]) {
			const at = wib(DAY, hour);
			await drain(await tick(at, [p.user.id]), at, KEYS);
		}
		expect(await reminders(p.user.id)).toHaveLength(1);
		expect(posted).toHaveLength(2);
	});

	it('quiet once today is closed, checked live when the message runs (criterion 10)', async () => {
		const p = await person();
		const eight = wib(DAY, 20);
		const messages = await tick(eight, [p.user.id]);
		expect(messages).toHaveLength(1);
		// Closed after the tick enqueued, before the message ran.
		await closeDay(db, p.user.id, DAY, eight);
		await drain(messages, eight, KEYS);
		expect(await reminders(p.user.id)).toEqual([]);
		// Yesterday closed does not silence today.
		const q = await person();
		await closeDay(db, q.user.id, addDays(DAY, -1), eight);
		await drain(await tick(eight, [q.user.id]), eight, null);
		expect(await reminders(q.user.id)).toHaveLength(1);
	});

	it('red team L1: a user already reminded, or whose day is closed, is never enqueued again that day', async () => {
		const p = await person();
		const q = await person();
		const eight = wib(DAY, 20);
		await drain(await tick(eight, [p.user.id]), eight, null);
		expect(await reminders(p.user.id)).toHaveLength(1);
		await closeDay(db, q.user.id, DAY, eight);
		for (const hour of [21, 23])
			expect(await tick(wib(DAY, hour), [p.user.id, q.user.id])).toEqual([]);
		// The next day both are due again at their hour.
		expect(await tick(wib(addDays(DAY, 1), 20), [p.user.id, q.user.id])).toHaveLength(2);
	});

	it('red team L2: a reminder whose day was closed before the push went out is not pushed', async () => {
		const p = await person();
		await device(p);
		const posted = pushService();
		const eight = wib(DAY, 20);
		const [made] = await evaluateCloseReminder(db, p.user.id, DAY, eight);
		expect(made).toBeDefined();
		await closeDay(db, p.user.id, DAY, eight + 60_000);
		expect(await deliverPush(db, made!.id, KEYS, eight + 120_000)).toBe('closed');
		expect(posted).toEqual([]);
	});

	it('without VAPID keys the in-app row is still created and nothing is sent (criterion 11)', async () => {
		const p = await person();
		await device(p);
		const posted = pushService();
		const eight = wib(DAY, 20);
		const delivered = await drain(await tick(eight, [p.user.id]), eight, null);
		expect(delivered.every((m) => m.acked)).toBe(true);
		expect(await reminders(p.user.id)).toHaveLength(1);
		expect(posted).toEqual([]);
	});

	it('a custom 21:00 fires at 21:00, not 20:00; lowering it afterwards never sends a second one that day (criterion 12)', async () => {
		const p = await person();
		await setCloseReminderHour(db, p.user.id, 21, SETUP);
		expect(await getCloseReminderHour(db, p.user.id)).toBe(21);
		const at = (h: number) => wib(DAY, h);
		await drain(await tick(at(20), [p.user.id]), at(20), null);
		expect(await reminders(p.user.id)).toEqual([]);
		await drain(await tick(at(21), [p.user.id]), at(21), null);
		expect(await reminders(p.user.id)).toHaveLength(1);
		await setCloseReminderHour(db, p.user.id, 18, SETUP);
		await drain(await tick(at(22), [p.user.id]), at(22), null);
		expect(await reminders(p.user.id)).toHaveLength(1);
		// The next WIB day starts fresh, at the new hour.
		const next = addDays(DAY, 1);
		await drain(await tick(wib(next, 18), [p.user.id]), wib(next, 18), null);
		expect((await reminders(p.user.id)).map((r) => r.dataKey).sort()).toEqual([
			`close:${DAY}`,
			`close:${next}`
		]);
	});

	it('20 concurrent deliveries of one message: one row, at most one push per device (criterion 13)', async () => {
		const p = await person();
		await device(p);
		const posted = pushService();
		const eight = wib(DAY, 20);
		const body: JobMessage = { type: 'close_reminder', userId: p.user.id, date: DAY };
		const pushes: JobMessage[] = [];
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				handleBatch(
					{ messages: [queueMessage(body, i === 0 ? 1 : 2)] },
					jobDeps(eight, KEYS, pushes)
				)
			)
		);
		expect(await reminders(p.user.id)).toHaveLength(1);
		await Promise.all(pushes.map((m) => drain([m], eight, KEYS)));
		expect(posted).toHaveLength(1);
	});

	it('turned off: none; two users with different hours each get only their own (criterion 14)', async () => {
		const off = await person();
		await setNotificationPref(db, off.user.id, 'close_reminder', false, SETUP);
		const early = await person();
		const late = await person();
		await setCloseReminderHour(db, early.user.id, 18, SETUP);
		await setCloseReminderHour(db, late.user.id, 22, SETUP);
		await sharedSpace(early, late);
		const ids = [off.user.id, early.user.id, late.user.id];
		const at18 = wib(DAY, 18);
		const enqueued = await tick(at18, ids);
		// Turned off, or not yet at their hour (late, 22:00): not even enqueued; refused inside the insert too.
		expect(enqueued.map((m) => (m as { userId: string }).userId)).toEqual([early.user.id]);
		await drain(enqueued, at18, null);
		expect(await evaluateCloseReminder(db, off.user.id, DAY, wib(DAY, 23))).toEqual([]);
		expect(await reminders(off.user.id)).toEqual([]);
		expect(await reminders(early.user.id)).toHaveLength(1);
		expect(await reminders(late.user.id)).toEqual([]);
		await drain(await tick(wib(DAY, 22), ids), wib(DAY, 22), null);
		expect(await reminders(late.user.id)).toHaveLength(1);
		expect(await reminders(early.user.id)).toHaveLength(1);
	});

	it('a message for yesterday that runs after WIB midnight is dropped, never sent for the wrong day (criterion 16)', async () => {
		const p = await person();
		// 23:00 WIB on the 31st enqueues the 31st; the message runs at 06:00 WIB on 1 November.
		const enqueued = await tick(wib('2026-10-31', 23), [p.user.id]);
		expect(enqueued).toEqual([{ type: 'close_reminder', userId: p.user.id, date: '2026-10-31' }]);
		const delivered = await drain(enqueued, wib('2026-11-01', 6), null);
		expect(delivered.every((m) => m.acked)).toBe(true);
		expect(await reminders(p.user.id)).toEqual([]);
	});
});

// ---- reminder settings ----

type Outcome =
	| { kind: 'ok'; value: Record<string, unknown> }
	| { kind: 'fail'; status: number; data: unknown }
	| { kind: 'redirect'; status: number; location: string }
	| { kind: 'error'; status: number };
async function run(fn: () => unknown): Promise<Outcome> {
	try {
		const value = await fn();
		if (isActionFailure(value)) return { kind: 'fail', status: value.status, data: value.data };
		return { kind: 'ok', value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect', status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error', status: e.status };
		throw e;
	}
}

async function ev(
	who: Person | null,
	opts: { url?: string; form?: Record<string, string>; space?: App.Locals['space'] } = {}
) {
	const space =
		opts.space !== undefined
			? opts.space
			: who
				? await resolveCurrentSpace(db, who.user.id, undefined)
				: null;
	return fakeEvent({
		url: opts.url ?? 'http://localhost/beruntun',
		db,
		user: who?.user ?? null,
		space,
		form: opts.form
	}).event as never;
}
const setHour = async (who: Person | null, hour: string) =>
	run(async () =>
		(settings.actions as Record<string, (e: never) => unknown>).setReminderHour!(
			await ev(who, { url: 'http://localhost/pengaturan/notifikasi', form: { hour } })
		)
	);

describe('reminder hour setting (FN-34b)', () => {
	it('stores a whole hour 06–23 for the signed-in user only; anything else is refused unchanged (criteria 14, 15)', async () => {
		const p = await person();
		const other = await person();
		expect(await setHour(p, '21')).toEqual({ kind: 'ok', value: { savedHour: 21 } });
		expect(await getCloseReminderHour(db, p.user.id)).toBe(21);
		for (const bad of ['5', '24', '20.5', '20:30', '', 'x', '-1', '0'])
			expect(await setHour(p, bad), bad).toMatchObject({ kind: 'fail', status: 400 });
		expect(await getCloseReminderHour(db, p.user.id)).toBe(21);
		// The other account is untouched; it keeps the default.
		expect(await getCloseReminderHour(db, other.user.id)).toBe(20);
		// A signed-out request writes nothing.
		expect(await setHour(null, '22')).toMatchObject({ kind: 'redirect' });
		// The table refuses an out-of-range hour even past the form check.
		await expect(setCloseReminderHour(db, p.user.id, 3, SETUP)).rejects.toThrow();
		// The settings load shows the stored hour; the reminder kind stays on.
		const loaded = await run(async () =>
			settings.load(await ev(p, { url: 'http://localhost/pengaturan/notifikasi' }))
		);
		expect(loaded).toMatchObject({
			kind: 'ok',
			value: { closeReminderHour: 21, configured: false, prefs: { close_reminder: true } }
		});
	});

	it('the on/off switch keeps the hour and the hour keeps the switch', async () => {
		const p = await person();
		await setCloseReminderHour(db, p.user.id, 19, SETUP);
		await setNotificationPref(db, p.user.id, 'close_reminder', false, SETUP);
		expect(await getCloseReminderHour(db, p.user.id)).toBe(19);
		await setCloseReminderHour(db, p.user.id, 22, SETUP);
		const row = await d1
			.prepare(
				`select enabled, hour from notification_prefs where user_id = ? and kind = 'close_reminder'`
			)
			.bind(p.user.id)
			.first();
		expect(row).toEqual({ enabled: 0, hour: 22 });
	});
});

// ---- budget streak snapshots ----

describe('budget streak snapshot (FN-34b)', () => {
	// October 2026: 31 days. Budget 3,100,000: the 1st's allowance is 100,000.
	it('within at or under the day’s safe-to-spend, over above it; written once, never revised (criteria 17, 18)', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 3_100_000);
		await l.tx(100_000, '2026-10-01');
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-01', SETUP)).toBe('within');
		// 2nd: (3,100,000 − 100,000) / 30 = 100,000 allowed; 100,001 spent.
		const late = await l.tx(100_001, '2026-10-02');
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-02', SETUP)).toBe('over');
		// Deleting that day's spending afterwards never rewrites the stored verdict.
		expect(await deleteTransaction(db, p.scope, late, SETUP, SETUP + 1)).toBe('ok');
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-02', SETUP)).toBe('over');
		await l.tx(50_000, '2026-10-03');
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-03', SETUP)).toBe('within');
		expect(await verdicts(p.scope.spaceId)).toEqual([
			{ date: '2026-10-01', status: 'within' },
			{ date: '2026-10-02', status: 'over' },
			{ date: '2026-10-03', status: 'within' }
		]);
		expect(await budgetStreakSummary(db, p.scope.spaceId, '2026-10-04')).toMatchObject({
			current: 1,
			longest: 1
		});
		// Today is never counted: on the 3rd only the 1st and 2nd are.
		expect(await budgetStreakSummary(db, p.scope.spaceId, '2026-10-03')).toMatchObject({
			current: 0
		});
	});

	it('a month already spent before the day makes it over whatever it spent (criterion 18)', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 500_000);
		await l.tx(600_000, '2026-10-05');
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-06', SETUP)).toBe('over');
	});

	it('no live budget: no row, and the day is a skip between within days (criterion 19)', async () => {
		const p = await person();
		await ledger(p.scope);
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-01', SETUP)).toBeNull();
		expect(await verdicts(p.scope.spaceId)).toEqual([]);
		await budget(p.scope, 3_100_000);
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-02', SETUP)).toBe('within');
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-05', SETUP)).toBe('within');
		expect(await budgetStreakSummary(db, p.scope.spaceId, '2026-10-06')).toMatchObject({
			current: 2
		});
	});

	it('a mid-month raise before the snapshot uses the raised amount; a later cut never rewrites it (criterion 20)', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 310_000); // 10,000 a day on 1 October
		await l.tx(50_000, '2026-10-01');
		// Raised before the 1st was judged: judged at 3,100,000 (100,000 a day).
		await budget(p.scope, 3_100_000);
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-01', SETUP)).toBe('within');
		await budget(p.scope, 310_000);
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-01', SETUP)).toBe('within');
		expect(await verdicts(p.scope.spaceId)).toEqual([{ date: '2026-10-01', status: 'within' }]);
	});

	it('income, transfers and demo rows never count: such a day is within on zero real spend (criteria 21, 22)', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 3_100_000);
		await l.income(9_000_000, '2026-10-01');
		await l.transfer(5_000_000, '2026-10-01');
		const demo = await l.tx(5_000_000, '2026-10-01');
		await d1.prepare('update transactions set is_demo = 1 where id = ?').bind(demo).run();
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-01', SETUP)).toBe('within');
		// Demo spending earlier in the month never eats the allowance either.
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-02', SETUP)).toBe('within');
	});

	it('reads the WIB date only: the last day of a month uses its own length (criterion 25)', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await budget(p.scope, 3_100_000);
		await l.tx(2_900_000, '2026-10-01');
		// 31 October: 200,000 left for its last day; 1 November (the same UTC date at 00:30 WIB) is another month.
		await l.tx(200_000, '2026-10-31');
		await l.tx(9_999_999, '2026-11-01');
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-10-31', SETUP)).toBe('within');
		// November starts over: 3,100,000 over 30 days = 103,333 allowed; 9,999,999 spent.
		expect(await snapshotBudgetDay(db, p.scope.spaceId, '2026-11-01', SETUP)).toBe('over');
	});

	it('20 concurrent snapshots of one space and date leave exactly one row (criterion 26)', async () => {
		const p = await person();
		await ledger(p.scope);
		await budget(p.scope, 3_100_000);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => snapshotBudgetDay(db, p.scope.spaceId, '2026-10-09', SETUP))
		);
		expect(results.every((r) => r === 'within')).toBe(true);
		expect(await verdicts(p.scope.spaceId)).toHaveLength(1);
	});

	it('a deleted space gets no row; an invalid date is refused by the table', async () => {
		const p = await person();
		const q = await person();
		const spaceId = await sharedSpace(p, q);
		await budget({ spaceId, userId: p.user.id }, 3_100_000);
		await d1.prepare('update spaces set deleted_at = ? where id = ?').bind(SETUP, spaceId).run();
		expect(await snapshotBudgetDay(db, spaceId, '2026-10-01', SETUP)).toBeNull();
		await expect(
			d1
				.prepare(
					`insert into budget_streak_days (id, space_id, date, status, created_at) values ('x', ?, '2026-10-1', 'within', 1)`
				)
				.bind(p.scope.spaceId)
				.run()
		).rejects.toThrow(/YYYY-MM-DD/);
	});

	it('cron 06:00 WIB → queue: yesterday is judged once per space; a replay adds nothing', async () => {
		const a = await person();
		const b = await person();
		const la = await ledger(a.scope);
		await ledger(b.scope);
		await budget(a.scope, 3_100_000);
		await budget(b.scope, 3_100_000);
		// 100,000 left for the month's last day; 500,000 spent on it.
		await la.tx(3_000_000, '2026-10-01');
		await la.tx(500_000, '2026-10-31');
		const six = wib('2026-11-01', 6);
		const enqueued = await tick(six, [a.scope.spaceId, b.scope.spaceId]);
		expect(enqueued).toHaveLength(2);
		expect(enqueued.every((m) => 'date' in m && m.date === '2026-10-31')).toBe(true);
		await drain(enqueued, six, null);
		await drain(enqueued, six + 3_600_000, null);
		expect(await verdicts(a.scope.spaceId)).toEqual([{ date: '2026-10-31', status: 'over' }]);
		expect(await verdicts(b.scope.spaceId)).toEqual([{ date: '2026-10-31', status: 'within' }]);
		// A message delayed past the next WIB day is dropped (a skip, never a judged-late verdict).
		const c = await person();
		await ledger(c.scope);
		await budget(c.scope, 3_100_000);
		await drain(
			[{ type: 'budget_streak_snapshot', spaceId: c.scope.spaceId, date: '2026-10-31' }],
			wib('2026-11-02', 6),
			null
		);
		expect(await verdicts(c.scope.spaceId)).toEqual([]);
	});
});

// ---- /beruntun ----

const load = async (who: Person | null, opts: Parameters<typeof ev>[1] = {}) =>
	run(async () => beruntun.load(await ev(who, opts)));

type Loaded = {
	closure: {
		current: number;
		closedToday: boolean;
		longest: number;
		bank: number;
		milestones: { days: number; reached: boolean }[];
		calendar: { date: string; state: string }[];
	} | null;
	budget: {
		current: number;
		longest: number;
		hasBudget: boolean | null;
		calendar: { date: string; state: string }[];
	} | null;
	reminder: { enabled: boolean; hour: number } | null;
	month: string;
};
const page = async (who: Person, opts: Parameters<typeof ev>[1] = {}) => {
	const r = await load(who, opts);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value as unknown as Loaded;
};

describe('/beruntun (FN-34b)', () => {
	it('closure figures equal Beranda’s chip; longest, freezes and milestones from the 400-day window (criteria 1, 3, 4, 6)', async () => {
		const p = await person();
		const today = wibTodayString();
		const days = (from: string, count: number) =>
			Array.from({ length: count }, (_, i) => addDays(from, i));
		// A 10-day run 60 days ago, then 7 closed, one missed (frozen), and the two days up to yesterday.
		const old = days(addDays(today, -60), 10);
		const recent = [...days(addDays(today, -10), 7), ...days(addDays(today, -2), 2)];
		for (const d of [...old, ...recent]) await closeDay(db, p.user.id, d, SETUP);
		const data = await page(p);
		expect(data.closure).toMatchObject({ current: 9, longest: 10, closedToday: false, bank: 0 });
		expect(data.closure!.milestones).toEqual([
			{ days: 7, reached: true },
			{ days: 30, reached: false },
			{ days: 100, reached: false }
		]);
		const chip = await run(async () => beranda.load(await ev(p, { url: 'http://localhost/' })));
		expect(chip).toMatchObject({ kind: 'ok', value: { streak: { current: 9 } } });
		expect(await streakSummary(db, p.user.id, today)).toEqual({ current: 9, closedToday: false });
		// The bridged day shows frozen on whichever month holds it, and has no day_closures row.
		const frozenDay = addDays(today, -3);
		const month = monthOf(frozenDay) === monthOf(today) ? undefined : 'prev';
		const view = month
			? await page(p, { url: `http://localhost/beruntun?bulan=${monthOf(frozenDay)}` })
			: data;
		expect(view.closure!.calendar.find((d) => d.date === frozenDay)?.state).toBe('frozen');
		const row = await d1
			.prepare('select 1 from day_closures where user_id = ? and closed_on = ?')
			.bind(p.user.id, frozenDay)
			.first();
		expect(row).toBeNull();
	});

	it('zero closures: an empty closure streak; reminder defaults to on at 20:00', async () => {
		const p = await person();
		const data = await page(p);
		expect(data.closure).toMatchObject({ current: 0, longest: 0, closedToday: false });
		expect(data.reminder).toEqual({ enabled: true, hour: 20 });
		expect(data.budget).toMatchObject({ current: 0, longest: 0, hasBudget: false });
	});

	it('the calendar shows only this WIB month or the one before (criterion 5)', async () => {
		const p = await person();
		const thisMonth = monthOf(wibTodayString());
		const lastMonth = shiftMonth(thisMonth, -1);
		expect((await page(p)).month).toBe(thisMonth);
		expect((await page(p, { url: `http://localhost/beruntun?bulan=${lastMonth}` })).month).toBe(
			lastMonth
		);
		for (const other of [
			shiftMonth(thisMonth, -2),
			shiftMonth(thisMonth, 1),
			'2020-01',
			'x'.repeat(80)
		]) {
			const data = await page(p, { url: `http://localhost/beruntun?bulan=${other}` });
			expect(data.month).toBe(thisMonth);
			expect(data.closure!.calendar.every((d) => d.date.startsWith(thisMonth))).toBe(true);
		}
	});

	it('the budget streak follows the current space; never another space’s, never summed (criteria 23, 24)', async () => {
		const p = await person();
		const q = await person();
		const shared = await sharedSpace(p, q);
		await ledger(p.scope);
		await budget(p.scope, 3_100_000);
		await budget({ spaceId: shared, userId: p.user.id }, 3_100_000);
		const today = wibTodayString();
		for (const i of [1, 2, 3])
			await snapshotBudgetDay(db, p.scope.spaceId, addDays(today, -i), SETUP);
		await snapshotBudgetDay(db, shared, addDays(today, -1), SETUP);
		const personal = await page(p);
		expect(personal.budget).toMatchObject({ current: 3, longest: 3, hasBudget: true });
		const sharedSpaceRow = await resolveCurrentSpace(db, p.user.id, shared);
		const inShared = await page(p, { space: sharedSpaceRow });
		expect(inShared.budget).toMatchObject({ current: 1, longest: 1, hasBudget: true });
		// The other member sees the shared space's figures in it, and nothing of p's personal space.
		const qShared = await page(q, { space: await resolveCurrentSpace(db, q.user.id, shared) });
		expect(qShared.budget).toMatchObject({ current: 1 });
		const qPersonal = await page(q);
		expect(qPersonal.budget).toMatchObject({ current: 0, hasBudget: false });
		// A stale session naming a space the user is not a member of: the same 404 as everywhere.
		const outsider = await person();
		expect(
			await load(outsider, {
				space: { id: p.scope.spaceId, kind: 'personal', name: '', role: 'owner' }
			})
		).toEqual({ kind: 'error', status: 404 });
		expect(
			await load(outsider, {
				space: { id: crypto.randomUUID(), kind: 'personal', name: '', role: 'owner' }
			})
		).toEqual({ kind: 'error', status: 404 });
	});

	it('a signed-out visitor is sent to /masuk', async () => {
		expect(await load(null)).toMatchObject({ kind: 'redirect', status: 303 });
	});
});
