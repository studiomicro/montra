import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveKey } from '#lib/server/ai-keys/repo';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import { exportAccount } from '#lib/server/export/account-export';
import { processInboundRead } from '#lib/server/inbound/consume';
import { findRecipient, INBOUND_SWEEP_BATCH, sweepInboundMail } from '#lib/server/inbound/repo';
import {
	ADDRESS_CHANGED_MEANWHILE,
	ADDRESS_NOT_FOUND,
	FORWARDING_NOT_CONFIGURED,
	SPACE_NOT_AVAILABLE
} from '#lib/server/inbound/messages';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { createSharedSpace } from '#lib/server/spaces/spaces';
import { base64urlEncode } from '#lib/shared/base64url';
import { RetryLaterError } from '#lib/shared/jobs';
import { handleEmail } from '../../workers/inbound/src/process';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { bytes, emailMessage, fixtureText } from '../helpers/mail';
import { messagesResponse } from '../helpers/receipts';
import { readZip, textOf } from '../helpers/zip';

// FN-19 /pengaturan/aplikasi/email, the jobs Worker's AI read (`inbound_read`) and the retention sweep, against
// a local D1. The AI answers are synthetic stubs passed as `fetchFn`: no test reaches the gateway or Anthropic,
// and a mocked read never counts as a verified capture (PRD criterion 21 stays NOT verified).

const DOMAIN = 'in.contoh.example';
const ENC = base64urlEncode(new Uint8Array(32).fill(9));
const GATEWAY = {
	AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
	AI_GATEWAY_ID: 'montra-test'
};
const binding: Record<string, string | D1Database | undefined> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/pengaturan/aplikasi/email/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());
beforeEach(() => {
	for (const k of Object.keys(binding)) delete binding[k];
	binding.DB = d1;
	binding.INBOUND_EMAIL_DOMAIN = DOMAIN;
});

let n = 0;
async function person() {
	const email = `teruskan${++n}@mail.example`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	return {
		user: { id: r.userId, email, name: 'Uji', createdAt: 0 },
		space: { id: space.id, kind: space.kind, name: space.name, role: space.role }
	};
}
type Person = Awaited<ReturnType<typeof person>>;

const ev = (who: Person | null, form?: Record<string, string>) =>
	fakeEvent({
		url: 'http://localhost/pengaturan/aplikasi/email',
		routeId: '/(app)/pengaturan/aplikasi/email',
		db,
		user: who?.user ?? null,
		space: who?.space ?? null,
		form
	}).event as never;

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail' as const,
				status: value.status,
				error: (value.data as unknown as { error: string }).error
			};
		return { kind: 'ok' as const, value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status };
		throw e;
	}
}
type Action = 'create' | 'rotate' | 'revoke' | 'target';
const act = (who: Person | null, name: Action, form: Record<string, string> = {}) =>
	run(() => (page.actions as Record<string, (e: never) => unknown>)[name]!(ev(who, form)));
interface LoadData {
	configured: boolean;
	address: {
		id: string;
		email: string;
		spaceId: string;
		spaceName: string | null;
		updatedAt: number;
	} | null;
	spaces: { id: string }[];
	mail: { status: string; confirmationCode: string | null; subject: string | null }[];
	loadError: string | null;
}
const load = async (who: Person) => (await page.load(ev(who) as never)) as unknown as LoadData;
const ref = (a: NonNullable<LoadData['address']>) => ({
	addressId: a.id,
	updatedAt: String(a.updatedAt)
});
const localOf = (email: string) => email.split('@')[0]!;

