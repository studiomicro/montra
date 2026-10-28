import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { autoSaveCapture, type AutoSaveInput } from '#lib/server/gmail/autosave';
import {
	GMAIL_AUTOSAVE_SPACE,
	GMAIL_AUTOSAVE_WALLET,
	GMAIL_CHANGED_MEANWHILE,
	GMAIL_SCAN_NOT_FOUND,
	GMAIL_UNDO_ALREADY
} from '#lib/server/gmail/messages';
import { processGmailRead, type GmailReadDeps } from '#lib/server/gmail/read';
import { processGmailCheck } from '#lib/server/gmail/scan';
import { deliverPush, evaluateGmailPayment } from '#lib/server/notifications/triggers';
import { GMAIL_SCOPE } from '#lib/server/gmail/google';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { createSharedSpace } from '#lib/server/spaces/spaces';
import { readWalletBalance } from '#lib/server/transactions/wallet-sum';
import { createWallet } from '#lib/server/wallets/repo';
import { base64urlEncode } from '#lib/shared/base64url';
import { wibDateString, wibInstantUtcMs, addDays } from '#lib/shared/dates';
import {
	GMAIL_AUTOSAVE_MAX_MINOR,
	GMAIL_AUTOSAVE_PER_DAY,
	GMAIL_PUSHES_PER_DAY
} from '#lib/shared/gmail/ledger';
import type { SenderDomain } from '#lib/shared/inbound/sender-domains';
import type { JobMessage } from '#lib/shared/jobs';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import {
	fakeGoogle,
	gmailFromFixture,
	gmailMessage,
	type FakeGoogle
} from '../helpers/fake-google';

// FN-19b Gmail follow-ups against a local D1 (docs/features/fn-19b-gmail-followups/PRD.md): the push per captured
// payment, the opt-in auto-save, "Transaksi dari Gmail" with undo-by-scan. Google is `fakeGoogle()` and no AI is
// called. The fixture sender domains are FICTIONAL; a test that needs a confirmed domain passes its own registry
// through the jobs deps (the shipped registry is empty, so production never auto-saves yet).

const hoisted = vi.hoisted(() => ({ fetch: null as typeof fetch | null }));
vi.mock('#lib/server/gmail/google', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/server/gmail/google')>();
	return {
		...real,
		googleClient: (f?: typeof fetch) => real.googleClient(f ?? (hoisted.fetch as typeof fetch))
	};
});
const binding: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/pengaturan/aplikasi/gmail/+page.server');
const review =
	await import('../../src/routes/(app)/pengaturan/aplikasi/gmail/transaksi/+page.server');
const callback = await import('../../src/routes/(app)/pengaturan/aplikasi/gmail/callback/+server');
const { googleClient } = await import('#lib/server/gmail/google');

const KEY = base64urlEncode(new Uint8Array(32).fill(5));
const ORIGIN = 'http://localhost:8787';
const CLIENT = {
	GOOGLE_OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com',
	GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-client-secret-value'
};
const FIXTURE_DOMAIN = 'notifikasi.bank-qris.example';
/** A test-only confirmed registry naming the fictional fixture domain (never the shipped list). */
const REGISTRY: SenderDomain[] = [
	{
		domain: FIXTURE_DOMAIN,
		institution: 'Bank Contoh (fiktif)',
		parserId: 'bank-qris',
		confirmedBy: 'owner-sample',
		confirmedOn: '2026-10-28'
	}
];
/** Today, 12:00 WIB: the jobs' clock, so the per-day caps never straddle midnight during a run. */
const NOON = wibInstantUtcMs(wibDateString(Date.now()), '12:00');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let google: FakeGoogle;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());
beforeEach(() => {
	for (const k of Object.keys(binding)) delete binding[k];
	google = fakeGoogle();
	hoisted.fetch = google.fetchFn;
	Object.assign(binding, {
		DB: d1,
		...CLIENT,
		GOOGLE_OAUTH_REDIRECT_ORIGIN: ORIGIN,
		CONNECTED_APPS_ENCRYPTION_KEY: KEY,
		JOBS_QUEUE: { sendBatch: async () => {}, send: async () => {} }
	});
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function person() {
	const email = `ikuti${++n}@mail.example`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	await ensurePresetCategories(db, space.id, Date.now());
	return {
		user: { id: r.userId, email, name: 'Uji', createdAt: 0 },
		space: { id: space.id, kind: space.kind, name: space.name, role: space.role },
		session: `session-${n}-${crypto.randomUUID()}`
	};
}
type Person = Awaited<ReturnType<typeof person>>;

const ev = (
	who: Person | null,
	init: { url?: string; routeId?: string; form?: Record<string, string> } = {}
) =>
	fakeEvent({
		url: init.url ?? `${ORIGIN}/pengaturan/aplikasi/gmail`,
		routeId: init.routeId ?? '/(app)/pengaturan/aplikasi/gmail',
		db,
		user: who?.user ?? null,
		space: who?.space ?? null,
		sessionToken: who?.session ?? null,
		form: init.form
	});

type Run =
	| { kind: 'fail'; status: number; error: string }
	| { kind: 'ok'; value: Record<string, unknown> }
	| { kind: 'redirect'; status: number; location: string }
	| { kind: 'error'; status: number };
async function run(fn: () => unknown): Promise<Run> {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail',
				status: value.status,
				error: (value.data as unknown as { error: string }).error
			};
		return { kind: 'ok', value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect', status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error', status: e.status };
		throw e;
	}
}
const act = (who: Person | null, name: string, form: Record<string, string> = {}) =>
	run(() =>
		(page.actions as Record<string, (e: never) => unknown>)[name]!(ev(who, { form }).event as never)
	);
const reviewEv = (who: Person | null, form?: Record<string, string>, query = '') =>
	ev(who, {
		url: `${ORIGIN}/pengaturan/aplikasi/gmail/transaksi${query}`,
		routeId: '/(app)/pengaturan/aplikasi/gmail/transaksi',
		form
	});
const reviewAct = (who: Person | null, name: 'undo' | 'saveAll', form: Record<string, string>) =>
	run(() =>
		(review.actions as Record<string, (e: never) => unknown>)[name]!(
			reviewEv(who, form).event as never
		)
	);
interface ReviewData {
	connected: boolean;
	loadError: string | null;
	nextCursor: string | null;
	days: {
		date: string;
		savedOutMinor: number;
		scans: {
			key: string;
			scan: { id: string; kind: string; undoable: boolean } | null;
			rows: {
				id: string;
				state: string;
				amountMinor: number | null;
				direction: string | null;
				gmailUrl: string | null;
				title: string | null;
			}[];
		}[];
	}[];
}
const reviewLoad = async (who: Person) =>
	(await review.load(reviewEv(who).event as never)) as unknown as ReviewData;
const settings = async (who: Person) =>
	(await page.load(ev(who).event as never)) as unknown as {
		connection: {
			id: string;
			updatedAt: number;
			autoSave: boolean;
			autoSaveWalletId: string | null;
		};
		wallets: { id: string; name: string }[];
		confirmedSenders: number;
		notify: boolean;
		notifyVersion: number;
	};

/** Connect `p` end to end through the fake Google ("Dicatat ke" `spaceId`). */
async function connect(p: Person, spaceId = p.space.id) {
	const r = await act(p, 'connect', { spaceId });
	if (r.kind !== 'ok') throw new Error(`connect: ${JSON.stringify(r)}`);
	const state = new URL(r.value.authUrl as string).searchParams.get('state')!;
	const e = ev(p, {
		url: `${ORIGIN}/pengaturan/aplikasi/gmail/callback?state=${state}&code=auth-code-xyz&scope=${GMAIL_SCOPE}`
	});
	await callback.GET(e.event as never);
	return (await settings(p)).connection;
}

