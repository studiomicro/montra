import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveKey } from '#lib/server/ai-keys/repo';
import { signUp } from '#lib/server/auth/accounts';
import { THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import { ensurePresetCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { sha256Hex } from '#lib/server/util';
import { base64urlEncode } from '#lib/shared/base64url';
import { generateRows, longTableXlsx, unlabeledXlsx } from '../fixtures/spreadsheets';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { messagesResponse } from '../helpers/receipts';

// FN-17 QA cycle 1: gaps found while verifying the PRD (AC 20 read paths, AC 21/23 AI request and budget).
const binding: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const { fakeFetch } = vi.hoisted(() => ({
	fakeFetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
}));
vi.mock('#lib/server/spreadsheet/ai-mapping', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/spreadsheet/ai-mapping')>();
	return {
		...actual,
		suggestTabMapping: (...args: Parameters<typeof actual.suggestTabMapping>) =>
			actual.suggestTabMapping(
				args[0],
				args[1],
				args[2],
				args[3],
				fakeFetch as unknown as typeof fetch
			)
	};
});

const impor = await import('../../src/routes/(app)/impor/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.now();
const ENC = base64urlEncode(new Uint8Array(32).fill(17));

function configure(o: { gateway?: boolean } = {}) {
	for (const k of Object.keys(binding)) delete binding[k];
	binding.DB = d1;
	binding.AI_KEYS_ENCRYPTION_KEY = ENC;
	if (o.gateway !== false) {
		binding.AI_GATEWAY_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
		binding.AI_GATEWAY_ID = 'montra-test';
	}
}

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	configure();
});
afterAll(() => dispose());
beforeEach(() => {
	configure();
	fakeFetch.mockReset();
	fakeFetch.mockImplementation(async () => {
		throw new Error('no provider in tests');
	});
});

let n = 0;
async function account() {
	const email = `sheet${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	await ensurePresetCategories(db, space.id);
	return { user: { id: r.userId, email, name: 'Uji', createdAt: 0 }, scope };
}
type Account = Awaited<ReturnType<typeof account>>;

async function liveRows(spaceId: string) {
	const { results } = await d1
		.prepare(
			`select type, amount_minor, category_id, wallet_id, source, dedupe_key from transactions
			where space_id = ? and deleted_at is null`
		)
		.bind(spaceId)
		.all<Record<string, string | number | null>>();
	return results;
}

type Handler = (event: never) => unknown;
const act = (name: string) => (impor.actions as Record<string, Handler>)[name]!;

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

async function uploadEvent(
	who: Account,
	action: string,
	fields: Record<string, string | File>,
	space?: string,
	dbOverride?: Db
) {
	const current = await resolveCurrentSpace(db, who.user.id, space);
	const { event } = fakeEvent({
		url: `http://localhost/impor?/${action}`,
		routeId: '/(app)/impor',
		db: dbOverride ?? db,
		user: who.user,
		space: current
	});
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	const encoded = new Request('http://localhost/', { method: 'POST', body });
	(event as unknown as { request: Request }).request = new Request(
		`http://localhost/impor?/${action}`,
		{
			method: 'POST',
			headers: { 'content-type': encoded.headers.get('content-type')! },
			body: await encoded.arrayBuffer()
		}
	);
	return event as never;
}

const xlsx = (bytes: Uint8Array, name = 'keuangan 1234567890123.xlsx') =>
	new File([bytes as BlobPart], name, {
		type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	});

const small = () => unlabeledXlsx(generateRows(20));

async function seedAttempts(scope: string, userId: string, count: number) {
	const now = Date.now();
	await d1
		.prepare(
			`insert into auth_attempts (client_hash, window_start, count) values (?, ?, ?)
			on conflict (client_hash) do update set window_start = excluded.window_start, count = excluded.count`
		)
		.bind(await sha256Hex(`${scope}:user:${userId}`), now - (now % THROTTLE_WINDOW_MS), count)
		.run();
}

const press = (who: Account, bytes: Uint8Array) =>
	run(async () =>
		act('suggestMapping')(
			await uploadEvent(who, 'suggestMapping', { file: xlsx(bytes), aiTab: '0' })
		)
	);

