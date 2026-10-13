import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { decryptToken, type SealedToken } from '#lib/server/connected-apps/crypto';
import {
	ALREADY_CONNECTED,
	CONNECTED_APPS_LOAD_FAILED,
	CONNECTED_APPS_NOT_CONFIGURED,
	CONNECTION_NOT_FOUND,
	DISCONNECT_NOT_ALLOWED,
	PROVIDER_INVALID
} from '#lib/server/connected-apps/messages';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import {
	createSharedSpace,
	leaveSpace,
	listMembers,
	removeMember
} from '#lib/server/spaces/spaces';
import type { AppRow, ConnectedAppProvider } from '#lib/shared/connected-apps/providers';
import { parseSlackMessage } from '#lib/shared/connected-apps/slack-draft-parse';
import { base64urlEncode } from '#lib/shared/base64url';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const KEY = base64urlEncode(new Uint8Array(32).fill(7));
const OTHER_KEY = base64urlEncode(new Uint8Array(32).fill(8));
const binding: {
	DB?: D1Database;
	DEV_ROUTES?: string;
	CONNECTED_APPS_ENCRYPTION_KEY?: string;
	CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS?: string;
} = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
// A deployed build: `vite dev` is off, so only DEV_ROUTES=1 opens the dev seed actions.
vi.mock('$app/env', () => ({ dev: false }));

const page = await import('../../src/routes/(app)/pengaturan/aplikasi/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOT_FOUND = { kind: 'error', status: 404, body: { message: 'Not found', status: 404 } };

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

/** Each test sets the env it needs; the default is a dev build with a configured key. */
function configure(opts: { key?: string | undefined; dev?: boolean } = {}) {
	binding.CONNECTED_APPS_ENCRYPTION_KEY = 'key' in opts ? opts.key : KEY;
	binding.CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS = undefined;
	binding.DEV_ROUTES = opts.dev === false ? undefined : '1';
}

type Handler = (event: never) => unknown;

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail' as const,
				status: value.status,
				data: value.data as unknown as Record<string, unknown>
			};
		return { kind: 'ok' as const, value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

let n = 0;
async function person(name = 'Uji') {
	const email = `aplikasi${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	return { user: { id: r.userId, email, name, createdAt: 0 }, spaceId: space.id };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An event as `who` in the space the cookie names (else their personal one); `space` forges locals.space. */
async function ev(
	who: Person | null,
	opts: { path?: string; form?: Record<string, string>; spaceCookie?: string; space?: string }
) {
	let space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	if (opts.space) space = { id: opts.space, kind: 'shared', name: 'x', role: 'member' };
	return fakeEvent({
		url: `http://localhost${opts.path ?? '/pengaturan/aplikasi'}`,
		routeId: '/(app)/pengaturan/aplikasi',
		db,
		user: who?.user ?? null,
		space,
		form: opts.form
	}).event as never;
}

const load = (
	who: Person | null,
	opts: { path?: string; spaceCookie?: string; space?: string } = {}
) => run(async () => page.load(await ev(who, opts)));
const act = (
	who: Person,
	name: string,
	form: Record<string, string>,
	opts: { spaceCookie?: string; space?: string } = {}
) =>
	run(async () =>
		(page.actions as Record<string, Handler>)[name]!(await ev(who, { form, ...opts }))
	);

interface Loaded {
	configured: boolean;
	devTools: boolean;
	open: ConnectedAppProvider | null;
	apps: AppRow[];
	loadError: string | null;
}
async function loaded(who: Person, spaceCookie?: string): Promise<Loaded> {
	const r = await load(who, { spaceCookie });
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value as unknown as Loaded;
}
const appOf = (l: Loaded, provider: ConnectedAppProvider) =>
	l.apps.find((a) => a.provider === provider)!;

const seed = (who: Person, provider: ConnectedAppProvider, opts: { spaceCookie?: string } = {}) =>
	act(who, 'seedDemoConnectedApp', { provider }, opts);