async function wallet(
	spaceId: string,
	userId: string,
	currency: 'IDR' | 'USD' = 'IDR',
	name = 'BCA'
) {
	const r = await createWallet(
		db,
		{ spaceId, userId },
		{ name, type: 'bank', currency, openingBalanceMinor: 0, isFavourite: false, lastFour: null },
		Date.now()
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

/** Turns auto-save on for `p` with `walletId` through the page action. */
async function autoSaveOn(p: Person, walletId: string) {
	const c = (await settings(p)).connection;
	const r = await act(p, 'autoSave', {
		connectionId: c.id,
		updatedAt: String(c.updatedAt),
		on: '1',
		walletId
	});
	expect(r).toEqual({ kind: 'ok', value: { done: 'autosave_on' } });
}

/** A bank-qris shaped payment mail from the fixture domain; `i` varies amount and reference. */
/** Gmail's own topmost header for a mail the fixture domain really sent (DMARC and aligned DKIM pass). */
const googlePass = (domain = FIXTURE_DOMAIN) =>
	`mx.google.com; dkim=pass header.i=@${domain} header.s=sel1 header.b=abc; spf=pass (google.com: domain of noreply@${domain} designates 192.0.2.1 as permitted sender) smtp.mailfrom=noreply@${domain}; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`;

function qris(
	id: string,
	i: number,
	o: { from?: string; amount?: string; merchant?: string; auth?: string[] } = {}
) {
	return gmailMessage({
		authResults: o.auth ?? [googlePass(o.from ?? FIXTURE_DOMAIN)],
		id,
		from: `Bank Contoh <noreply@${o.from ?? FIXTURE_DOMAIN}>`,
		subject: 'Transaksi QRIS Berhasil',
		text: [
			'Transaksi QRIS Anda berhasil.',
			'',
			'Tanggal : 08 Okt 2026 14:32:05 WIB',
			`Merchant : ${o.merchant ?? 'KEDAI KOPI SENJA'}`,
			`Nominal : ${o.amount ?? `Rp ${28 + i}.000,00`}`,
			`No. Referensi : 2026100814320500${String(1000 + i)}`,
			'Sumber dana : 1234567890'
		].join('\n'),
		messageId: `<${id}@${o.from ?? FIXTURE_DOMAIN}>`
	});
}
/** The minor amount of `qris(…, i)`. */
const qrisMinor = (i: number) => (28 + i) * 1000 * 100;

function jobs(opts: { registry?: SenderDomain[]; now?: () => number } = {}) {
	const queue: JobMessage[] = [];
	const deps: GmailReadDeps = {
		db,
		env: { ...CLIENT, CONNECTED_APPS_ENCRYPTION_KEY: KEY },
		google: googleClient(google.fetchFn),
		tokens: new Map(),
		now: opts.now ?? (() => NOON),
		random: () => 0,
		enqueue: async (m) => {
			queue.push(...m);
		},
		senderDomains: opts.registry
	};
	async function drain() {
		for (let i = 0; i < 500 && queue.length > 0; i++) {
			const m = queue.shift()!;
			if (m.type === 'gmail_check')
				await processGmailCheck(
					deps,
					{ connectionId: m.connectionId, kind: m.kind, window: m.window, page: m.page },
					1
				);
			else if (m.type === 'gmail_read') await processGmailRead(deps, m.mailId, 1);
			else pushes.push(m);
		}
	}
	const pushes: JobMessage[] = [];
	return { deps, queue, drain, pushes };
}
let windowSeq = 0;
/** One hourly check of `connectionId` (a fresh window each time) delivering everything it enqueues. */
async function hourly(j: ReturnType<typeof jobs>, connectionId: string) {
	j.queue.push({
		type: 'gmail_check',
		connectionId,
		kind: 'hourly',
		window: `2026-10-28T${String(6 + (windowSeq % 17)).padStart(2, '0')}-${++windowSeq}`,
		page: 0
	});
	await j.drain();
}

const notifications = (userId: string) =>
	db.all<{ id: string; kind: string; data_key: string; params: string; space_id: string }>(
		sql`select id, kind, data_key, params, space_id from space_notifications
			where user_id = ${userId} and kind = 'gmail_payment' order by created_at, data_key`
	);
const draftsOf = (spaceId: string) =>
	db.all<Record<string, unknown>>(
		sql`select * from drafts where space_id = ${spaceId} order by created_at`
	);
const txOf = (spaceId: string) =>
	db.all<Record<string, unknown>>(
		sql`select * from transactions where space_id = ${spaceId} order by created_at, id`
	);
const connRow = (userId: string) =>
	db.get<Record<string, unknown>>(sql`select * from gmail_connections where user_id = ${userId}`);

describe('push per captured payment (AC 1–7)', () => {
	it('an hourly capture makes one notification and one send_push; a redelivered read makes none', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('m1', qris('m1', 0));
		const j = jobs({ registry: REGISTRY });
		await hourly(j, c.id);
		const rows = await notifications(p.user.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.space_id).toBe(p.space.id);
		expect(j.pushes).toEqual([{ type: 'send_push', notificationId: rows[0]!.id }]);
		// Redelivery: the row is no longer `listed`, so the read is skipped; the trigger itself is keyed by draft.
		const mail = (await db.get<{ id: string; draft_id: string }>(
			sql`select id, draft_id from gmail_mail where connection_id = ${c.id}`
		))!;
		expect(await processGmailRead(j.deps, mail.id, 2)).toBe('skipped');
		const params = JSON.parse(rows[0]!.params);
		const again = await evaluateGmailPayment(
			db,
			{ ...params, spaceId: p.space.id, userId: p.user.id },
			NOON
		);
		expect(again).toEqual([]);
		expect(await notifications(p.user.id)).toHaveLength(1);
		// AC 7: stored figures only, from fixed fields; no sender, subject or Gmail id.
		expect(Object.keys(params).sort()).toEqual(
			[
				'amountMinor',
				'categoryName',
				'currency',
				'direction',
				'draftId',
				'merchant',
				'saved',
				'transactionId'
			].sort()
		);
		expect(params).toMatchObject({
			draftId: mail.draft_id,
			amountMinor: qrisMinor(0),
			currency: 'IDR',
			direction: 'expense',
			saved: false,
			transactionId: null
		});
		expect(rows[0]!.params).not.toMatch(/notifikasi|Transaksi QRIS|m1|1234567890/);
	});

	it('a look-back and a "Baca ulang" re-read never notify', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('lb1', qris('lb1', 1));
		const j = jobs();
		const r = await act(p, 'lookback', { connectionId: c.id, days: '7' });
		expect(r.kind).toBe('ok');
		const scan = (await db.get<{ scan_window: string }>(
			sql`select scan_window from gmail_scans where connection_id = ${c.id} and kind = 'lookback'`
		))!;
		j.queue.push({
			type: 'gmail_check',
			connectionId: c.id,
			kind: 'lookback',
			window: scan.scan_window,
			page: 0
		});
		await j.drain();
		expect(await draftsOf(p.space.id)).toHaveLength(1);
		// A re-read of an hourly scan's row: listed by the check, then read with the re-read mark.
		google.state.messages.clear();
		google.state.messages.set('rr1', qris('rr1', 2));
		j.queue.push({
			type: 'gmail_check',
			connectionId: c.id,
			kind: 'hourly',
			window: 'rr-window',
			page: 0
		});
		const check = j.queue.shift()!;
		if (check.type !== 'gmail_check') throw new Error('check');
		await processGmailCheck(j.deps, { ...check }, 1);
		const reads = j.queue.splice(0).filter((m) => m.type === 'gmail_read');
		expect(reads).toHaveLength(1);
		// Red team L2: the mark lives on the ledger row. The row is left unread for want of an AI key, then
		// "Baca ulang" queues it again; the read that follows (however it is delivered: a plain message, as the
		// sweep would re-send it) never notifies.
		const mailId = (reads[0] as { mailId: string }).mailId;
		await db.run(
			sql`update gmail_mail set status = 'unreadable', reason = 'no_ai_key' where id = ${mailId}`
		);
		expect(await act(p, 'reread')).toEqual({
			kind: 'ok',
			value: { done: 'rereading', count: 1 }
		});
		expect(
			(await db.get<{ reread_at: number | null }>(
				sql`select reread_at from gmail_mail where id = ${mailId}`
			))!.reread_at
		).toEqual(expect.any(Number));
		await processGmailRead(jobs({ registry: REGISTRY }).deps, mailId, 1);
		expect(await draftsOf(p.space.id)).toHaveLength(2);
		expect(await notifications(p.user.id)).toEqual([]);
		expect(j.pushes).toEqual([]);
	});

	it(`${GMAIL_PUSHES_PER_DAY + 2} captures in one WIB day: ${GMAIL_PUSHES_PER_DAY} singles, then one group counting the rest (pushed once)`, async () => {
		const p = await person();
		const c = await connect(p);
		const j = jobs();
		for (let i = 0; i < GMAIL_PUSHES_PER_DAY + 2; i++) {
			google.state.messages.clear();
			google.state.messages.set(`d${i}`, qris(`d${i}`, 10 + i));
			await hourly(j, c.id);
		}
		expect(await draftsOf(p.space.id)).toHaveLength(GMAIL_PUSHES_PER_DAY + 2);
		const rows = await notifications(p.user.id);
		const singles = rows.filter((r) => r.data_key.startsWith('gmail:'));
		const groups = rows.filter((r) => r.data_key.startsWith('gmailgroup:'));
		expect(singles).toHaveLength(GMAIL_PUSHES_PER_DAY);
		expect(groups).toHaveLength(1);
		expect(JSON.parse(groups[0]!.params)).toEqual({
			count: 2,
			date: wibDateString(NOON),
			gmail: true
		});
		// One push per single and one for the group; the count update is not pushed again.
		expect(j.pushes).toHaveLength(GMAIL_PUSHES_PER_DAY + 1);
	});

	it('20 concurrent captures still leave exactly the cap of singles and one group', async () => {
		const p = await person();
		const c = await connect(p);
		const j = jobs();
		for (let i = 0; i < 20; i++) google.state.messages.set(`cc${i}`, qris(`cc${i}`, 40 + i));
		j.queue.push({
			type: 'gmail_check',
			connectionId: c.id,
			kind: 'hourly',
			window: 'cc-window',
			page: 0
		});
		const check = j.queue.shift()! as Extract<JobMessage, { type: 'gmail_check' }>;
		await processGmailCheck(j.deps, check, 1);
		const reads = j.queue.splice(0) as Extract<JobMessage, { type: 'gmail_read' }>[];
		expect(reads).toHaveLength(20);
		await Promise.all(reads.map((m) => processGmailRead(j.deps, m.mailId, 1)));
		const rows = await notifications(p.user.id);
		expect(rows.filter((r) => r.data_key.startsWith('gmail:'))).toHaveLength(GMAIL_PUSHES_PER_DAY);
		const group = rows.filter((r) => r.data_key.startsWith('gmailgroup:'));
		expect(group).toHaveLength(1);
		expect(JSON.parse(group[0]!.params).count).toBe(20 - GMAIL_PUSHES_PER_DAY);
	});

	it('kind turned off: no row, no push; quiet hours and no VAPID keys: row only; discarded or left: gone', async () => {
		const off = await person();
		const c1 = await connect(off);
		const r = await act(off, 'notify', {
			on: '0',
			version: String((await settings(off)).notifyVersion)
		});
		expect(r).toEqual({ kind: 'ok', value: { done: 'notify_off' } });
		expect((await settings(off)).notify).toBe(false);
		google.state.messages.set('off1', qris('off1', 3));
		const j1 = jobs();
		await hourly(j1, c1.id);
		expect(await draftsOf(off.space.id)).toHaveLength(1);
		expect(await notifications(off.user.id)).toEqual([]);
		expect(j1.pushes).toEqual([]);

		const p = await person();
		const c2 = await connect(p);
		google.state.messages.clear();
		google.state.messages.set('q1', qris('q1', 4));
		const j2 = jobs();
		await hourly(j2, c2.id);
		const [row] = await notifications(p.user.id);
		const keys = { publicKey: 'p', privateKey: 'k', subject: 'mailto:ops@contoh.example' };
		expect(await deliverPush(db, row!.id, null, NOON)).toBe('unconfigured');
		expect(
			await deliverPush(db, row!.id, keys, wibInstantUtcMs(wibDateString(NOON), '03:00'))
		).toBe('quiet');
		// The draft was discarded before delivery: not announced.
		await db.run(sql`update drafts set deleted_at = ${NOON}, amount_minor = null, currency = null,
			title = null, note = null, category_id = null, wallet_id = null, occurred_on = null, occurred_at = null,
			flag = null where space_id = ${p.space.id}`);
		expect(await deliverPush(db, row!.id, keys, NOON)).toBe('gone');

		// The owner left the shared space the payment was recorded in: gone.
		const owner = await person();
		const m = await person();
		const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		await db.run(sql`insert into space_members (id, space_id, user_id, role, created_at, updated_at)
			values (${crypto.randomUUID()}, ${shared}, ${m.user.id}, 'member', 0, 0)`);
		const c3 = await connect(m, shared);
		google.state.messages.clear();
		google.state.messages.set('sh1', qris('sh1', 5));
		const j3 = jobs();
		await hourly(j3, c3.id);
		const [shRow] = await notifications(m.user.id);
		expect(shRow!.space_id).toBe(shared);
		await db.run(
			sql`update space_members set deleted_at = ${NOON} where space_id = ${shared} and user_id = ${m.user.id}`
		);
		expect(await deliverPush(db, shRow!.id, keys, NOON)).toBe('gone');
	});
});

