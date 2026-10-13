import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import {
	clearSpaceCookie,
	LEFT_NOTICE_COOKIE,
	SPACE_COOKIE,
	setSpaceCookie
} from '#lib/server/spaces/access';
import { acceptInvite, createInvite, INVITE_TTL_MS } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers } from '#lib/server/spaces/spaces';
import { openLocalD1 } from '../helpers/d1';
import { fakeCookies, fakeEvent } from '../helpers/event';

// Kit 3: bindings come from getEnv() (cloudflare:workers), which Node cannot load; tests hand it the local D1.
const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const list = await import('../../src/routes/(app)/ruang/+page.server');
const baru = await import('../../src/routes/(app)/ruang/baru/+page.server');
const detail = await import('../../src/routes/(app)/ruang/[id]/+page.server');
const undangan = await import('../../src/routes/(app)/ruang/undangan/[token]/+page.server');
const akun = await import('../../src/routes/(app)/pengaturan/akun/+page.server');

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

type Action = (event: never) => unknown;
const action = (actions: unknown, name: string) =>
	(actions as Record<string, Action>)[name] as Action;

/** Runs a load/action and returns what it threw or returned, in one shape. */
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

let seq = 0;
async function person(name = 'Uji') {
	const email = `rute${++seq}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = await d1
		.prepare('select space_id as id from space_members where user_id = ?')
		.bind(r.userId)
		.first<{ id: string }>();
	return {
		user: { id: r.userId, email, name, createdAt: 0 },
		token: r.token,
		personalId: personal!.id
	};
}
type Person = Awaited<ReturnType<typeof person>>;

/** An (app) event for `who` (or signed out with null). */
function ev(
	who: Person | null,
	path: string,
	routeId: string,
	extra: {
		form?: Record<string, string>;
		params?: Record<string, string>;
		cookies?: Record<string, string>;
		headers?: Record<string, string>;
		method?: string;
	} = {}
) {
	return fakeEvent({
		url: `http://localhost${path}`,
		routeId,
		db,
		user: who?.user ?? null,
		...extra
	});
}

const DETAIL = '/(app)/ruang/[id]';
const INVITE = '/(app)/ruang/undangan/[token]';

async function sharedSpace() {
	const owner = await person('Pemilik');
	const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
	const invite = (await createInvite(
		db,
		{ spaceId, userId: owner.user.id, replaces: '' },
		Date.now()
	))!;
	const member = await person('Anggota');
	await acceptInvite(db, invite.token, member.user.id, Date.now());
	return { owner, member, spaceId, inviteToken: invite.token };
}

const counts = async (spaceId: string) => ({
	live: (await d1
		.prepare('select count(*) as n from space_members where space_id = ? and deleted_at is null')
		.bind(spaceId)
		.first<{ n: number }>())!.n,
	invites: (await d1
		.prepare('select count(*) as n from space_invites where space_id = ? and deleted_at is null')
		.bind(spaceId)
		.first<{ n: number }>())!.n,
	audits: (await d1
		.prepare('select count(*) as n from audit_events where space_id = ?')
		.bind(spaceId)
		.first<{ n: number }>())!.n
});