interface StoredRow {
	id: string;
	space_id: string;
	provider: ConnectedAppProvider;
	status: string;
	external_label: string | null;
	encrypted_token: string | null;
	token_nonce: string | null;
	token_key_id: string | null;
	scope: string | null;
	is_demo: number;
	created_by_user_id: string | null;
	deleted_at: number | null;
}
async function rows(spaceId: string): Promise<StoredRow[]> {
	return (
		await d1
			.prepare('select * from connected_apps where space_id = ? order by created_at, provider')
			.bind(spaceId)
			.all<StoredRow>()
	).results;
}
async function audit(spaceId: string) {
	return (
		await d1
			.prepare(
				`select action, actor_user_id, target_user_id from audit_events
				where space_id = ? and action in ('app_connected', 'app_disconnected', 'app_auto_disconnected') order by created_at`
			)
			.bind(spaceId)
			.all<{ action: string; actor_user_id: string | null; target_user_id: string | null }>()
	).results;
}
const sealedOf = (r: StoredRow): SealedToken => ({
	ciphertext: r.encrypted_token!,
	nonce: r.token_nonce!,
	keyId: r.token_key_id!
});
const bindingOf = (r: StoredRow) => ({ rowId: r.id, spaceId: r.space_id, provider: r.provider });

describe('the screen without a key (production today)', () => {
	it('lists all five apps as "Belum dikonfigurasi", nothing connected (AC1, AC3, AC12)', async () => {
		configure({ key: undefined, dev: false });
		const a = await person();
		const l = await loaded(a);
		expect(l.configured).toBe(false);
		expect(l.devTools).toBe(false);
		expect(l.loadError).toBeNull();
		expect(l.apps.map((x) => [x.provider, x.state, x.connection])).toEqual([
			['gmail', 'not_configured', null],
			['google_sheets', 'not_configured', null],
			['google_calendar', 'not_configured', null],
			['notion', 'not_configured', null],
			['slack', 'not_configured', null]
		]);
	});

	it('the dev seed answers "Belum dikonfigurasi" (503) and writes nothing', async () => {
		configure({ key: undefined });
		const a = await person();
		expect(await seed(a, 'notion')).toEqual({
			kind: 'fail',
			status: 503,
			data: { error: CONNECTED_APPS_NOT_CONFIGURED }
		});
		configure({ key: 'not-a-32-byte-key' });
		expect(await seed(a, 'notion')).toMatchObject({ kind: 'fail', status: 503 });
		expect(await rows(a.spaceId)).toEqual([]);
		expect(await audit(a.spaceId)).toEqual([]);
	});

	it('the dev actions are 404 unless DEV_ROUTES is on', async () => {
		configure({ dev: false });
		const a = await person();
		for (const name of ['seedDemoConnectedApp', 'clearDemoConnectedApps'])
			expect(await act(a, name, { provider: 'notion' })).toEqual(NOT_FOUND);
		expect(await rows(a.spaceId)).toEqual([]);
	});

	it('`?app=<provider>` opens a detail without JavaScript; anything else opens nothing', async () => {
		configure({ key: undefined });
		const a = await person();
		const open = async (q: string) =>
			((await load(a, { path: `/pengaturan/aplikasi${q}` })) as unknown as { value: Loaded }).value
				.open;
		expect(await open('?app=slack')).toBe('slack');
		expect(await open('?app=__proto__')).toBeNull();
		expect(await open('?app=')).toBeNull();
		expect(await open('')).toBeNull();
	});

	it('a load failure shows the error state, never a crash', async () => {
		configure();
		const a = await person();
		// The access check (a select) passes; the connections query (a raw `all`) fails.
		const failing = new Proxy(db, {
			get(target, prop) {
				if (prop === 'all')
					return () => {
						throw new Error('D1_ERROR: boom secret-token');
					};
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const space = (await resolveCurrentSpace(db, a.user.id, undefined))!;
		const event = fakeEvent({
			url: 'http://localhost/pengaturan/aplikasi',
			db: failing as Db,
			user: a.user,
			space
		}).event;
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const r = await run(() => page.load(event as never));
		expect(r.kind).toBe('ok');
		const l = (r as { value: unknown }).value as Loaded;
		expect(l.loadError).toBe(CONNECTED_APPS_LOAD_FAILED);
		expect(l.apps.every((x) => x.state === 'not_configured' && x.connection === null)).toBe(true);
		// The log names the error class only, never its message.
		expect(JSON.stringify(logged.mock.calls)).not.toContain('secret-token');
		logged.mockRestore();
	});
});

describe('seed, encryption at rest and disconnect (configured key, dev seed)', () => {
	it('a seeded connection is shown connected and "Data demo", with one audit row (AC4)', async () => {
		configure();
		const a = await person();
		expect(await seed(a, 'google_sheets')).toEqual({ kind: 'ok', value: { done: 'seeded' } });
		const l = await loaded(a);
		const sheets = appOf(l, 'google_sheets');
		expect(sheets.state).toBe('connected');
		expect(sheets.connection).toMatchObject({ externalLabel: 'contoh.id', isDemo: true });
		expect(l.apps.filter((x) => x.state === 'connected')).toHaveLength(1);
		const [row] = await rows(a.spaceId);
		expect(row).toMatchObject({
			status: 'connected',
			is_demo: 1,
			created_by_user_id: a.user.id,
			scope: null,
			deleted_at: null
		});
		expect(await audit(a.spaceId)).toEqual([
			{ action: 'app_connected', actor_user_id: a.user.id, target_user_id: null }
		]);
	});

	it('the token is stored only as ciphertext, opens for its own row only, and never reaches page data', async () => {
		configure();
		const a = await person();
		await seed(a, 'google_sheets');
		await seed(a, 'notion');
		const [sheets, notion] = await rows(a.spaceId);
		const token = await decryptToken(binding, sealedOf(sheets!), bindingOf(sheets!));
		expect(token).toMatch(/^demo-token-[0-9a-f-]{36}$/);
		expect(sheets!.encrypted_token).not.toContain('demo-token');
		// Probe: a ciphertext swapped between two rows (or moved to another space) fails closed.
		expect(await decryptToken(binding, sealedOf(sheets!), bindingOf(notion!))).toBeNull();
		expect(await decryptToken(binding, sealedOf(notion!), bindingOf(sheets!))).toBeNull();
		expect(
			await decryptToken(binding, sealedOf(sheets!), { ...bindingOf(sheets!), spaceId: 'other' })
		).toBeNull();
		// Probe: a wrong key fails closed.
		expect(
			await decryptToken(
				{ CONNECTED_APPS_ENCRYPTION_KEY: OTHER_KEY },
				sealedOf(sheets!),
				bindingOf(sheets!)
			)
		).toBeNull();
		// Probe: no token material in the page data.
		const data = JSON.stringify(await loaded(a));
		for (const secret of [
			token!,
			sheets!.encrypted_token!,
			sheets!.token_nonce!,
			sheets!.token_key_id!,
			notion!.encrypted_token!
		])
			expect(data).not.toContain(secret);
		expect(data).not.toMatch(/encrypted|nonce|keyId|token/i);
	});

	it('a ciphertext copied into another row by SQL does not open there', async () => {
		configure();
		const a = await person();
		const b = await person();
		await seed(a, 'slack');
		await seed(b, 'slack');
		const [ra] = await rows(a.spaceId);
		const [rb] = await rows(b.spaceId);
		await d1
			.prepare(
				'update connected_apps set encrypted_token = ?, token_nonce = ?, token_key_id = ? where id = ?'
			)
			.bind(ra!.encrypted_token, ra!.token_nonce, ra!.token_key_id, rb!.id)
			.run();
		const [moved] = await rows(b.spaceId);
		expect(await decryptToken(binding, sealedOf(moved!), bindingOf(moved!))).toBeNull();
		expect(await decryptToken(binding, sealedOf(ra!), bindingOf(ra!))).not.toBeNull();
	});

	it('disconnect leaves a content-free tombstone plus one audit row; the app reads "Belum dikonfigurasi" again (AC4, AC5)', async () => {
		configure();
		const a = await person();
		await seed(a, 'google_calendar');
		const [row] = await rows(a.spaceId);
		expect(await act(a, 'disconnect', { connectionId: row!.id })).toEqual({
			kind: 'ok',
			value: { done: 'disconnected' }
		});
		const [tomb] = await rows(a.spaceId);
		expect(tomb).toMatchObject({
			id: row!.id,
			status: 'disconnected',
			external_label: null,
			encrypted_token: null,
			token_nonce: null,
			token_key_id: null,
			scope: null
		});
		expect(tomb!.deleted_at).not.toBeNull();
		expect((await audit(a.spaceId)).map((e) => e.action)).toEqual([
			'app_connected',
			'app_disconnected'
		]);
		const cal = appOf(await loaded(a), 'google_calendar');
		expect(cal).toEqual({ provider: 'google_calendar', state: 'not_configured', connection: null });
		// A second disconnect of the same row: missing, and no second audit row.
		expect(await act(a, 'disconnect', { connectionId: row!.id })).toEqual({
			kind: 'fail',
			status: 404,
			data: { error: CONNECTION_NOT_FOUND }
		});
		expect(await audit(a.spaceId)).toHaveLength(2);
		// It can be seeded again (a new row; the tombstone stays).
		expect(await seed(a, 'google_calendar')).toMatchObject({ kind: 'ok' });
		expect(await rows(a.spaceId)).toHaveLength(2);
	});

	it('the table refuses a tombstone that keeps content, and a live row without a well-formed seal', async () => {
		configure();
		const a = await person();
		await seed(a, 'notion');
		const [row] = await rows(a.spaceId);
		await expect(
			d1
				.prepare(
					"update connected_apps set deleted_at = 1, status = 'disconnected', external_label = null, scope = null where id = ?"
				)
				.bind(row!.id)
				.run()
		).rejects.toThrow(/CHECK constraint failed/);
		await expect(
			d1.prepare('update connected_apps set token_nonce = null where id = ?').bind(row!.id).run()
		).rejects.toThrow(/CHECK constraint failed/);
		await expect(
			d1.prepare("update connected_apps set provider = 'dropbox' where id = ?").bind(row!.id).run()
		).rejects.toThrow(/CHECK constraint failed/);
		await expect(
			d1
				.prepare("update connected_apps set status = 'disconnected' where id = ?")
				.bind(row!.id)
				.run()
		).rejects.toThrow(/CHECK constraint failed/);
	});

	it('with the key removed later, a stored connection reads "Belum dikonfigurasi" but can still be disconnected (AC3)', async () => {
		configure();
		const a = await person();
		await seed(a, 'slack');
		configure({ key: undefined });
		const l = await loaded(a);
		const slack = appOf(l, 'slack');
		expect(l.configured).toBe(false);
		expect(slack.state).toBe('not_configured');
		expect(l.apps.every((x) => x.state === 'not_configured')).toBe(true);
		expect(await act(a, 'disconnect', { connectionId: slack.connection!.id })).toMatchObject({
			kind: 'ok'
		});
		expect((await rows(a.spaceId))[0]!.encrypted_token).toBeNull();
	});

	it('a second seed of the same app is refused; 20 concurrent seeds leave exactly one row and one audit row', async () => {
		configure();
		const a = await person();
		await seed(a, 'gmail');
		expect(await seed(a, 'gmail')).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: ALREADY_CONNECTED }
		});
		const b = await person();
		const results = await Promise.all(Array.from({ length: 20 }, () => seed(b, 'notion')));
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
		expect(results.filter((r) => r.kind === 'fail' && r.status === 409)).toHaveLength(19);
		expect(await rows(b.spaceId)).toHaveLength(1);
		expect(await audit(b.spaceId)).toHaveLength(1);
	});

	it('20 concurrent disconnects of one row: one succeeds, one audit row', async () => {
		configure();
		const a = await person();
		await seed(a, 'notion');
		const [row] = await rows(a.spaceId);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => act(a, 'disconnect', { connectionId: row!.id }))
		);
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
		expect((await audit(a.spaceId)).filter((e) => e.action === 'app_disconnected')).toHaveLength(1);
	});

	it('refuses an unknown provider; clear removes every demo connection with one audit row each', async () => {
		configure();
		const a = await person();
		expect(await seed(a, 'dropbox' as ConnectedAppProvider)).toEqual({
			kind: 'fail',
			status: 400,
			data: { error: PROVIDER_INVALID }
		});
		for (const p of ['gmail', 'slack', 'notion'] as const) await seed(a, p);
		expect(await act(a, 'clearDemoConnectedApps', {})).toEqual({
			kind: 'ok',
			value: { done: 'cleared', count: 3 }
		});
		expect(
			(await rows(a.spaceId)).every((r) => r.deleted_at !== null && r.encrypted_token === null)
		).toBe(true);
		const actions = (await audit(a.spaceId)).map((e) => e.action);
		expect(actions.filter((x) => x === 'app_connected')).toHaveLength(3);
		expect(actions.filter((x) => x === 'app_disconnected')).toHaveLength(3);
		expect(await act(a, 'clearDemoConnectedApps', {})).toMatchObject({ value: { count: 0 } });
	});
});