describe('auto-save (AC 8–14)', () => {
	it('off by default: captures stay drafts exactly as before', async () => {
		const p = await person();
		const c = await connect(p);
		expect((await connRow(p.user.id))!.auto_save).toBe(0);
		google.state.messages.set('o1', qris('o1', 6));
		await hourly(jobs({ registry: REGISTRY }), c.id);
		expect((await draftsOf(p.space.id)).filter((d) => d.deleted_at === null)).toHaveLength(1);
		expect(await txOf(p.space.id)).toEqual([]);
	});

	it('on, with a confirmed domain: one transaction in the wallet, the draft a tombstone pointing at it, "Tersimpan otomatis"', async () => {
		const p = await person();
		const c = await connect(p);
		const w = await wallet(p.space.id, p.user.id);
		await autoSaveOn(p, w);
		google.state.messages.set('a1', qris('a1', 7));
		const j = jobs({ registry: REGISTRY });
		await hourly(j, c.id);
		const [draft] = await draftsOf(p.space.id);
		if (draft!.category_id === null && draft!.deleted_at === null)
			throw new Error('the fixture merchant got no category (FN-20 dictionary changed?)');
		const txs = await txOf(p.space.id);
		expect(txs).toHaveLength(1);
		const tx = txs[0]!;
		expect(tx).toMatchObject({
			source: 'gmail',
			wallet_id: w,
			type: 'expense',
			amount_minor: qrisMinor(7),
			currency: 'IDR',
			occurred_on: '2026-10-08',
			category_source: 'auto'
		});
		expect(String(tx.note)).toContain('Pengirim belum terverifikasi');
		expect(draft).toMatchObject({ deleted_at: expect.any(Number), saved_transaction_id: tx.id });
		expect(tx.dedupe_key).toBe(draft!.dedupe_key);
		expect(await readWalletBalance(db, p.space.id, w)).toBe(-BigInt(qrisMinor(7)));
		const [note] = await notifications(p.user.id);
		expect(JSON.parse(note!.params)).toMatchObject({ saved: true, transactionId: tx.id });
		expect(await connRow(p.user.id)).toMatchObject({
			auto_saves: 1,
			auto_save_day: wibDateString(NOON)
		});
	});

	it('a 23:30 WIB month-end mail is saved on that WIB date', async () => {
		const p = await person();
		const c = await connect(p);
		const w = await wallet(p.space.id, p.user.id);
		await autoSaveOn(p, w);
		google.state.messages.set(
			'me1',
			await gmailFromFixture('bank-qris/month-end', 'me1', { authResults: googlePass() })
		);
		await hourly(jobs({ registry: REGISTRY }), c.id);
		const txs = await txOf(p.space.id);
		expect(txs).toHaveLength(1);
		expect(txs[0]).toMatchObject({ occurred_on: '2026-10-31' });
	});

	describe('each rule alone keeps the capture a draft (AC 10)', () => {
		/** A person with a connection, an IDR wallet, auto-save on, and one eligible pending Gmail draft. */
		async function eligible(amountMinor = 2_800_000, extra: Record<string, unknown> = {}) {
			const p = await person();
			const c = await connect(p);
			const w = await wallet(p.space.id, p.user.id);
			await autoSaveOn(p, w);
			const kopi = (await listCategories(db, p.space.id)).find((k) => k.tileKey === 'kopi')!.id;
			const draftId = crypto.randomUUID().replace(/-/g, '');
			const row = {
				type: 'expense',
				category: kopi,
				flag: 'needs_review',
				...extra
			};
			await db.run(sql`insert into drafts (id, space_id, type, amount_minor, currency, title, note, category_id,
				wallet_id, occurred_on, occurred_at, source, dedupe_key, flag, is_demo, created_at, updated_at, seq)
				values (${draftId}, ${p.space.id}, ${row.type}, ${amountMinor}, 'IDR', 'Kedai Kopi Senja',
					'Belum diverifikasi', ${row.category as string | null}, null, '2026-10-08', ${NOON},
					'gmail', ${`mail:m:${draftId}`}, ${row.flag as string | null}, 0, ${NOON}, ${NOON}, 0)`);
			const input: AutoSaveInput = {
				connectionId: c.id,
				spaceId: p.space.id,
				userId: p.user.id,
				draftId,
				parser: 'bank-qris',
				senderDomain: FIXTURE_DOMAIN,
				scanKind: 'hourly',
				senderAuthenticated: true
			};
			return { p, c, w, draftId, input, kopi };
		}
		async function staysDraft(
			e: Awaited<ReturnType<typeof eligible>>,
			txId: string | null,
			counted = 0
		) {
			expect(txId).toBeNull();
			const d = (await db.get<Record<string, unknown>>(
				sql`select * from drafts where id = ${e.draftId}`
			))!;
			expect(d).toMatchObject({ deleted_at: null, wallet_id: null, saved_transaction_id: null });
			expect(await txOf(e.p.space.id)).toEqual([]);
			// Refused by the guarded claim itself (not only by the save path behind it): no auto-save was counted.
			expect((await connRow(e.p.user.id))!.auto_saves).toBe(counted);
		}

		it('baseline: the same setup saves', async () => {
			const e = await eligible();
			expect(await autoSaveCapture(db, e.input, NOON, REGISTRY)).toEqual(expect.any(String));
		});

		it('AI reading', async () => {
			const e = await eligible();
			await staysDraft(e, await autoSaveCapture(db, { ...e.input, parser: 'ai' }, NOON, REGISTRY));
		});

		it('fixture domain without a confirmed registry (the shipped one), and an unknown domain', async () => {
			const e = await eligible();
			await staysDraft(e, await autoSaveCapture(db, e.input, NOON));
			await staysDraft(
				e,
				await autoSaveCapture(
					db,
					{ ...e.input, senderDomain: `evil-${FIXTURE_DOMAIN}` },
					NOON,
					REGISTRY
				)
			);
		});

		it('income', async () => {
			const e = await eligible(2_800_000, { type: 'income', category: null });
			const gaji = (await listCategories(db, e.p.space.id)).find((k) => k.kind === 'income')!.id;
			await db.run(sql`update drafts set category_id = ${gaji} where id = ${e.draftId}`);
			await staysDraft(e, await autoSaveCapture(db, e.input, NOON, REGISTRY));
		});

		it('over the amount cap (and exactly at it saves)', async () => {
			const e = await eligible(GMAIL_AUTOSAVE_MAX_MINOR + 1);
			await staysDraft(e, await autoSaveCapture(db, e.input, NOON, REGISTRY));
			const at = await eligible(GMAIL_AUTOSAVE_MAX_MINOR);
			expect(await autoSaveCapture(db, at.input, NOON, REGISTRY)).toEqual(expect.any(String));
		});

		it('duplicate flag', async () => {
			const e = await eligible(2_800_000, { flag: 'duplicate' });
			await staysDraft(e, await autoSaveCapture(db, e.input, NOON, REGISTRY));
		});

		it('no category', async () => {
			const e = await eligible(2_800_000, { category: null });
			await staysDraft(e, await autoSaveCapture(db, e.input, NOON, REGISTRY));
		});

		it('look-back scan', async () => {
			const e = await eligible();
			await staysDraft(
				e,
				await autoSaveCapture(db, { ...e.input, scanKind: 'lookback' }, NOON, REGISTRY)
			);
		});

		it(`the ${GMAIL_AUTOSAVE_PER_DAY + 1}th of the WIB day; the counter rolls at 00:00 WIB`, async () => {
			const e = await eligible();
			const today = wibDateString(NOON);
			await db.run(sql`update gmail_connections set auto_save_day = ${today}, auto_saves = ${GMAIL_AUTOSAVE_PER_DAY}
				where id = ${e.c.id}`);
			await staysDraft(
				e,
				await autoSaveCapture(db, e.input, NOON, REGISTRY),
				GMAIL_AUTOSAVE_PER_DAY
			);
			// Yesterday's full counter does not hold today back, and restarts at 1.
			await db.run(
				sql`update gmail_connections set auto_save_day = ${addDays(today, -1)} where id = ${e.c.id}`
			);
			const midnight = wibInstantUtcMs(today, '00:00');
			expect(await autoSaveCapture(db, e.input, midnight, REGISTRY)).toEqual(expect.any(String));
			expect(await connRow(e.p.user.id)).toMatchObject({ auto_save_day: today, auto_saves: 1 });
		});

		it('wallet deleted, or not IDR', async () => {
			const e = await eligible();
			await db.run(sql`update wallets set deleted_at = ${NOON} where id = ${e.w}`);
			await staysDraft(e, await autoSaveCapture(db, e.input, NOON, REGISTRY));
			const f = await eligible();
			const usd = await wallet(f.p.space.id, f.p.user.id, 'USD', 'Wise');
			await db.run(
				sql`update gmail_connections set auto_save_wallet_id = ${usd} where id = ${f.c.id}`
			);
			await staysDraft(f, await autoSaveCapture(db, f.input, NOON, REGISTRY));
		});

		it('auto-save switched off after the read was queued', async () => {
			const e = await eligible();
			const c = (await settings(e.p)).connection;
			expect(
				await act(e.p, 'autoSave', { connectionId: c.id, updatedAt: String(c.updatedAt), on: '0' })
			).toEqual({ kind: 'ok', value: { done: 'autosave_off' } });
			await staysDraft(e, await autoSaveCapture(db, e.input, NOON, REGISTRY));
		});

		it('connection needs_reconnect', async () => {
			const e = await eligible();
			await db.run(sql`update gmail_connections set status = 'needs_reconnect', reconnect_reason = 'revoked'
				where id = ${e.c.id}`);
			await staysDraft(e, await autoSaveCapture(db, e.input, NOON, REGISTRY));
		});

		it('owner left the space', async () => {
			const owner = await person();
			const m = await person();
			const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
			await db.run(sql`insert into space_members (id, space_id, user_id, role, created_at, updated_at)
				values (${crypto.randomUUID()}, ${shared}, ${m.user.id}, 'member', 0, 0)`);
			await ensurePresetCategories(db, shared, Date.now());
			const c = await connect(m, shared);
			const w = await wallet(shared, m.user.id);
			await autoSaveOn(m, w);
			const kopi = (await listCategories(db, shared)).find((k) => k.tileKey === 'kopi')!.id;
			const draftId = crypto.randomUUID().replace(/-/g, '');
			await db.run(sql`insert into drafts (id, space_id, type, amount_minor, currency, title, category_id,
				occurred_on, occurred_at, source, dedupe_key, is_demo, created_at, updated_at, seq)
				values (${draftId}, ${shared}, 'expense', 2800000, 'IDR', 'Kopi', ${kopi}, '2026-10-08', ${NOON},
					'gmail', ${`mail:m:${draftId}`}, 0, ${NOON}, ${NOON}, 0)`);
			await db.run(
				sql`update space_members set deleted_at = ${NOON} where space_id = ${shared} and user_id = ${m.user.id}`
			);
			const input = {
				connectionId: c.id,
				spaceId: shared,
				userId: m.user.id,
				draftId,
				parser: 'bank-qris' as const,
				senderDomain: FIXTURE_DOMAIN,
				scanKind: 'hourly' as const,
				senderAuthenticated: true
			};
			expect(await autoSaveCapture(db, input, NOON, REGISTRY)).toBeNull();
			expect(await txOf(shared)).toEqual([]);
			expect((await connRow(m.user.id))!.auto_saves).toBe(0);
		});

		it('the space is at its transaction cap: stays a draft, without the wallet, no error', async () => {
			const e = await eligible();
			await d1
				.prepare(
					`insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id, title,
						occurred_on, occurred_at, source, is_demo, created_at, updated_at, seq)
					with recursive n(i) as (select 1 union all select i + 1 from n where i < 100000)
					select 'cap-' || ?1 || '-' || i, ?1, 'expense', 100, 'IDR', ?2, ?3, 'x', '2026-01-01', 1, 'manual', 0,
						1, 1, 0 from n`
				)
				.bind(e.p.space.id, e.kopi, e.w)
				.run();
			expect(await autoSaveCapture(db, e.input, NOON, REGISTRY)).toBeNull();
			const d = (await db.get<Record<string, unknown>>(
				sql`select * from drafts where id = ${e.draftId}`
			))!;
			expect(d).toMatchObject({ deleted_at: null, wallet_id: null, saved_transaction_id: null });
		});
	});

	it(`20 concurrent eligible captures past the cap: exactly ${GMAIL_AUTOSAVE_PER_DAY} saved, the rest drafts (AC 11)`, async () => {
		const p = await person();
		const c = await connect(p);
		const w = await wallet(p.space.id, p.user.id);
		await autoSaveOn(p, w);
		const kopi = (await listCategories(db, p.space.id)).find((k) => k.tileKey === 'kopi')!.id;
		const ids: string[] = [];
		for (let i = 0; i < GMAIL_AUTOSAVE_PER_DAY + 5; i++) {
			const id = crypto.randomUUID().replace(/-/g, '');
			ids.push(id);
			await db.run(sql`insert into drafts (id, space_id, type, amount_minor, currency, title, category_id,
				occurred_on, occurred_at, source, dedupe_key, is_demo, created_at, updated_at, seq)
				values (${id}, ${p.space.id}, 'expense', ${100_000 + i}, 'IDR', 'Kopi', ${kopi}, '2026-10-08', ${NOON},
					'gmail', ${`mail:m:${id}`}, 0, ${NOON}, ${NOON}, 0)`);
		}
		const results = await Promise.all(
			ids.map((draftId) =>
				autoSaveCapture(
					db,
					{
						connectionId: c.id,
						spaceId: p.space.id,
						userId: p.user.id,
						draftId,
						parser: 'bank-qris',
						senderDomain: FIXTURE_DOMAIN,
						scanKind: 'hourly',
						senderAuthenticated: true
					},
					NOON,
					REGISTRY
				)
			)
		);
		expect(results.filter((r) => r !== null)).toHaveLength(GMAIL_AUTOSAVE_PER_DAY);
		expect(await txOf(p.space.id)).toHaveLength(GMAIL_AUTOSAVE_PER_DAY);
		expect((await draftsOf(p.space.id)).filter((d) => d.deleted_at === null)).toHaveLength(5);
		expect((await connRow(p.user.id))!.auto_saves).toBe(GMAIL_AUTOSAVE_PER_DAY);
	});

	it("setAutoSave refuses another space's, a deleted and a non-IDR wallet, a non-member and a stale form; success persists (AC 13)", async () => {
		const p = await person();
		const other = await person();
		const c = await connect(p);
		const mine = await wallet(p.space.id, p.user.id);
		const theirs = await wallet(other.space.id, other.user.id);
		const usd = await wallet(p.space.id, p.user.id, 'USD', 'Wise');
		const gone = await wallet(p.space.id, p.user.id, 'IDR', 'Lama');
		await db.run(sql`update wallets set deleted_at = ${Date.now()} where id = ${gone}`);
		const s0 = await settings(p);
		expect(s0.confirmedSenders).toBe(0);
		expect(s0.wallets.map((x) => x.id).sort()).toEqual([mine].sort());
		const form = (walletId: string) => ({
			connectionId: c.id,
			updatedAt: String(c.updatedAt),
			on: '1',
			walletId
		});
		for (const bad of [theirs, usd, gone, 'nope'])
			expect(await act(p, 'autoSave', form(bad))).toEqual({
				kind: 'fail',
				status: 400,
				error: GMAIL_AUTOSAVE_WALLET
			});
		expect(await act(p, 'autoSave', { ...form(''), walletId: '' })).toMatchObject({
			kind: 'fail',
			error: GMAIL_AUTOSAVE_WALLET
		});
		expect((await connRow(p.user.id))!.auto_save).toBe(0);
		expect(await act(p, 'autoSave', { ...form(mine), updatedAt: String(c.updatedAt - 1) })).toEqual(
			{
				kind: 'fail',
				status: 409,
				error: GMAIL_CHANGED_MEANWHILE
			}
		);
		expect(await act(p, 'autoSave', form(mine))).toEqual({
			kind: 'ok',
			value: { done: 'autosave_on' }
		});
		const s1 = await settings(p);
		expect(s1.connection).toMatchObject({ autoSave: true, autoSaveWalletId: mine });
		// The old form is stale now.
		expect(await act(p, 'autoSave', form(mine))).toMatchObject({ kind: 'fail', status: 409 });

		// A member who left the connection's target space.
		const owner = await person();
		const m = await person();
		const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		await db.run(sql`insert into space_members (id, space_id, user_id, role, created_at, updated_at)
			values (${crypto.randomUUID()}, ${shared}, ${m.user.id}, 'member', 0, 0)`);
		const cm = await connect(m, shared);
		const sw = await wallet(shared, owner.user.id);
		await db.run(
			sql`update space_members set deleted_at = ${Date.now()} where space_id = ${shared} and user_id = ${m.user.id}`
		);
		expect(
			await act(m, 'autoSave', {
				connectionId: cm.id,
				updatedAt: String(cm.updatedAt),
				on: '1',
				walletId: sw
			})
		).toEqual({ kind: 'fail', status: 403, error: GMAIL_AUTOSAVE_SPACE });
	});
});