describe('/pengaturan/aplikasi/email: address lifecycle', () => {
	it('unconfigured: "Belum dikonfigurasi", nothing can be created', async () => {
		delete binding.INBOUND_EMAIL_DOMAIN;
		const p = await person();
		expect((await load(p)).configured).toBe(false);
		expect(await act(p, 'create', { spaceId: p.space.id })).toEqual({
			kind: 'fail',
			status: 503,
			error: FORWARDING_NOT_CONFIGURED
		});
		binding.INBOUND_EMAIL_DOMAIN = 'not a domain';
		expect((await load(p)).configured).toBe(false);
	});

	it('signed out: redirected to /masuk on load and every action', async () => {
		await expect(run(() => page.load(ev(null) as never))).resolves.toMatchObject({
			kind: 'redirect'
		});
		for (const a of ['create', 'rotate', 'revoke', 'target'] as const)
			expect((await act(null, a)).kind).toBe('redirect');
	});

	it('create: one active address m-<26>@domain that survives reload; 20 concurrent creates leave one', async () => {
		const p = await person();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => act(p, 'create', { spaceId: p.space.id }))
		);
		expect(results.filter((r) => r.kind === 'ok').length).toBe(1);
		const data = await load(p);
		expect(data.address?.email).toMatch(
			new RegExp(`^m-[0-9a-hjkmnp-tv-z]{26}@${DOMAIN.replaceAll('.', '\\.')}$`)
		);
		expect(data.address?.spaceId).toBe(p.space.id);
		expect((await load(p)).address?.email).toBe(data.address?.email);
		const rows = await db.all(
			sql`select 1 from inbound_addresses where user_id = ${p.user.id} and status = 'active'`
		);
		expect(rows.length).toBe(1);
	});

	it('rotate: the old address is refused at once, the new one accepted; a stale form is "changed meanwhile"', async () => {
		const p = await person();
		await act(p, 'create', { spaceId: p.space.id });
		const before = (await load(p)).address!;
		expect(await act(p, 'rotate', ref(before))).toEqual({ kind: 'ok', value: { done: 'rotated' } });
		const after = (await load(p)).address!;
		expect(after.email).not.toBe(before.email);
		expect(await findRecipient(db, localOf(before.email))).toBeNull();
		expect(await findRecipient(db, localOf(after.email))).toMatchObject({ userId: p.user.id });
		expect(await act(p, 'rotate', ref(before))).toMatchObject({
			status: 404,
			error: ADDRESS_NOT_FOUND
		});
		expect(
			await act(p, 'revoke', { addressId: after.id, updatedAt: String(after.updatedAt - 1) })
		).toEqual({
			kind: 'fail',
			status: 409,
			error: ADDRESS_CHANGED_MEANWHILE
		});
		expect(await act(p, 'revoke', ref(after))).toEqual({ kind: 'ok', value: { done: 'revoked' } });
		expect(await findRecipient(db, localOf(after.email))).toBeNull();
		expect((await load(p)).address).toBeNull();
	});

	it('another user’s address id answers exactly like a missing one and changes nothing', async () => {
		const a = await person();
		const b = await person();
		await act(a, 'create', { spaceId: a.space.id });
		const target = (await load(a)).address!;
		const missing = { addressId: crypto.randomUUID(), updatedAt: String(target.updatedAt) };
		for (const action of ['rotate', 'revoke'] as const) {
			const foreign = await act(b, action, ref(target));
			expect(foreign).toEqual(await act(b, action, missing));
			expect(foreign).toMatchObject({ status: 404, error: ADDRESS_NOT_FOUND });
		}
		expect(await act(b, 'target', { ...ref(target), spaceId: b.space.id })).toMatchObject({
			status: 404
		});
		expect((await load(a)).address).toEqual(target);
	});

	it('"Dicatat ke": only a space I am a live member of; a removed member’s address is refused', async () => {
		const owner = await person();
		const member = await person();
		const stranger = await person();
		const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		await db.run(sql`insert into space_members (id, space_id, user_id, role, created_at, updated_at)
			values (${crypto.randomUUID()}, ${shared}, ${member.user.id}, 'member', 0, 0)`);
		await act(member, 'create', { spaceId: member.space.id });
		const address = (await load(member)).address!;
		expect(await act(member, 'target', { ...ref(address), spaceId: stranger.space.id })).toEqual({
			kind: 'fail',
			status: 404,
			error: SPACE_NOT_AVAILABLE
		});
		expect(await act(member, 'target', { ...ref(address), spaceId: shared })).toEqual({
			kind: 'ok',
			value: { done: 'moved' }
		});
		const moved = (await load(member)).address!;
		expect(moved).toMatchObject({ spaceId: shared, spaceName: 'Keluarga' });
		expect(await findRecipient(db, localOf(moved.email))).toMatchObject({ spaceId: shared });
		await db.run(
			sql`update space_members set deleted_at = 1 where space_id = ${shared} and user_id = ${member.user.id}`
		);
		expect(await findRecipient(db, localOf(moved.email))).toBeNull();
		expect((await load(member)).address?.spaceName).toBeNull();
		// Creating into a space I do not belong to is refused the same way.
		const other = await person();
		expect(await act(other, 'create', { spaceId: shared })).toMatchObject({
			status: 404,
			error: SPACE_NOT_AVAILABLE
		});
	});
});

// ---- AI read (jobs Worker) ----

const answer = (o: Record<string, unknown>) =>
	JSON.stringify({
		is_payment: true,
		direction: 'expense',
		amount: 'Rp 125.500',
		currency: 'IDR',
		merchant: 'Toko Daring Contoh',
		date: '2026-10-08',
		time: '10:15',
		...o
	});