describe('one access rule (AC2)', () => {
	async function shared() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		await seed(owner, 'google_sheets', { spaceCookie: spaceId });
		const [row] = await rows(spaceId);
		return { owner, member, spaceId, row: row! };
	}

	it('red team L3: only the connection’s creator or the Pemilik may disconnect; the page says who may', async () => {
		configure();
		const { owner, member, spaceId, row } = await shared();
		// The owner's connection: the member sees it, may not disconnect it (403, nothing written).
		const seen = appOf(await loaded(member, spaceId), 'google_sheets').connection;
		expect(seen).toMatchObject({ id: row.id, canDisconnect: false });
		const before = JSON.stringify([await rows(spaceId), await audit(spaceId)]);
		expect(
			await act(member, 'disconnect', { connectionId: row.id }, { spaceCookie: spaceId })
		).toEqual({ kind: 'fail', status: 403, data: { error: DISCONNECT_NOT_ALLOWED } });
		expect(JSON.stringify([await rows(spaceId), await audit(spaceId)])).toBe(before);
		// The member's own connection: they and the owner may disconnect it.
		await seed(member, 'notion', { spaceCookie: spaceId });
		const notionOf = async (who: Person) => appOf(await loaded(who, spaceId), 'notion').connection!;
		expect((await notionOf(member)).canDisconnect).toBe(true);
		expect((await notionOf(owner)).canDisconnect).toBe(true);
		expect(appOf(await loaded(owner, spaceId), 'google_sheets').connection?.canDisconnect).toBe(
			true
		);
		expect(
			await act(
				member,
				'disconnect',
				{ connectionId: (await notionOf(member)).id },
				{ spaceCookie: spaceId }
			)
		).toMatchObject({ kind: 'ok' });
		await seed(member, 'notion', { spaceCookie: spaceId });
		expect(
			await act(
				owner,
				'disconnect',
				{ connectionId: (await notionOf(owner)).id },
				{ spaceCookie: spaceId }
			)
		).toMatchObject({ kind: 'ok' });
		expect(
			await act(owner, 'disconnect', { connectionId: row.id }, { spaceCookie: spaceId })
		).toMatchObject({ kind: 'ok' });
		expect((await audit(spaceId)).filter((e) => e.action === 'app_disconnected')).toEqual([
			{ action: 'app_disconnected', actor_user_id: member.user.id, target_user_id: null },
			{ action: 'app_disconnected', actor_user_id: owner.user.id, target_user_id: null },
			{ action: 'app_disconnected', actor_user_id: owner.user.id, target_user_id: null }
		]);
		// In a personal space the user is the Pemilik.
		const solo = await person();
		await seed(solo, 'slack');
		expect(appOf(await loaded(solo), 'slack').connection?.canDisconnect).toBe(true);
	});

	it('a non-member and a removed member get 404 on the load and every action; nothing changes (cross-space probe)', async () => {
		configure();
		const { owner, member, spaceId, row } = await shared();
		const stranger = await person();
		const m = (await listMembers(db, spaceId, owner.user.id)).find((x) => !x.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: m.id }, Date.now());
		const snapshot = async () => JSON.stringify([await rows(spaceId), await audit(spaceId)]);
		const before = await snapshot();
		for (const who of [stranger, member]) {
			expect(await load(who, { space: spaceId })).toEqual(NOT_FOUND);
			for (const [name, body] of [
				['disconnect', { connectionId: row.id }],
				['seedDemoConnectedApp', { provider: 'slack' }],
				['clearDemoConnectedApps', {}]
			] as const)
				expect(await act(who, name, body, { space: spaceId })).toEqual(NOT_FOUND);
			// In their own space, the shared space's connection id is simply unknown: the same answer as a
			// made-up id or an over-long one (no existence oracle).
			const answers = await Promise.all(
				[row.id, crypto.randomUUID(), 'x'.repeat(5000), ''].map((connectionId) =>
					act(who, 'disconnect', { connectionId }, { spaceCookie: spaceId })
				)
			);
			for (const answer of answers)
				expect(answer).toEqual({
					kind: 'fail',
					status: 404,
					data: { error: CONNECTION_NOT_FOUND }
				});
			expect((await loaded(who, spaceId)).apps.every((x) => x.connection === null)).toBe(true);
		}
		expect(await snapshot()).toBe(before);
	});

	it('signed out: the load and actions redirect to sign in', async () => {
		configure();
		expect(await load(null)).toMatchObject({ kind: 'redirect', status: 303, location: '/masuk' });
		const event = await ev(null, { form: { connectionId: 'x' } });
		expect(
			await run(() => (page.actions as Record<string, Handler>).disconnect!(event))
		).toMatchObject({ kind: 'redirect', location: '/masuk' });
	});
});