describe('"Transaksi dari Gmail" and undo by scan (AC 15–21)', () => {
	/** Two scans: an hourly one with auto-saved rows, a look-back with drafts. Hex Gmail ids (as Google's). */
	async function twoScans() {
		const p = await person();
		const c = await connect(p);
		const w = await wallet(p.space.id, p.user.id);
		await autoSaveOn(p, w);
		const j = jobs({ registry: REGISTRY });
		google.state.messages.set('aa01', qris('aa01', 60));
		google.state.messages.set('aa02', qris('aa02', 61));
		await hourly(j, c.id);
		google.state.messages.clear();
		google.state.messages.set('bb01', qris('bb01', 62));
		google.state.messages.set('bb02', qris('bb02', 63));
		google.state.messages.set('bb03', qris('bb03', 64));
		expect((await act(p, 'lookback', { connectionId: c.id, days: '7' })).kind).toBe('ok');
		const lb = (await db.get<{ id: string; scan_window: string }>(
			sql`select id, scan_window from gmail_scans where connection_id = ${c.id} and kind = 'lookback'`
		))!;
		j.queue.push({
			type: 'gmail_check',
			connectionId: c.id,
			kind: 'lookback',
			window: lb.scan_window,
			page: 0
		});
		await j.drain();
		const hourlyScan = (await db.get<{ id: string }>(
			sql`select id from gmail_scans where connection_id = ${c.id} and kind = 'hourly'`
		))!;
		return { p, c, w, j, lookback: lb.id, hourly: hourlyScan.id };
	}

	it('groups per day and scan; states and the day total match the database; links come from stored ids', async () => {
		const s = await twoScans();
		const data = await reviewLoad(s.p);
		expect(data.connected).toBe(true);
		expect(data.loadError).toBeNull();
		const rows = data.days.flatMap((d) => d.scans.flatMap((g) => g.rows));
		expect(rows).toHaveLength(5);
		const byScan = Object.fromEntries(
			data.days.flatMap((d) => d.scans).map((g) => [g.key, g.rows.map((r) => r.state).sort()])
		);
		expect(await txOf(s.p.space.id)).toHaveLength(2);
		expect(byScan[s.hourly]).toEqual(['saved', 'saved']);
		expect(byScan[s.lookback]).toEqual(['draft', 'draft', 'draft']);
		for (const day of data.days) {
			const saved = day.scans
				.flatMap((g) => g.rows)
				.filter((r) => r.state === 'saved' && r.direction === 'expense')
				.reduce((a, r) => a + r.amountMinor!, 0);
			expect(day.savedOutMinor).toBe(saved);
		}
		const live = await db.get<{
			n: number;
		}>(sql`select coalesce(sum(amount_minor), 0) as n from transactions
			where space_id = ${s.p.space.id} and deleted_at is null and type = 'expense'`);
		expect(data.days.reduce((a, d) => a + d.savedOutMinor, 0)).toBe(live!.n);
		expect(rows[0]!.gmailUrl).toMatch(
			/^https:\/\/mail\.google\.com\/mail\/u\/pemilik%40gmail\.example\/#all\/[0-9a-f]+$/
		);
	});

	it('undo a scan: pending drafts and unedited saved transactions go, an edited one stays and is counted; balances reconcile; never recreated (AC 17, 18)', async () => {
		const p = await person();
		const c = await connect(p);
		const w = await wallet(p.space.id, p.user.id);
		await autoSaveOn(p, w);
		const j = jobs({ registry: REGISTRY });
		// One hourly check: 2 auto-saved (registry domain) and 3 drafts (an unconfirmed domain: AI path off → the
		// deterministic parser of a fixture domain reads them, but they never auto-save).
		google.state.messages.set('cc01', qris('cc01', 70));
		google.state.messages.set('cc02', qris('cc02', 71));
		for (const [i, id] of ['cc03', 'cc04', 'cc05'].entries())
			google.state.messages.set(
				id,
				gmailMessage({
					id,
					from: 'Dompet <noreply@struk.dompet-digital.example>',
					subject: 'Bukti pembayaran',
					text: `Pembayaran ke Toko Uji ${i}\nTotal bayar Rp ${80 + i}.000\n08 Okt 2026, 10:0${i}\nID Transaksi : GP-${id}`,
					messageId: `<${id}@struk.dompet-digital.example>`
				})
			);
		await hourly(j, c.id);
		const scanId = (await db.get<{ id: string }>(
			sql`select id from gmail_scans where connection_id = ${c.id} and kind = 'hourly'`
		))!.id;
		const txs = await txOf(p.space.id);
		expect(txs).toHaveLength(2);
		expect((await draftsOf(p.space.id)).filter((d) => d.deleted_at === null)).toHaveLength(3);
		// The user edits one saved transaction (any later write moves updated_at past created_at).
		const edited = txs[0]!;
		await db.run(
			sql`update transactions set title = 'Kopi pagi', updated_at = updated_at + 1000 where id = ${edited.id}`
		);
		const balanceBefore = await readWalletBalance(db, p.space.id, w);
		expect(balanceBefore).toBe(-BigInt(qrisMinor(70) + qrisMinor(71)));

		const r = await reviewAct(p, 'undo', { scanId });
		expect(r).toEqual({ kind: 'ok', value: { undone: { scanId, cancelled: 4, skipped: 1 } } });
		const after = await txOf(p.space.id);
		expect(after.filter((t) => t.deleted_at === null).map((t) => t.id)).toEqual([edited.id]);
		expect((await draftsOf(p.space.id)).filter((d) => d.deleted_at === null)).toEqual([]);
		expect(await readWalletBalance(db, p.space.id, w)).toBe(-BigInt(edited.amount_minor as number));
		// Twice: nothing changes.
		expect(await reviewAct(p, 'undo', { scanId })).toEqual({
			kind: 'fail',
			status: 409,
			error: GMAIL_UNDO_ALREADY
		});
		// The next hourly check finds the same mails: none is recreated (ledger and dedupe keys stay).
		await hourly(j, c.id);
		expect((await draftsOf(p.space.id)).filter((d) => d.deleted_at === null)).toEqual([]);
		expect((await txOf(p.space.id)).filter((t) => t.deleted_at === null)).toHaveLength(1);
		const data = await reviewLoad(p);
		const group = data.days.flatMap((d) => d.scans).find((g) => g.key === scanId)!;
		expect(group.scan!.undoable).toBe(false);
		expect(group.rows.map((x) => x.state).sort()).toEqual([
			'cancelled',
			'cancelled',
			'cancelled',
			'cancelled',
			'saved'
		]);
	});

	it('past the 7-day window the saved transactions stay (skipped); pending drafts still go', async () => {
		const s = await twoScans();
		await db.run(
			sql`update gmail_scans set updated_at = ${Date.now() - 8 * 24 * 60 * 60 * 1000} where id = ${s.hourly}`
		);
		const saved = (await txOf(s.p.space.id)).length;
		const r = await reviewAct(s.p, 'undo', { scanId: s.hourly });
		expect(r).toEqual({
			kind: 'ok',
			value: { undone: { scanId: s.hourly, cancelled: 0, skipped: saved } }
		});
		expect((await txOf(s.p.space.id)).filter((t) => t.deleted_at === null)).toHaveLength(saved);
		const lb = await reviewAct(s.p, 'undo', { scanId: s.lookback });
		expect(lb).toEqual({
			kind: 'ok',
			value: { undone: { scanId: s.lookback, cancelled: 3, skipped: 0 } }
		});
	});

	it('undo racing a save in another tab: exact counts, nothing partial', async () => {
		const s = await twoScans();
		const pending = (await draftsOf(s.p.space.id)).filter((d) => d.deleted_at === null);
		expect(pending).toHaveLength(3);
		const kopi = (await listCategories(db, s.p.space.id)).find((k) => k.tileKey === 'kopi')!.id;
		await db.run(sql`update drafts set wallet_id = ${s.w}, category_id = ${kopi} where space_id = ${s.p.space.id}
			and deleted_at is null`);
		const [undo, save] = await Promise.all([
			reviewAct(s.p, 'undo', { scanId: s.lookback }),
			reviewAct(s.p, 'saveAll', { scanId: s.lookback })
		]);
		const live = {
			drafts: (await draftsOf(s.p.space.id)).filter((d) => d.deleted_at === null).length,
			txs: (await txOf(s.p.space.id)).filter((t) => t.deleted_at === null).length
		};
		// Whichever ran first, the scan ends with none of its captures live and exact counts: either the save won
		// (3 unedited transactions, then tombstoned by the undo) or the undo did (3 drafts; the save finds none).
		expect(undo).toMatchObject({ kind: 'ok', value: { undone: { cancelled: 3, skipped: 0 } } });
		expect(live).toEqual({ drafts: 0, txs: 2 });
		expect(['ok', 'fail']).toContain(save.kind);
	});

	it('"Simpan semua yang lengkap" saves complete look-back drafts and counts the rest', async () => {
		const s = await twoScans();
		const kopi = (await listCategories(db, s.p.space.id)).find((k) => k.tileKey === 'kopi')!.id;
		const [first] = (await draftsOf(s.p.space.id)).filter((d) => d.deleted_at === null);
		await db.run(
			sql`update drafts set wallet_id = ${s.w}, category_id = ${kopi} where id = ${first!.id}`
		);
		const r = await reviewAct(s.p, 'saveAll', { scanId: s.lookback });
		expect(r).toEqual({
			kind: 'ok',
			value: { savedAll: { scanId: s.lookback, saved: 1, incomplete: 2 } }
		});
		expect(await reviewAct(s.p, 'saveAll', { scanId: s.hourly })).toMatchObject({
			kind: 'fail',
			status: 404,
			error: GMAIL_SCAN_NOT_FOUND
		});
	});

	it('another user, a removed member and another space get 404 and no rows (AC 19)', async () => {
		const s = await twoScans();
		const stranger = await person();
		await connect(stranger);
		for (const scanId of [s.hourly, s.lookback, 'f'.repeat(32), ''])
			for (const name of ['undo', 'saveAll'] as const)
				expect(await reviewAct(stranger, name, { scanId })).toEqual({
					kind: 'fail',
					status: 404,
					error: GMAIL_SCAN_NOT_FOUND
				});
		const strangerData = await reviewLoad(stranger);
		expect(strangerData.days).toEqual([]);
		expect(JSON.stringify(strangerData)).not.toContain(s.hourly);
		// Nothing changed for the owner.
		expect((await reviewLoad(s.p)).days.flatMap((d) => d.scans)).toHaveLength(2);

		// A member removed from the shared space their Gmail records into: rows of that space vanish, undo is refused.
		const owner = await person();
		const m = await person();
		const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		await db.run(sql`insert into space_members (id, space_id, user_id, role, created_at, updated_at)
			values (${crypto.randomUUID()}, ${shared}, ${m.user.id}, 'member', 0, 0)`);
		const cm = await connect(m, shared);
		google.state.messages.clear();
		google.state.messages.set('dd01', qris('dd01', 80));
		await hourly(jobs(), cm.id);
		expect((await reviewLoad(m)).days).toHaveLength(1);
		await db.run(
			sql`update space_members set deleted_at = ${Date.now()} where space_id = ${shared} and user_id = ${m.user.id}`
		);
		expect((await reviewLoad(m)).days).toEqual([]);
		const scanId = (await db.get<{ id: string }>(
			sql`select id from gmail_scans where connection_id = ${cm.id}`
		))!.id;
		expect((await reviewAct(m, 'undo', { scanId })).kind).toBe('ok');
		// The scan is the user's own, but the space's drafts are out of reach: nothing in it was touched.
		expect((await draftsOf(shared)).filter((d) => d.deleted_at === null)).toHaveLength(1);
	});

	it('signed out redirects; not connected and a failed load show their states (AC 16)', async () => {
		expect(await run(() => review.load(reviewEv(null).event as never))).toMatchObject({
			kind: 'redirect',
			location: '/masuk'
		});
		expect(await reviewAct(null, 'undo', { scanId: 'x' })).toMatchObject({ kind: 'redirect' });
		const p = await person();
		expect(await reviewLoad(p)).toMatchObject({ connected: false, days: [], loadError: null });
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const broken = fakeEvent({
			url: `${ORIGIN}/pengaturan/aplikasi/gmail/transaksi`,
			routeId: '/(app)/pengaturan/aplikasi/gmail/transaksi',
			db: getDb({
				prepare: () => {
					throw new Error('D1_ERROR: unavailable');
				},
				batch: () => Promise.reject(new Error('D1_ERROR: unavailable'))
			} as unknown as D1Database),
			user: p.user,
			space: p.space
		});
		const data = (await review.load(broken.event as never)) as unknown as ReviewData;
		expect(data.loadError).toEqual(expect.any(String));
	});

	it('disconnect deletes the scans (undo state included); saved transactions stay (AC 21)', async () => {
		const s = await twoScans();
		await reviewAct(s.p, 'undo', { scanId: s.lookback });
		const savedLive = (await txOf(s.p.space.id)).filter((t) => t.deleted_at === null).length;
		const c = (await settings(s.p)).connection;
		const r = await act(s.p, 'disconnect', { connectionId: c.id, updatedAt: String(c.updatedAt) });
		expect(r.kind).toBe('ok');
		expect(
			await db.get(sql`select id from gmail_scans where connection_id = ${s.c.id}`)
		).toBeUndefined();
		expect((await txOf(s.p.space.id)).filter((t) => t.deleted_at === null)).toHaveLength(savedLive);
	});
});

