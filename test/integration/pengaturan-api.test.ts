import { isActionFailure, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	TOKEN_LIFETIME_INVALID,
	TOKEN_LIMIT,
	TOKEN_NAME_REQUIRED,
	TOKEN_NOT_FOUND,
	TOKEN_SCOPE_INVALID,
	TOKEN_SPACE_UNAVAILABLE
} from '#lib/server/api/messages';
import { signUp } from '#lib/server/auth/accounts';
import { INVALID_CREDENTIALS } from '#lib/server/auth/messages';
import { createApiToken, listApiTokens, resolveApiToken } from '#lib/server/auth/api-tokens';
import { changePassword } from '#lib/server/auth/change-password';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import { ACCOUNT_JSON_TABLES, exportRow, tablePages } from '#lib/server/export/tables';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, leaveSpace } from '#lib/server/spaces/spaces';
import { API_TOKEN_MAX_PER_USER, API_TOKEN_PATTERN } from '#lib/shared/api-tokens';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/pengaturan/api/+page.server');
const docs = await import('../../src/routes/(app)/pengaturan/api/dokumentasi/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function person() {
	const email = `token${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { id: r.userId, email, name: 'Uji', createdAt: 0, sessionToken: r.token };
}
type Person = Awaited<ReturnType<typeof person>>;

const ev = (who: Person | null, form?: Record<string, string>) =>
	fakeEvent({
		url: 'http://localhost/pengaturan/api',
		routeId: '/(app)/pengaturan/api',
		db,
		user: who,
		form,
		// A fresh client per request: the password re-proof counts per client (account-password budget).
		headers: {
			'cf-connecting-ip': `10.${Array.from(crypto.getRandomValues(new Uint8Array(3))).join('.')}`
		}
	}).event as never;

type Handler = (event: never) => unknown;
const act = async (who: Person, name: 'create' | 'revoke', form: Record<string, string>) =>
	(await (page.actions as Record<string, Handler>)[name]!(ev(who, form))) as
		| { created?: { token: string; name: string; expiresAt: number }; done?: string }
		| ReturnType<typeof import('@sveltejs/kit').fail>;
const load = async (who: Person) =>
	(await page.load(ev(who) as never)) as unknown as {
		tokens: { id: string; name: string; lastFour: string; scope: string; space: unknown }[];
		spaces: { id: string }[];
		loadError: string | null;
	};

const create = (who: Person, o: Record<string, string> = {}) =>
	act(who, 'create', {
		name: 'Skrip laporan',
		scope: 'read',
		space: '',
		lifetime: '90',
		password: PASSWORD,
		...o
	});

describe('/pengaturan/api (FN-38 criteria 1, 8, 25)', () => {
	it('shows the raw token once, and only its last four and metadata on reload (criterion 1)', async () => {
		const p = await person();
		const r = await create(p);
		if (isActionFailure(r) || !('created' in r) || !r.created) throw new Error('create failed');
		expect(r.created.token).toMatch(API_TOKEN_PATTERN);
		expect(r.created.expiresAt - Date.now()).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
		const data = await load(p);
		expect(data.tokens).toHaveLength(1);
		expect(data.tokens[0]).toMatchObject({
			name: 'Skrip laporan',
			scope: 'read',
			lastFour: r.created.token.slice(-4),
			space: null
		});
		const text = JSON.stringify(data);
		expect(text).not.toContain(r.created.token);
		const row = await db.get<{ token_hash: string }>(
			sql`select token_hash from api_tokens where user_id = ${p.id}`
		);
		expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(text).not.toContain(row!.token_hash);
		expect(row!.token_hash).not.toBe(r.created.token);
	});

	it('re-proves the current password before creating a token (red team L2)', async () => {
		const p = await person();
		for (const password of ['', 'salah-sekali-1', 'x'.repeat(2000)]) {
			const r = await create(p, { password });
			expect(isActionFailure(r)).toBe(true);
			expect((r as { status: number }).status).toBe(400);
			expect((r as { data: { error: string } }).data.error).toBe(INVALID_CREDENTIALS);
		}
		expect((await load(p)).tokens).toEqual([]);
		// A hash that is no longer the stored one (password changed meanwhile) writes nothing.
		const stale = await createApiToken(
			db,
			p.id,
			{ name: 'x', scope: 'read', restrictedSpaceId: null, lifetimeDays: 30 },
			'not-the-hash',
			Date.now()
		);
		expect(stale).toEqual({ ok: false, reason: 'credential' });
		expect(isActionFailure(await create(p))).toBe(false);
	});

	it('refuses bad fields with their own messages', async () => {
		const p = await person();
		const cases: [Record<string, string>, string][] = [
			[{ name: '  ​ ' }, TOKEN_NAME_REQUIRED],
			[{ scope: 'admin' }, TOKEN_SCOPE_INVALID],
			[{ lifetime: '0' }, TOKEN_LIFETIME_INVALID],
			[{ lifetime: '3650' }, TOKEN_LIFETIME_INVALID],
			[{ space: 'x'.repeat(65) }, TOKEN_SPACE_UNAVAILABLE]
		];
		for (const [o, message] of cases) {
			const r = await create(p, o);
			expect(isActionFailure(r)).toBe(true);
			expect((r as { data: { error: string } }).data.error).toBe(message);
		}
		expect((await load(p)).tokens).toEqual([]);
	});

	it('refuses a space the user is not (or no longer) a live member of', async () => {
		const owner = await person();
		const member = await person();
		const spaceId = (await createSharedSpace(db, owner.id, 'Keluarga', Date.now()))!;
		expect(isActionFailure(await create(member, { space: spaceId }))).toBe(true);
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.id, Date.now());
		const ok = await create(member, { space: spaceId, scope: 'read_write' });
		expect(isActionFailure(ok)).toBe(false);
		await leaveSpace(db, { spaceId, userId: member.id }, Date.now());
		const after = await create(member, { space: spaceId });
		expect((after as { data: { error: string } }).data.error).toBe(TOKEN_SPACE_UNAVAILABLE);
		// The token made while a member stays listed, its space no longer named.
		expect((await load(member)).tokens[0]!.space).toEqual({ id: spaceId, name: null, kind: null });
	});

	it('holds the cap of 10 live tokens exactly, also under 20 concurrent creates (criterion 8)', async () => {
		const p = await person();
		const hash = (await db.get<{ hash: string }>(
			sql`select hash from user_passwords where user_id = ${p.id}`
		))!.hash;
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				createApiToken(
					db,
					p.id,
					{ name: 'Paralel', scope: 'read', restrictedSpaceId: null, lifetimeDays: 30 },
					hash,
					Date.now()
				)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(API_TOKEN_MAX_PER_USER);
		expect(results.filter((r) => !r.ok && r.reason === 'limit')).toHaveLength(10);
		const refused = await create(p);
		expect(isActionFailure(refused)).toBe(true);
		expect((refused as { status: number; data: { error: string } }).status).toBe(409);
		expect((refused as { data: { error: string } }).data.error).toBe(TOKEN_LIMIT);
		const tokens = (await load(p)).tokens;
		expect(tokens).toHaveLength(10);
		// Revoking one frees one place.
		expect(await act(p, 'revoke', { tokenId: tokens[0]!.id })).toEqual({ done: 'revoked' });
		expect(isActionFailure(await create(p))).toBe(false);
	});

	it('revokes only the user’s own live token; the revoked token stops working (criterion 7)', async () => {
		const a = await person();
		const b = await person();
		const r = await create(a);
		if (isActionFailure(r) || !('created' in r) || !r.created) throw new Error('create failed');
		const id = (await load(a)).tokens[0]!.id;
		const theirs = await act(b, 'revoke', { tokenId: id });
		expect((theirs as { data: { error: string } }).data.error).toBe(TOKEN_NOT_FOUND);
		expect(await resolveApiToken(db, r.created.token, Date.now())).not.toBeNull();
		expect(await act(a, 'revoke', { tokenId: id })).toEqual({ done: 'revoked' });
		expect(await resolveApiToken(db, r.created.token, Date.now())).toBeNull();
		expect((await load(a)).tokens).toEqual([]);
		expect(isActionFailure(await act(a, 'revoke', { tokenId: id }))).toBe(true);
	});

	it('sends a signed-out request to /masuk', async () => {
		let redirected = false;
		try {
			await page.load(ev(null) as never);
		} catch (e) {
			redirected = isRedirect(e);
		}
		expect(redirected).toBe(true);
	});

	it('renders the reference from the same document in the reader’s language', async () => {
		const p = await person();
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/api/dokumentasi',
			routeId: '/(app)/pengaturan/api/dokumentasi',
			db,
			user: p
		});
		const data = (await docs.load(event as never)) as unknown as {
			reference: { endpoints: { id: string; summary: string }[] };
		};
		expect(data.reference.endpoints.map((e) => e.id)).toContain('createTransaction');
		expect(data.reference.endpoints.find((e) => e.id === 'listSpaces')!.summary).toBe(
			'Daftar ruang tempat kamu menjadi anggota.'
		);
	});
});

describe('changing the password revokes every API token (cycle 1b, owner-safety default)', () => {
	it('revokes all of the user’s tokens with the change; other users’ tokens stay', async () => {
		const p = await person();
		const other = await person();
		const mine = [await create(p), await create(p, { scope: 'read_write' })];
		const theirs = await create(other);
		const raw = (r: Awaited<ReturnType<typeof create>>) =>
			(r as { created: { token: string } }).created.token;
		const proof = await signInWithPassword(db, p.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof failed');
		expect(
			await changePassword(
				db,
				p.id,
				proof.hash,
				p.sessionToken,
				'sandi-baru-2026-x',
				null,
				Date.now()
			)
		).toBe(true);
		for (const r of mine) expect(await resolveApiToken(db, raw(r), Date.now())).toBeNull();
		expect((await load(p)).tokens).toEqual([]);
		expect(await resolveApiToken(db, raw(theirs), Date.now())).not.toBeNull();
	});

	it('a refused change (stale proof) revokes nothing', async () => {
		const p = await person();
		const r = await create(p);
		expect(
			await changePassword(
				db,
				p.id,
				'not-the-hash',
				p.sessionToken,
				'sandi-baru-2026-x',
				null,
				Date.now()
			)
		).toBe(false);
		expect(
			await resolveApiToken(db, (r as { created: { token: string } }).created.token, Date.now())
		).not.toBeNull();
	});
});

describe('account export and deletion cover api_tokens', () => {
	it('exports token metadata without the hash', async () => {
		const p = await person();
		await create(p);
		const plan = ACCOUNT_JSON_TABLES.find((t) => t.table === 'api_tokens')!;
		expect(plan.columns.map((c) => c.name)).not.toContain('token_hash');
		const pages = [];
		for await (const rows of tablePages(db, plan, { kind: 'account', userId: p.id }))
			pages.push(...rows.map((r) => exportRow(plan, r)));
		expect(pages).toHaveLength(1);
		expect(pages[0]).toMatchObject({
			name: 'Skrip laporan',
			scope: 'read',
			restrictedSpaceId: null
		});
		expect(Object.keys(pages[0]!)).not.toContain('tokenHash');
	});

	it('deletes every token with the account, and a restricted token with its space', async () => {
		const p = await person();
		const personal = (await resolveCurrentSpace(db, p.id, undefined))!.id;
		await create(p);
		await create(p, { space: personal });
		const proof = await signInWithPassword(db, p.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, p.id, proof.hash)).toBe(true);
		expect(await listApiTokens(db, p.id, Date.now())).toEqual([]);
		const left = await db.get<{ n: number }>(
			sql`select count(*) as n from api_tokens where user_id = ${p.id} or restricted_space_id = ${personal}`
		);
		expect(left!.n).toBe(0);
	});
});