describe('red team L2: a person’s connection ends with their membership', () => {
	async function sharedWithConnections() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Rumah', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		await seed(owner, 'notion', { spaceCookie: spaceId });
		await seed(member, 'slack', { spaceCookie: spaceId });
		await seed(member, 'gmail');
		return { owner, member, spaceId };
	}
	const live = async (spaceId: string) =>
		(await rows(spaceId)).filter((r) => r.deleted_at === null).map((r) => r.provider);
	async function expectAutoDisconnected(
		spaceId: string,
		provider: ConnectedAppProvider,
		who: string | null
	) {
		const row = (await rows(spaceId)).find((r) => r.provider === provider)!;
		expect(row).toMatchObject({
			status: 'disconnected',
			external_label: null,
			encrypted_token: null,
			token_nonce: null,
			token_key_id: null,
			scope: null
		});
		expect(row.deleted_at).not.toBeNull();
		// Stamped with the space's freshly advanced change counter (the newest seq of the space).
		const { seq } = (await d1
			.prepare('select seq from space_seq where space_id = ?')
			.bind(spaceId)
			.first<{ seq: number }>())!;
		expect((row as unknown as { seq: number }).seq).toBe(seq);
		expect((await audit(spaceId)).filter((e) => e.action === 'app_auto_disconnected')).toEqual([
			{ action: 'app_auto_disconnected', actor_user_id: null, target_user_id: who }
		]);
	}

	it('removal: the removed member’s connections in that space are tombstoned with one audit row each', async () => {
		configure();
		const { owner, member, spaceId } = await sharedWithConnections();
		const m = (await listMembers(db, spaceId, owner.user.id)).find((x) => !x.isYou)!;
		expect(
			await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: m.id }, Date.now())
		).toBe('removed');
		await expectAutoDisconnected(spaceId, 'slack', member.user.id);
		expect(await live(spaceId)).toEqual(['notion']);
		// Their own personal space is not touched by leaving a shared one.
		expect(await live(member.spaceId)).toEqual(['gmail']);
	});

	it('leaving: the leaver’s connections in that space are tombstoned; the owner’s stay', async () => {
		configure();
		const { member, spaceId } = await sharedWithConnections();
		expect(await leaveSpace(db, { spaceId, userId: member.user.id }, Date.now())).toBe(true);
		await expectAutoDisconnected(spaceId, 'slack', member.user.id);
		expect(await live(spaceId)).toEqual(['notion']);
	});

	it('a refused removal or leave changes no connection', async () => {
		configure();
		const { owner, member, spaceId } = await sharedWithConnections();
		const stranger = await person();
		const m = (await listMembers(db, spaceId, owner.user.id)).find((x) => !x.isYou)!;
		// Not the owner: refused, nothing changes.
		expect(
			await removeMember(db, { spaceId, actorUserId: stranger.user.id, memberId: m.id }, Date.now())
		).toBe('gone');
		// The owner cannot "leave" (owner role): refused.
		expect(await leaveSpace(db, { spaceId, userId: owner.user.id }, Date.now())).toBe(false);
		expect(await live(spaceId)).toEqual(['notion', 'slack']);
		expect((await audit(spaceId)).some((e) => e.action === 'app_auto_disconnected')).toBe(false);
		void member;
	});

	it('account deletion: personal space purged; their connections in a surviving shared space tombstoned (AC10)', async () => {
		configure();
		const { owner, member, spaceId } = await sharedWithConnections();
		const proof = await signInWithPassword(db, member.user.email, PASSWORD, 1);
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, member.user.id, proof.hash)).toBe(true);
		expect(await rows(member.spaceId)).toEqual([]);
		// The target user reference is nulled with the user row; the event stays.
		await expectAutoDisconnected(spaceId, 'slack', null);
		expect(await live(spaceId)).toEqual(['notion']);
		expect(appOf(await loaded(owner, spaceId), 'notion').state).toBe('connected');
		expect(appOf(await loaded(owner, spaceId), 'slack').connection).toBeNull();
	});

	it('the owner deleting their account: their shared-space connection ends, the space survives for the heir', async () => {
		configure();
		const { owner, member, spaceId } = await sharedWithConnections();
		const proof = await signInWithPassword(db, owner.user.email, PASSWORD, 1);
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, owner.user.id, proof.hash)).toBe(true);
		expect(await live(spaceId)).toEqual(['slack']);
		expect(appOf(await loaded(member, spaceId), 'slack').state).toBe('connected');
		expect(appOf(await loaded(member, spaceId), 'notion').connection).toBeNull();
	});
});