async function queuedMail(fixture = 'other/shop-invoice', withKey = true) {
	const p = await person();
	await act(p, 'create', { spaceId: p.space.id });
	const address = (await load(p)).address!;
	if (withKey)
		await saveKey(
			db,
			p.user.id,
			'anthropic',
			`sk-ant-api03-synthetic-${p.user.id.slice(0, 8)}-AbCd`,
			{ AI_KEYS_ENCRYPTION_KEY: ENC },
			Date.now()
		);
	const queue: { mailId: string }[] = [];
	const message = emailMessage(bytes(fixtureText(fixture, address.email)), address.email);
	const outcome = await handleEmail(message, {
		db,
		env: { INBOUND_EMAIL_DOMAIN: DOMAIN, ...GATEWAY },
		enqueue: async (m) => {
			if (m.type === 'inbound_read') queue.push(m);
		},
		now: () => Date.now()
	});
	return { p, outcome, mailId: queue[0]?.mailId ?? '' };
}
const env = () => ({ AI_KEYS_ENCRYPTION_KEY: ENC, ...GATEWAY });
const rowOf = (id: string) =>
	db.get<Record<string, unknown>>(sql`select * from inbound_mail where id = ${id}`);
const draftsOf = (spaceId: string) =>
	db.all<Record<string, unknown>>(sql`select * from drafts where space_id = ${spaceId}`);
const stub = (body: string) =>
	vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
		messagesResponse(body)
	) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('inbound_read: the AI read of a queued mail', () => {
	it('reads with the owner’s key through the gateway: a needs_review draft, text nulled in the same batch; idempotent', async () => {
		const { p, outcome, mailId } = await queuedMail();
		expect(outcome).toBe('queued');
		const fetchFn = stub(answer({}));
		expect(await processInboundRead(db, env(), mailId, 1, Date.now(), fetchFn)).toBe('read');
		const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			RequestInit
		];
		expect(url).toBe(
			'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/montra-test/anthropic/v1/messages'
		);
		const headers = init.headers as Record<string, string>;
		expect(headers['cf-aig-collect-log']).toBe('false');
		expect(headers['x-api-key']).toMatch(/^sk-ant-api03-synthetic-/);
		expect(JSON.parse(String(init.body)).model).toBe('claude-haiku-5-5');
		const [draft] = await draftsOf(p.space.id);
		expect(draft).toMatchObject({
			type: 'expense',
			amount_minor: 12_550_000,
			title: 'Toko Daring Contoh',
			occurred_on: '2026-10-08',
			source: 'gmail',
			flag: 'needs_review',
			wallet_id: null
		});
		expect(String(draft?.note)).toContain('Dibaca AI');
		expect(await rowOf(mailId)).toMatchObject({
			status: 'draft_created',
			parser: 'ai',
			pending_text: null
		});
		// A redelivered message acks without reading again.
		expect(await processInboundRead(db, env(), mailId, 2, Date.now(), fetchFn)).toBe('skipped');
		expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
		expect((await draftsOf(p.space.id)).length).toBe(1);
	});

	it('a provider outage is retried; on the last attempt the row ends ai_failed with its text deleted', async () => {
		const { mailId } = await queuedMail();
		const down = vi.fn(async () => {
			throw new TypeError('network');
		}) as unknown as typeof fetch;
		await expect(processInboundRead(db, env(), mailId, 1, Date.now(), down)).rejects.toBeInstanceOf(
			RetryLaterError
		);
		expect((await rowOf(mailId))?.status).toBe('queued');
		expect(await processInboundRead(db, env(), mailId, 3, Date.now(), down)).toBe('read');
		expect(await rowOf(mailId)).toMatchObject({
			status: 'unreadable',
			reason: 'ai_failed',
			pending_text: null
		});
	});

	it('invalid JSON or a figure not in the mail is ai_invalid; a prompt injection can only yield a printed amount', async () => {
		const bad = await queuedMail();
		await processInboundRead(db, env(), bad.mailId, 1, Date.now(), stub('{"oops":'));
		expect(await rowOf(bad.mailId)).toMatchObject({
			status: 'unreadable',
			reason: 'ai_invalid',
			pending_text: null
		});

		const absent = await queuedMail('other/prompt-injection');
		await processInboundRead(
			db,
			env(),
			absent.mailId,
			1,
			Date.now(),
			stub(answer({ amount: 'Rp 12.345' }))
		);
		expect(await rowOf(absent.mailId)).toMatchObject({ reason: 'ai_invalid' });
		expect(await draftsOf(absent.p.space.id)).toEqual([]);

		// The mail "asks" for Rp 99.000.000: a model that obeys can at most produce a flagged draft of a figure
		// the mail itself prints, never a saved transaction.
		const before = (await db.get<{ n: number }>(sql`select count(*) as n from transactions`))!.n;
		const obeyed = await queuedMail('other/prompt-injection');
		await processInboundRead(
			db,
			env(),
			obeyed.mailId,
			1,
			Date.now(),
			stub(answer({ amount: 'Rp 99.000.000', direction: 'income' }))
		);
		expect(await draftsOf(obeyed.p.space.id)).toMatchObject([
			{ type: 'income', amount_minor: 9_900_000_000, flag: 'needs_review', deleted_at: null }
		]);
		expect((await db.get<{ n: number }>(sql`select count(*) as n from transactions`))!.n).toBe(
			before
		);
	});

	it('not a payment keeps id and date only; another currency is unreadable/currency', async () => {
		const a = await queuedMail();
		await processInboundRead(
			db,
			env(),
			a.mailId,
			1,
			Date.now(),
			stub(answer({ is_payment: false }))
		);
		expect(await rowOf(a.mailId)).toMatchObject({
			status: 'not_payment',
			subject: null,
			sender_domain: null,
			parser: null,
			trust: null,
			pending_text: null
		});
		const b = await queuedMail();
		await processInboundRead(
			db,
			env(),
			b.mailId,
			1,
			Date.now(),
			stub(answer({ currency: 'USD', amount: '$12.50' }))
		);
		expect(await rowOf(b.mailId)).toMatchObject({ reason: 'currency', pending_text: null });
	});

	it('only the row owner’s key is ever opened; without one (or without the gateway) nothing is called', async () => {
		const owner = await queuedMail();
		// The owner's key is removed after queueing; another user still has one.
		await db.run(sql`delete from ai_keys where user_id = ${owner.p.user.id}`);
		await queuedMail();
		const fetchFn = stub(answer({}));
		await processInboundRead(db, env(), owner.mailId, 1, Date.now(), fetchFn);
		expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
		expect(await rowOf(owner.mailId)).toMatchObject({ reason: 'no_ai_key', pending_text: null });

		const noGateway = await queuedMail();
		await processInboundRead(
			db,
			{ AI_KEYS_ENCRYPTION_KEY: ENC },
			noGateway.mailId,
			1,
			Date.now(),
			fetchFn
		);
		expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
		expect(await rowOf(noGateway.mailId)).toMatchObject({
			reason: 'ai_unconfigured',
			pending_text: null
		});
	});
});