describe('QA: read paths answer like the import for non-members (AC 20)', () => {
	it('a removed member or a stranger naming the shared space is answered in their own space, never the shared one', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga QA', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const bytes = small();
		// A removed member naming the shared space is answered in their own space (as for CSV): never the shared one.
		expect((await resolveCurrentSpace(db, member.user.id, spaceId))?.id).not.toBe(spaceId);
		const before = await liveRows(spaceId);
		for (const action of ['previewSheet', 'suggestMapping']) {
			const r = await run(async () =>
				act(action)(
					await uploadEvent(
						member,
						action,
						{ file: xlsx(bytes), aiTab: '0', step: 'read' },
						spaceId
					)
				)
			);
			expect(r.kind === 'ok' || (r.kind === 'fail' && r.status === 404)).toBe(true);
		}
		expect(await liveRows(spaceId)).toEqual(before);
		// A user naming someone else's space is answered in their own space, never the foreign one.
		const stranger = await account();
		const r = await run(async () =>
			act('previewSheet')(
				await uploadEvent(stranger, 'previewSheet', { file: xlsx(bytes), step: 'read' }, spaceId)
			)
		);
		expect(r).toMatchObject({ kind: 'ok', value: { section: 'spreadsheet' } });
		expect(await liveRows(spaceId)).toEqual([]);
	});
});

describe('QA: AI suggestion budget and gateway request (AC 21, 23)', () => {
	it('the 11th press in a window costs no provider call and says so; the file/layout stay', async () => {
		const a = await account();
		await saveKey(
			db,
			a.user.id,
			'anthropic',
			'sk-ant-api03-synthetic-qa-AbCdEfGh',
			binding as never,
			NOW
		);
		await seedAttempts('spreadsheet-ai', a.user.id, 9);
		fakeFetch.mockImplementation(async () => messagesResponse('bukan json'));
		const bytes = small();
		const first = await press(a, bytes);
		expect(first).toMatchObject({
			kind: 'ok',
			value: { sheet: { aiError: 'Saran AI tidak bisa dipakai, pilih kolom manual' } }
		});
		expect(fakeFetch).toHaveBeenCalledTimes(1);
		const second = await press(a, bytes);
		expect(second).toMatchObject({
			kind: 'ok',
			value: {
				sheet: {
					aiError: 'Terlalu banyak permintaan saran AI. Coba lagi dalam beberapa menit.',
					review: null,
					layout: { unmapped: [0] }
				}
			}
		});
		expect(fakeFetch).toHaveBeenCalledTimes(1);
		// Another user keeps their own budget.
		const b = await account();
		await saveKey(
			db,
			b.user.id,
			'anthropic',
			'sk-ant-api03-synthetic-qb-AbCdEfGh',
			binding as never,
			NOW
		);
		await press(b, bytes);
		expect(fakeFetch).toHaveBeenCalledTimes(2);
	});

	it('the gateway request skips cache and log collection, has a timeout, and carries no cell past row 5', async () => {
		const a = await account();
		const key = 'sk-ant-api03-synthetic-qc-AbCdEfGh';
		await saveKey(db, a.user.id, 'anthropic', key, binding as never, NOW);
		fakeFetch.mockImplementation(async () => messagesResponse('bukan json'));
		await press(a, unlabeledXlsx(generateRows(3000)));
		expect(fakeFetch).toHaveBeenCalledTimes(1);
		const [url, init] = fakeFetch.mock.calls[0]!;
		expect(url).toContain('gateway.ai.cloudflare.com');
		const headers = new Headers(init.headers);
		expect(headers.get('cf-aig-skip-cache')).toBe('true');
		expect(headers.get('cf-aig-collect-log')).toBe('false');
		expect(init.signal).toBeInstanceOf(AbortSignal);
		const sent = String(init.body);
		expect(sent).not.toContain('Transaksi fiktif #10');
		expect(sent).not.toContain('Transaksi fiktif #2999');
	});

	it('a tab the heuristics already mapped is refused for AI (400), no provider call', async () => {
		const a = await account();
		await saveKey(
			db,
			a.user.id,
			'anthropic',
			'sk-ant-api03-synthetic-qd-AbCdEfGh',
			binding as never,
			NOW
		);
		const r = await run(async () =>
			act('suggestMapping')(
				await uploadEvent(a, 'suggestMapping', {
					file: xlsx(longTableXlsx(generateRows(20))),
					aiTab: '0'
				})
			)
		);
		expect(r).toMatchObject({ kind: 'fail', status: 400 });
		expect(fakeFetch).not.toHaveBeenCalled();
	});
});