describe('Slack drafts fit the FN-11 drafts table', () => {
	it('parser output inserts as slack drafts, and a redelivered message never creates a second row', async () => {
		const a = await person();
		const message = {
			text: 'kopi 25rb dan parkir goceng',
			teamId: 'T0123',
			channelId: 'C0456',
			ts: '1793467800.000100'
		};
		const insert = async () => {
			const drafts = parseSlackMessage(message, { wallets: [] })!;
			return d1.batch(
				drafts.map((d) =>
					d1
						.prepare(
							`insert or ignore into drafts (id, space_id, type, amount_minor, currency, title, wallet_id,
								occurred_on, occurred_at, source, dedupe_key, created_at, updated_at, seq)
							values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
						)
						.bind(
							crypto.randomUUID(),
							a.spaceId,
							d.type,
							d.amountMinor,
							d.currency,
							d.title,
							d.walletId,
							d.occurredOn,
							d.occurredAt,
							d.source,
							d.dedupeKey,
							1,
							1
						)
				)
			);
		};
		await insert();
		await insert();
		const stored = (
			await d1
				.prepare(
					'select source, amount_minor, title from drafts where space_id = ? order by amount_minor'
				)
				.bind(a.spaceId)
				.all()
		).results;
		expect(stored).toEqual([
			{ source: 'slack', amount_minor: 500_000, title: 'parkir' },
			{ source: 'slack', amount_minor: 2_500_000, title: 'kopi' }
		]);
	});
});