describe('hooks.server.ts: locals.space', () => {
	const resolve = vi.fn(async () => new Response('ok'));
	const hit = async (p: Person, cookie?: string) => {
		const cookies: Record<string, string> = { financer_session: p.token };
		if (cookie !== undefined) cookies[SPACE_COOKIE] = cookie;
		const { event, locals } = fakeEvent({
			url: 'http://localhost/',
			routeId: '/(app)',
			db,
			cookies
		});
		const res = await handle({ event, resolve });
		expect(res.status).toBe(200);
		return locals.space;
	};

	it('falls back to the personal space for no, bad or foreign cookies, and follows a valid one', async () => {
		const { owner, member, spaceId } = await sharedSpace();
		expect((await hit(member))?.id).toBe(member.personalId);
		expect((await hit(member, 'bukan-ruang'))?.id).toBe(member.personalId);
		expect((await hit(member, owner.personalId))?.id).toBe(member.personalId);
		expect(await hit(member, spaceId)).toMatchObject({
			id: spaceId,
			kind: 'shared',
			role: 'member'
		});
	});

	it('a removed member’s next request falls back without an error', async () => {
		const { owner, member, spaceId } = await sharedSpace();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		const removed = await run(() =>
			action(
				detail.actions,
				'removeMember'
			)(
				ev(owner, `/ruang/${spaceId}?/removeMember`, DETAIL, {
					params: { id: spaceId },
					form: { memberId: row.id }
				}).event as never
			)
		);
		expect(removed).toMatchObject({ kind: 'ok', value: { removed: true } });
		expect((await hit(member, spaceId))?.id).toBe(member.personalId);
	});

	it('leaves locals.space null outside (app) routes', async () => {
		const p = await person();
		const { event, locals } = fakeEvent({
			url: 'http://localhost/api/v1/health',
			routeId: '/api/v1/health',
			db,
			cookies: { financer_session: p.token }
		});
		await handle({ event, resolve });
		expect(locals.space).toBeNull();
	});

	it('sends a signed-out invite visitor to /masuk and back to the same invite', async () => {
		const { inviteToken } = await sharedSpace();
		const { event } = fakeEvent({
			url: `http://localhost/ruang/undangan/${inviteToken}`,
			routeId: INVITE,
			db
		});
		const res = await handle({ event, resolve });
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe(
			`/masuk?next=${encodeURIComponent(`/ruang/undangan/${inviteToken}`)}`
		);
	});
});