describe("red team M1: auto-save requires Gmail's own sender authentication", () => {
	/** A person with auto-save on into an IDR wallet; one hourly check of `mail`; what it became. */
	async function captureWith(auth: string[]) {
		const p = await person();
		const c = await connect(p);
		const w = await wallet(p.space.id, p.user.id);
		await autoSaveOn(p, w);
		google.state.messages.set('au1', qris('au1', 90, { amount: 'Rp 4.999.999,00', auth }));
		await hourly(jobs({ registry: REGISTRY }), c.id);
		const drafts = await draftsOf(p.space.id);
		expect(drafts).toHaveLength(1);
		return { txs: await txOf(p.space.id), draft: drafts[0]!, conn: (await connRow(p.user.id))! };
	}
	const other = 'evil.example';
	const cases: [string, string[]][] = [
		['no Authentication-Results header', []],
		[
			'spf and dmarc fail (p=none lets it reach the inbox)',
			[
				`mx.google.com; spf=fail smtp.mailfrom=noreply@${FIXTURE_DOMAIN}; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=${FIXTURE_DOMAIN}`
			]
		],
		[
			'dkim passes but dmarc fails',
			[
				`mx.google.com; dkim=pass header.i=@${FIXTURE_DOMAIN}; dmarc=fail (p=NONE) header.from=${FIXTURE_DOMAIN}`
			]
		],
		[
			'a non-Google header on top (a forged pass below it does not count)',
			[
				`mx.evil.example; dkim=pass header.i=@${FIXTURE_DOMAIN}; dmarc=pass header.from=${FIXTURE_DOMAIN}`,
				googlePass()
			]
		],
		[
			'misaligned DKIM (signed by another domain)',
			[
				`mx.google.com; dkim=pass header.i=@${other}; spf=pass; dmarc=pass header.from=${FIXTURE_DOMAIN}`
			]
		],
		[
			'dmarc pass for another domain',
			[`mx.google.com; dkim=pass header.i=@${other}; dmarc=pass header.from=${other}`]
		],
		[
			'dmarc pass without header.from',
			[`mx.google.com; dkim=pass header.i=@${FIXTURE_DOMAIN}; dmarc=pass`]
		]
	];
	for (const [name, auth] of cases)
		it(`${name}: stays a draft, no claim counted`, async () => {
			const r = await captureWith(auth);
			expect(r.txs).toEqual([]);
			expect(r.draft).toMatchObject({ deleted_at: null, wallet_id: null });
			expect(r.conn.auto_saves).toBe(0);
		});

	it("DMARC pass for the registry domain with an aligned DKIM pass, on Gmail's own top header: saved", async () => {
		const r = await captureWith([googlePass()]);
		expect(r.txs).toHaveLength(1);
		expect(r.txs[0]).toMatchObject({ amount_minor: 499_999_900, source: 'gmail' });
		// The trust label stays `unverified` (owner decision 2026-10-13).
		expect(
			(await db.get<{ trust: string }>(
				sql`select trust from gmail_mail where gmail_id = 'au1' and draft_id = ${r.draft.id}`
			))!.trust
		).toBe('unverified');
	});
});