describe('retention sweep (jobs cron)', () => {
	it('expires 24 h text, re-sends 10-min-old reads, clears old codes, deletes 90-day rows, a bounded batch each', async () => {
		const p = await person();
		await act(p, 'create', { spaceId: p.space.id });
		const address = (await load(p)).address!;
		const now = Date.now();
		const HOUR = 60 * 60 * 1000;
		const row = (
			key: string,
			receivedAt: number,
			status: string,
			extra: { text?: string; code?: string } = {}
		) =>
			sql`(${crypto.randomUUID()}, ${p.space.id}, ${address.id}, ${p.user.id}, ${key.padEnd(32, '0')}, ${receivedAt},
				${status}, ${extra.text ?? null}, ${extra.code ?? null}, ${receivedAt})`;
		const insert = (rows: ReturnType<typeof sql>[]) =>
			db.run(sql`insert into inbound_mail (id, space_id, address_id, user_id, message_key, received_at, status,
				pending_text, confirmation_code, updated_at) values ${sql.join(rows, sql`, `)}`);
		await insert([
			row('aa', now - 25 * HOUR, 'queued', { text: 'Total Rp 5.000' }),
			row('bb', now - 15 * 60 * 1000, 'queued', { text: 'Total Rp 6.000' }),
			row('cc', now - 2 * 60 * 1000, 'queued', { text: 'Total Rp 7.000' }),
			row('dd', now - 25 * HOUR, 'confirmation', { code: '123456' }),
			row('ee', now - 1 * HOUR, 'confirmation', { code: '654321' })
		]);
		// 250 rows past the 90-day retention: more than one batch.
		const old = Array.from({ length: 250 }, (_, i) =>
			row(`f${String(i).padStart(3, '0')}`, now - 91 * 24 * HOUR, 'not_payment')
		);
		for (let i = 0; i < old.length; i += 9) await insert(old.slice(i, i + 9));

		const first = await sweepInboundMail(db, now);
		expect(first).toMatchObject({ expired: 1, codesCleared: 1, deleted: INBOUND_SWEEP_BATCH });
		const byKey = async (k: string) =>
			db.get<Record<string, unknown>>(
				sql`select * from inbound_mail where message_key = ${k.padEnd(32, '0')}`
			);
		expect(await byKey('aa')).toMatchObject({
			status: 'unreadable',
			reason: 'expired',
			pending_text: null
		});
		expect(first.requeue).toEqual([(await byKey('bb'))?.id]);
		expect((await byKey('cc'))?.status).toBe('queued');
		expect((await byKey('dd'))?.confirmation_code).toBeNull();
		expect((await byKey('ee'))?.confirmation_code).toBe('654321');
		expect((await sweepInboundMail(db, now)).deleted).toBe(50);
		expect((await sweepInboundMail(db, now)).deleted).toBe(0);
	});
});