describe('/ruang/[id]: one access rule', () => {
	it('a non-member, a removed member and a missing id get the same 404 on load and every action', async () => {
		const { owner, member, spaceId } = await sharedSpace();
		const stranger = await person();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await action(
			detail.actions,
			'removeMember'
		)(
			ev(owner, '/', DETAIL, { params: { id: spaceId }, form: { memberId: row.id } }).event as never
		);
		const before = await counts(spaceId);
		const missing = crypto.randomUUID();
		const answers = [];
		for (const [who, id] of [
			[stranger, spaceId],
			[member, spaceId],
			[stranger, missing]
		] as const) {
			answers.push(
				await run(() =>
					detail.load(ev(who, `/ruang/${id}`, DETAIL, { params: { id } }).event as never)
				)
			);
			for (const name of ['createInvite', 'revokeInvite', 'removeMember', 'leave'])
				answers.push(
					await run(() =>
						action(
							detail.actions,
							name
						)(
							ev(who, `/ruang/${id}`, DETAIL, {
								params: { id },
								form: { replaces: '', inviteId: 'x', memberId: row.id }
							}).event as never
						)
					)
				);
		}
		for (const a of answers)
			expect(a).toEqual({
				kind: 'error',
				status: 404,
				body: { message: 'Not found', status: 404 }
			});
		expect(await counts(spaceId)).toEqual(before);
		// Nothing about the space leaks in the answer.
		expect(JSON.stringify(answers)).not.toContain('Keluarga');
	});

	it('a member gets 403 on owner actions and nothing changes', async () => {
		const { owner, member, spaceId } = await sharedSpace();
		const ownRow = (await listMembers(db, spaceId, owner.user.id)).find((m) => m.isYou)!;
		const before = await counts(spaceId);
		for (const name of ['createInvite', 'revokeInvite', 'removeMember'])
			expect(
				await run(() =>
					action(
						detail.actions,
						name
					)(
						ev(member, '/', DETAIL, {
							params: { id: spaceId },
							form: { replaces: '', inviteId: 'x', memberId: ownRow.id }
						}).event as never
					)
				)
			).toMatchObject({ kind: 'error', status: 403 });
		expect(await counts(spaceId)).toEqual(before);
	});

	it('the owner cannot leave or remove themselves', async () => {
		const { owner, spaceId } = await sharedSpace();
		const ownRow = (await listMembers(db, spaceId, owner.user.id)).find((m) => m.isYou)!;
		const before = await counts(spaceId);
		expect(
			await run(() =>
				action(
					detail.actions,
					'leave'
				)(ev(owner, '/', DETAIL, { params: { id: spaceId }, form: {} }).event as never)
			)
		).toMatchObject({ kind: 'error', status: 403 });
		expect(
			await run(() =>
				action(
					detail.actions,
					'removeMember'
				)(
					ev(owner, '/', DETAIL, { params: { id: spaceId }, form: { memberId: ownRow.id } })
						.event as never
				)
			)
		).toMatchObject({ kind: 'fail', status: 400 });
		expect(await counts(spaceId)).toEqual(before);
	});

	it('the owner sees members and roles; the raw invite link appears only in the create response', async () => {
		const { owner, spaceId } = await sharedSpace();
		const live = (await run(() =>
			detail.load(ev(owner, '/', DETAIL, { params: { id: spaceId } }).event as never)
		)) as { kind: 'ok'; value: { invite: { id: string }; members: { role: string }[] } };
		expect(live.value.members.map((m) => m.role)).toEqual(['owner', 'member']);
		const created = await run(() =>
			action(
				detail.actions,
				'createInvite'
			)(
				ev(owner, `/ruang/${spaceId}`, DETAIL, {
					params: { id: spaceId },
					form: { replaces: live.value.invite.id }
				}).event as never
			)
		);
		expect(created.kind).toBe('ok');
		const link = (created as unknown as { value: { created: { link: string } } }).value.created
			.link;
		expect(link).toMatch(/^http:\/\/localhost\/ruang\/undangan\/[A-Za-z0-9_-]{43}$/);
		const token = link.split('/').pop()!;
		const reread = await run(() =>
			detail.load(ev(owner, '/', DETAIL, { params: { id: spaceId } }).event as never)
		);
		expect(JSON.stringify(reread)).not.toContain(token);
		expect(reread).toMatchObject({ kind: 'ok', value: { invite: { expired: false } } });
		// The stale form (still naming the first invite) is refused, not a second live link.
		const stale = await run(() =>
			action(
				detail.actions,
				'createInvite'
			)(
				ev(owner, '/', DETAIL, {
					params: { id: spaceId },
					form: { replaces: live.value.invite.id }
				}).event as never
			)
		);
		expect(stale).toMatchObject({ kind: 'fail', status: 409 });
		expect((await counts(spaceId)).invites).toBe(1);
	});

	it('a member leaves: cookie back to personal, redirect to /ruang, no further access', async () => {
		const { member, spaceId } = await sharedSpace();
		const { event, written } = ev(member, '/', DETAIL, {
			params: { id: spaceId },
			form: {},
			cookies: { [SPACE_COOKIE]: spaceId }
		});
		expect(await run(() => action(detail.actions, 'leave')(event as never))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/ruang'
		});
		expect(written.get(SPACE_COOKIE)?.value).toBe('');
		// L2: the notice rides on a short-lived cookie only this action sets.
		expect(written.get(LEFT_NOTICE_COOKIE)).toMatchObject({
			value: '1',
			options: { httpOnly: true, path: '/', maxAge: 60 }
		});
		expect(
			await run(() =>
				detail.load(ev(member, '/', DETAIL, { params: { id: spaceId } }).event as never)
			)
		).toMatchObject({ kind: 'error', status: 404 });
	});

	it('answers 415 for a JSON body and 400 for an oversized one, never 500', async () => {
		const { owner, spaceId } = await sharedSpace();
		const json = ev(owner, '/', DETAIL, {
			params: { id: spaceId },
			method: 'POST',
			headers: { 'content-type': 'application/json' }
		});
		expect(
			await run(() => action(detail.actions, 'createInvite')(json.event as never))
		).toMatchObject({
			kind: 'error',
			status: 415
		});
		const big = ev(owner, '/', DETAIL, {
			params: { id: spaceId },
			form: { memberId: 'x'.repeat(20_000) }
		});
		expect(
			await run(() => action(detail.actions, 'removeMember')(big.event as never))
		).toMatchObject({
			kind: 'error',
			status: 400
		});
	});
});