describe('red team L4: a forged registry From never names merchant and amount', () => {
	it('a registry-domain capture that Gmail did not authenticate gets the generic push', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set(
			'l4',
			qris('l4', 93, {
				merchant: 'KLIK TAUTAN HADIAH',
				auth: [
					`mx.google.com; spf=fail smtp.mailfrom=noreply@${FIXTURE_DOMAIN}; dmarc=fail (p=NONE) header.from=${FIXTURE_DOMAIN}`
				]
			})
		);
		await hourly(jobs({ registry: REGISTRY }), c.id);
		const [row] = await notifications(p.user.id);
		expect(JSON.parse(row!.params)).toMatchObject({ merchant: null, amountMinor: null });
		expect(row!.params).not.toMatch(/KLIK|Klik|HADIAH/);
	});
});

describe('red team L1: only a deterministic reading of a confirmed sender names merchant and amount', () => {
	it('an unconfirmed sender (no registry) and an AI-path domain get the generic "Perlu ditinjau"', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('g1', qris('g1', 91, { merchant: 'HADIAH KLIK TAUTAN INI' }));
		await hourly(jobs(), c.id);
		const [row] = await notifications(p.user.id);
		const params = JSON.parse(row!.params);
		expect(params).toMatchObject({
			merchant: null,
			amountMinor: null,
			categoryName: null,
			saved: false
		});
		// The mail's merchant and amount (Rp 119.000) appear nowhere; the random draft id is left out of the check.
		const shown = JSON.stringify({ ...params, draftId: null });
		expect(shown).not.toMatch(/HADIAH|Hadiah/);
		expect(shown).not.toContain(String(qrisMinor(91)));
		expect(shown).not.toMatch(/119[.,]?000/);
		const { notificationText, parseParams } = await import('#lib/shared/notifications');
		const { createTranslator } = await import('#lib/shared/i18n');
		expect(
			notificationText(
				'gmail_payment',
				parseParams('gmail_payment', row!.params),
				createTranslator('id'),
				'Pribadi'
			)
		).toEqual({ title: 'Pembayaran baru dari Gmail', body: 'Perlu ditinjau' });
	});

	it('a confirmed registry sender keeps merchant and amount', async () => {
		const p = await person();
		const c = await connect(p);
		google.state.messages.set('g2', qris('g2', 92));
		await hourly(jobs({ registry: REGISTRY }), c.id);
		const [row] = await notifications(p.user.id);
		expect(JSON.parse(row!.params)).toMatchObject({
			amountMinor: qrisMinor(92),
			merchant: expect.any(String)
		});
	});
});