describe('the user’s own data: shown, exported and deleted with the account', () => {
	it('a confirmation code is shown to its owner only', async () => {
		const a = await person();
		const b = await person();
		await act(a, 'create', { spaceId: a.space.id });
		const address = (await load(a)).address!;
		await handleEmail(
			emailMessage(bytes(fixtureText('other/gmail-confirmation', address.email)), address.email),
			{
				db,
				env: { INBOUND_EMAIL_DOMAIN: DOMAIN, INBOUND_AUTHSERV_ID: 'mx.inbound.example' },
				enqueue: async () => {},
				now: () => Date.now()
			}
		);
		expect((await load(a)).mail[0]).toMatchObject({
			status: 'confirmation',
			confirmationCode: '123456789'
		});
		expect((await load(b)).mail).toEqual([]);
	});

	it('red team L5: the export includes my address and ledger rows of a space I have left', async () => {
		const owner = await person();
		const member = await person();
		const shared = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		await db.run(sql`insert into space_members (id, space_id, user_id, role, created_at, updated_at)
			values (${crypto.randomUUID()}, ${shared}, ${member.user.id}, 'member', 0, 0)`);
		await act(member, 'create', { spaceId: shared });
		const address = (await load(member)).address!;
		await handleEmail(
			emailMessage(bytes(fixtureText('other/promo', address.email)), address.email),
			{
				db,
				env: { INBOUND_EMAIL_DOMAIN: DOMAIN },
				enqueue: async () => {},
				now: () => Date.now()
			}
		);
		await db.run(
			sql`update space_members set deleted_at = 1 where space_id = ${shared} and user_id = ${member.user.id}`
		);
		const r = await exportAccount(db, member.user.id);
		if (!r.ok) throw new Error('export failed');
		const files = readZip(new Uint8Array(await new Response(r.stream).arrayBuffer()));
		const file = (suffix: string) =>
			JSON.parse(
				textOf([...files.entries()].find(([name]) => name.endsWith(suffix))![1])
			) as Record<string, unknown>[];
		expect(file('inbound_addresses.json')).toMatchObject([{ id: address.id, status: 'active' }]);
		expect(file('inbound_mail.json')).toMatchObject([{ status: 'not_payment' }]);
		const account = JSON.parse(textOf(files.get('account.json')!));
		expect(account.notIncluded.map((x: { table: string }) => x.table)).not.toContain(
			'inbound_mail'
		);
	});

	it('the export holds the address row and ledger without the address, text or code; deletion removes both', async () => {
		const { p, mailId } = await queuedMail();
		expect(mailId).not.toBe('');
		const address = (await load(p)).address!;
		const r = await exportAccount(db, p.user.id);
		if (!r.ok) throw new Error('export failed');
		const files = readZip(new Uint8Array(await new Response(r.stream).arrayBuffer()));
		const names = [...files.keys()];
		expect(names.some((f) => f.endsWith('inbound_addresses.json'))).toBe(true);
		expect(names.some((f) => f.endsWith('inbound_mail.json'))).toBe(true);
		const all = [...files.values()].map(textOf).join('\n');
		expect(all).not.toContain(localOf(address.email));
		expect(all).not.toContain('Rp 125.500');
		const proof = await signInWithPassword(db, p.user.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof');
		expect(await deleteAccount(db, p.user.id, proof.hash)).toBe(true);
		for (const table of ['inbound_addresses', 'inbound_mail'])
			expect(
				await db.all(sql`select 1 from ${sql.identifier(table)} where user_id = ${p.user.id}`)
			).toEqual([]);
	});
});