describe('/ruang and /ruang/baru', () => {
	it('lists personal first, then shared, with the current marker', async () => {
		const { member, spaceId } = await sharedSpace();
		const { event, locals } = ev(member, '/ruang', '/(app)/ruang');
		locals.space = { id: spaceId, kind: 'shared', name: 'Keluarga', role: 'member' };
		const r = (await run(() => list.load(event as never))) as unknown as {
			value: { spaces: { id: string; kind: string }[]; currentId: string };
		};
		expect(r.value.spaces.map((s) => s.kind)).toEqual(['personal', 'shared']);
		expect(r.value.currentId).toBe(spaceId);
	});

	it('switchSpace re-checks membership: a foreign id is 404 and the cookie is untouched', async () => {
		const { owner, member, spaceId } = await sharedSpace();
		const foreign = ev(member, '/ruang', '/(app)/ruang', { form: { spaceId: owner.personalId } });
		expect(
			await run(() => action(list.actions, 'switchSpace')(foreign.event as never))
		).toMatchObject({ kind: 'error', status: 404 });
		expect(foreign.written.has(SPACE_COOKIE)).toBe(false);
		const mine = ev(member, '/ruang', '/(app)/ruang', { form: { spaceId } });
		expect(await run(() => action(list.actions, 'switchSpace')(mine.event as never))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/ruang'
		});
		expect(mine.written.get(SPACE_COOKIE)).toMatchObject({
			value: spaceId,
			options: { httpOnly: true, sameSite: 'lax', path: '/' }
		});
	});

	it('creates a shared space, makes it current and opens it; an empty name is refused', async () => {
		const p = await person();
		const ok = ev(p, '/ruang/baru', '/(app)/ruang/baru', {
			form: { name: 'Rumah' + String.fromCharCode(0x200b) }
		});
		const r = await run(() => action(baru.actions, 'default')(ok.event as never));
		expect(r).toMatchObject({ kind: 'redirect', status: 303 });
		const id = ok.written.get(SPACE_COOKIE)?.value;
		expect(r.kind === 'redirect' && r.location).toBe(`/ruang/${id}`);
		const empty = ev(p, '/ruang/baru', '/(app)/ruang/baru', {
			form: { name: ' ' + String.fromCharCode(0x200b) + ' ' }
		});
		expect(await run(() => action(baru.actions, 'default')(empty.event as never))).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { error: 'Isi nama ruang.' }
		});
		expect(empty.written.has(SPACE_COOKIE)).toBe(false);
	});
});

describe('/ruang/undangan/[token]', () => {
	const load = (who: Person, token: string) =>
		run(() =>
			undangan.load(
				ev(who, `/ruang/undangan/${token}`, INVITE, { params: { token } }).event as never
			)
		);
	const accept = (who: Person, token: string) => {
		const e = ev(who, '/', INVITE, { params: { token }, form: {} });
		return run(() => action(undangan.actions, 'accept')(e.event as never)).then((r) => ({
			r,
			written: e.written
		}));
	};

	it('unknown, garbage, expired and revoked tokens all look the same', async () => {
		const { owner, spaceId, inviteToken } = await sharedSpace();
		const visitor = await person();
		const invalid = { kind: 'ok', value: { state: 'invalid', spaceName: null } };
		for (const t of ['x'.repeat(43), 'abc', '%3Cscript%3E', 'z'.repeat(3000)])
			expect(await load(visitor, t)).toEqual(invalid);
		// Expired: rewind the clock of the live invite.
		await d1
			.prepare('update space_invites set expires_at = ? where space_id = ? and deleted_at is null')
			.bind(Date.now() - 1, spaceId)
			.run();
		expect(await load(visitor, inviteToken)).toEqual(invalid);
		expect((await accept(visitor, inviteToken)).r).toMatchObject({ kind: 'fail', status: 404 });
		await d1
			.prepare('update space_invites set expires_at = ? where space_id = ?')
			.bind(Date.now() + INVITE_TTL_MS, spaceId)
			.run();
		const live = await d1
			.prepare('select id from space_invites where space_id = ? and deleted_at is null')
			.bind(spaceId)
			.first<{ id: string }>();
		await action(
			detail.actions,
			'revokeInvite'
		)(
			ev(owner, '/', DETAIL, { params: { id: spaceId }, form: { inviteId: live!.id } })
				.event as never
		);
		expect(await load(visitor, inviteToken)).toEqual(invalid);
	});

	it('accepts: cookie set to the space and redirect to /; a second visit is idempotent', async () => {
		const { spaceId, inviteToken } = await sharedSpace();
		const guest = await person();
		expect(await load(guest, inviteToken)).toEqual({
			kind: 'ok',
			value: { state: 'open', spaceName: 'Keluarga' }
		});
		const first = await accept(guest, inviteToken);
		expect(first.r).toEqual({ kind: 'redirect', status: 303, location: '/' });
		expect(first.written.get(SPACE_COOKIE)?.value).toBe(spaceId);
		expect(await load(guest, inviteToken)).toMatchObject({ value: { state: 'member' } });
		const before = await counts(spaceId);
		const again = await accept(guest, inviteToken);
		expect(again.r).toEqual({ kind: 'redirect', status: 303, location: '/' });
		expect(await counts(spaceId)).toEqual(before);
	});

	it('a full space shows "full" and refuses the accept without writing', async () => {
		const { spaceId, inviteToken } = await sharedSpace();
		for (let i = 0; i < 3; i++) await accept(await person(), inviteToken);
		const late = await person();
		expect(await load(late, inviteToken)).toMatchObject({ value: { state: 'full' } });
		const before = await counts(spaceId);
		const r = await accept(late, inviteToken);
		expect(r.r).toMatchObject({
			kind: 'fail',
			status: 409,
			data: { error: 'Ruang ini sudah penuh.' }
		});
		expect(r.written.has(SPACE_COOKIE)).toBe(false);
		expect(await counts(spaceId)).toEqual(before);
	});
});