describe('red team L3: the notify toggle is throttled and refuses a stale form', () => {
	it('a stale or malformed version answers 409 and changes nothing; the fresh one saves', async () => {
		const p = await person();
		await connect(p);
		const v0 = (await settings(p)).notifyVersion;
		expect(v0).toBe(0);
		expect(await act(p, 'notify', { on: '0', version: '0' })).toEqual({
			kind: 'ok',
			value: { done: 'notify_off' }
		});
		// The old tab still holds version 0: refused, the newer choice stays.
		expect(await act(p, 'notify', { on: '1', version: '0' })).toMatchObject({
			kind: 'fail',
			status: 409
		});
		expect(await act(p, 'notify', { on: '1', version: 'x' })).toMatchObject({
			kind: 'fail',
			status: 409
		});
		expect((await settings(p)).notify).toBe(false);
		const v1 = (await settings(p)).notifyVersion;
		expect(await act(p, 'notify', { on: '1', version: String(v1) })).toEqual({
			kind: 'ok',
			value: { done: 'notify_on' }
		});
		expect((await settings(p)).notify).toBe(true);
	});

	it('is throttled per user in its own bucket (QA F6): the auto-save setting stays usable', async () => {
		const p = await person();
		await connect(p);
		const w = await wallet(p.space.id, p.user.id);
		let last: Run | null = null;
		for (let i = 0; i < 12; i++)
			last = await act(p, 'notify', {
				on: '1',
				version: String((await settings(p)).notifyVersion)
			});
		expect(last).toMatchObject({ kind: 'fail', status: 429 });
		await autoSaveOn(p, w);
	});
});

describe('QA F1: "Simpan semua yang lengkap" on a fresh look-back', () => {
	it('fills the chosen wallet and expense category on drafts without one, then saves the complete ones', async () => {
		const p = await person();
		const c = await connect(p);
		const w = await wallet(p.space.id, p.user.id);
		for (const i of [0, 1, 2]) google.state.messages.set(`fr${i}`, qris(`fr${i}`, 100 + i));
		expect((await act(p, 'lookback', { connectionId: c.id, days: '7' })).kind).toBe('ok');
		const lb = (await db.get<{ id: string; scan_window: string }>(
			sql`select id, scan_window from gmail_scans where connection_id = ${c.id} and kind = 'lookback'`
		))!;
		const j = jobs();
		j.queue.push({
			type: 'gmail_check',
			connectionId: c.id,
			kind: 'lookback',
			window: lb.scan_window,
			page: 0
		});
		await j.drain();
		// Fresh capture: no wallet; drop one category so the category choice is exercised too.
		const pending = (await draftsOf(p.space.id)).filter((d) => d.deleted_at === null);
		expect(pending).toHaveLength(3);
		expect(pending.every((d) => d.wallet_id === null)).toBe(true);
		await db.run(sql`update drafts set category_id = null where id = ${pending[0]!.id as string}`);
		const data = (await review.load(reviewEv(p).event as never)) as unknown as {
			wallets: { id: string }[];
			categories: { id: string; name: string }[];
		};
		expect(data.wallets.map((x) => x.id)).toEqual([w]);
		const kopi = (await listCategories(db, p.space.id)).find((k) => k.tileKey === 'kopi')!.id;
		expect(data.categories.map((x) => x.id)).toContain(kopi);
		// Without choices nothing is complete yet.
		expect(await reviewAct(p, 'saveAll', { scanId: lb.id })).toEqual({
			kind: 'ok',
			value: { savedAll: { scanId: lb.id, saved: 0, incomplete: 3 } }
		});
		// Another space's wallet or a bogus category is refused before anything is written.
		const stranger = await person();
		const theirs = await wallet(stranger.space.id, stranger.user.id);
		expect(await reviewAct(p, 'saveAll', { scanId: lb.id, walletId: theirs })).toMatchObject({
			kind: 'fail',
			status: 400
		});
		expect(
			await reviewAct(p, 'saveAll', { scanId: lb.id, walletId: w, categoryId: 'f'.repeat(32) })
		).toMatchObject({ kind: 'fail', status: 400 });
		const r = await reviewAct(p, 'saveAll', { scanId: lb.id, walletId: w, categoryId: kopi });
		expect(r).toEqual({
			kind: 'ok',
			value: { savedAll: { scanId: lb.id, saved: 3, incomplete: 0 } }
		});
		const txs = await txOf(p.space.id);
		expect(txs).toHaveLength(3);
		expect(txs.every((t) => t.wallet_id === w && t.source === 'gmail')).toBe(true);
		expect(await readWalletBalance(db, p.space.id, w)).toBe(
			-BigInt(qrisMinor(100) + qrisMinor(101) + qrisMinor(102))
		);
	});
});