describe('red-team cycle 3', () => {
	const resolve = vi.fn(async () => new Response('ok'));

	it('L2: "you left" shows only from the action’s cookie, once; a bare ?keluar=1 shows nothing', async () => {
		const p = await person();
		const forged = await run(() =>
			list.load(ev(p, '/ruang?keluar=1', '/(app)/ruang').event as never)
		);
		expect(forged).toMatchObject({ kind: 'ok', value: { left: false } });
		const flashed = ev(p, '/ruang', '/(app)/ruang', { cookies: { [LEFT_NOTICE_COOKIE]: '1' } });
		expect(await run(() => list.load(flashed.event as never))).toMatchObject({
			kind: 'ok',
			value: { left: true }
		});
		expect(flashed.written.get(LEFT_NOTICE_COOKIE)?.value).toBe('');
	});

	it('L2: a leave that wrote nothing (lost race) reports "changed meanwhile", not success', async () => {
		const { member, spaceId } = await sharedSpace();
		const leave = () => {
			const e = ev(member, '/', DETAIL, { params: { id: spaceId }, form: {} });
			return run(() => action(detail.actions, 'leave')(e.event as never)).then((r) => ({
				r,
				notice: e.written.get(LEFT_NOTICE_COOKIE)?.value
			}));
		};
		const both = await Promise.all([leave(), leave(), leave()]);
		expect(both.filter((x) => x.r.kind === 'redirect')).toHaveLength(1);
		expect(both.filter((x) => x.notice === '1')).toHaveLength(1);
		for (const x of both.filter((y) => y.r.kind !== 'redirect'))
			expect(x.r).toMatchObject(
				x.r.kind === 'fail' ? { status: 409 } : { kind: 'error', status: 404 }
			);
	});

	it('L3: invite pages, and sign-in/up pages carrying an invite in next, never send the path as Referer', async () => {
		const { inviteToken } = await sharedSpace();
		const p = await person();
		const signedIn = fakeEvent({
			url: `http://localhost/ruang/undangan/${inviteToken}`,
			routeId: INVITE,
			db,
			cookies: { financer_session: p.token }
		});
		expect((await handle({ event: signedIn.event, resolve })).headers.get('referrer-policy')).toBe(
			'strict-origin'
		);
		const signedOut = fakeEvent({
			url: `http://localhost/ruang/undangan/${inviteToken}`,
			routeId: INVITE,
			db
		});
		const redirected = await handle({ event: signedOut.event, resolve });
		expect(redirected.status).toBe(303);
		expect(redirected.headers.get('referrer-policy')).toBe('strict-origin');
		for (const path of ['/masuk', '/daftar']) {
			const e = fakeEvent({
				url: `http://localhost${path}?next=${encodeURIComponent(`/ruang/undangan/${inviteToken}`)}`,
				routeId: `/(auth)${path}`,
				db
			});
			expect((await handle({ event: e.event, resolve })).headers.get('referrer-policy')).toBe(
				'strict-origin'
			);
		}
		const home = fakeEvent({
			url: 'http://localhost/',
			routeId: '/(app)',
			db,
			cookies: { financer_session: p.token }
		});
		expect((await handle({ event: home.event, resolve })).headers.get('referrer-policy')).toBe(
			'strict-origin-when-cross-origin'
		);
	});

	it('L3: the request log line never carries the invite token (path or next=)', async () => {
		const { inviteToken } = await sharedSpace();
		const p = await person();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const events = [
				fakeEvent({
					url: `http://localhost/ruang/undangan/${inviteToken}`,
					routeId: INVITE,
					db,
					cookies: { financer_session: p.token }
				}),
				fakeEvent({ url: `http://localhost/ruang/undangan/${inviteToken}`, routeId: INVITE, db }),
				fakeEvent({
					url: `http://localhost/masuk?next=${encodeURIComponent(`/ruang/undangan/${inviteToken}`)}`,
					routeId: '/(auth)/masuk',
					db
				}),
				// No route matched (a mistyped link): the path itself is logged, token masked.
				fakeEvent({ url: `http://localhost/ruang/undangan/${inviteToken}/x`, routeId: null, db })
			];
			for (const e of events) await handle({ event: e.event, resolve });
			const lines = log.mock.calls.filter((c) => c[0] === 'request');
			expect(lines).toHaveLength(events.length);
			const text = JSON.stringify(lines);
			expect(text).not.toContain(inviteToken);
			expect(lines.map((c) => (c[1] as { path: string }).path)).toEqual([
				INVITE,
				INVITE,
				'/(auth)/masuk',
				'/ruang/undangan/[token]/x'
			]);
		} finally {
			log.mockRestore();
		}
	});

	it('L4: on a deployed host the space cookie is __Host- and Secure, and the hook reads that name', async () => {
		const jar = fakeCookies();
		setSpaceCookie(jar.cookies, 'abc', true);
		expect(jar.written.get('__Host-space')).toMatchObject({
			value: 'abc',
			options: { secure: true, path: '/', httpOnly: true }
		});
		expect(jar.written.has('space')).toBe(false);
		clearSpaceCookie(jar.cookies, true);
		expect(jar.written.get('__Host-space')?.value).toBe('');

		const { member, spaceId } = await sharedSpace();
		const planted = fakeEvent({
			url: 'https://montra.example/',
			routeId: '/(app)',
			db,
			// A plain `space` cookie (e.g. tossed by a sibling subdomain) is ignored on a secure host.
			cookies: { '__Host-financer_session': member.token, space: spaceId }
		});
		await handle({ event: planted.event, resolve });
		expect(planted.locals.space?.id).toBe(member.personalId);
		const real = fakeEvent({
			url: 'https://montra.example/',
			routeId: '/(app)',
			db,
			cookies: { '__Host-financer_session': member.token, '__Host-space': spaceId }
		});
		await handle({ event: real.event, resolve });
		expect(real.locals.space?.id).toBe(spaceId);
	});

	it('L4: signing out clears the space cookie', async () => {
		const { member, spaceId } = await sharedSpace();
		const e = fakeEvent({
			url: 'http://localhost/pengaturan/akun?/signOut',
			routeId: '/(app)/pengaturan/akun',
			db,
			user: member.user,
			sessionToken: member.token,
			form: {},
			cookies: { financer_session: member.token, [SPACE_COOKIE]: spaceId }
		});
		expect(await run(() => action(akun.actions, 'signOut')(e.event as never))).toMatchObject({
			kind: 'redirect'
		});
		expect(e.written.get(SPACE_COOKIE)?.value).toBe('');
	});
});
