import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { BELONGING_CHANGED, PURCHASED_ON_INVALID } from '#lib/server/belongings/messages';
import {
	COLLECTIBLE_DEMO_READONLY,
	COLLECTIBLE_LIMIT,
	COLLECTIBLE_NOT_FOUND,
	VALUE_INVALID
} from '#lib/server/collectibles/messages';
import { MAX_COLLECTIBLES_PER_SPACE } from '#lib/server/collectibles/repo';
import { getDb, type Db } from '#lib/server/db';
import {
	PHOTO_NOT_IMAGE,
	PHOTO_TOO_LARGE,
	PHOTO_UNREADABLE,
	PHOTO_UPLOAD_FAILED
} from '#lib/server/photos/messages';
import { sweepFileDeletions, sweepSoon, UPLOAD_GRACE_MS } from '#lib/server/photos/store';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import type { JobMessage } from '#lib/shared/jobs';
import { PHOTO_MAX_BYTES } from '#lib/shared/photos';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { bytes, has, jpeg, png } from '../helpers/images';

/**
 * FN-28 on local D1 + local R2. The photo paths are FN-27's shared module (photos/), so these tests repeat the
 * FN-27 shapes (barang.test.ts) for the collectibles table and its routes.
 */

/** The local R2 bucket, wrapped so a test can make put/delete fail like an R2 outage. */
const fault = { put: false, delete: false };
let realFiles: R2Bucket;
const files = {
	put: (...args: Parameters<R2Bucket['put']>) => {
		if (fault.put) throw new Error('R2 put failed');
		return realFiles.put(...args);
	},
	get: (key: string) => realFiles.get(key),
	head: (key: string) => realFiles.head(key),
	delete: (keys: string | string[]) => {
		if (fault.delete) throw new Error('R2 delete failed');
		return realFiles.delete(keys);
	},
	list: (opts?: R2ListOptions) => realFiles.list(opts)
} as unknown as R2Bucket;
const queued: JobMessage[] = [];
const binding: { DB?: D1Database; FILES?: R2Bucket; JOBS_QUEUE?: Queue } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/koleksi/+page.server');
const photoRoute = await import('../../src/routes/(app)/koleksi/[id]/foto/+server');
const barang = await import('../../src/routes/(app)/barang/+page.server');
const kekayaan = await import('../../src/routes/(app)/kekayaan/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	const local = await openLocalD1();
	({ db: d1, dispose } = local);
	realFiles = local.env.FILES;
	db = getDb(d1);
	binding.DB = d1;
	binding.FILES = files;
	binding.JOBS_QUEUE = {
		send: async (body: JobMessage) => {
			queued.push(body);
		}
	} as unknown as Queue;
});
afterAll(() => dispose());
beforeEach(() => {
	fault.put = false;
	fault.delete = false;
	queued.length = 0;
});

type Action = (event: never) => unknown;

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
	const email = `koleksi${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name, createdAt: 0 } };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An event for /koleksi; a form with a file is a real multipart body, like a browser form. */
async function ev(
	who: Person | null,
	opts: {
		path?: string;
		routeId?: string;
		params?: Record<string, string>;
		form?: Record<string, string>;
		file?: { bytes: Uint8Array; name: string; type: string };
		spaceCookie?: string;
		headers?: Record<string, string>;
	} = {}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	const url = `http://localhost${opts.path ?? '/koleksi'}`;
	const { event } = fakeEvent({
		url,
		routeId: opts.routeId ?? '/(app)/koleksi',
		db,
		user: who?.user ?? null,
		space,
		params: opts.params,
		headers: opts.headers
	});
	if (opts.form) {
		const body = new FormData();
		for (const [k, v] of Object.entries(opts.form)) body.set(k, v);
		if (opts.file)
			body.set(
				'photo',
				new File([opts.file.bytes as BlobPart], opts.file.name, { type: opts.file.type })
			);
		(event as { request: Request }).request = new Request(url, {
			method: 'POST',
			body,
			headers: opts.headers
		});
	}
	return event as never;
}

const ITEM = {
	name: 'Kartu langka',
	purchasePrice: '1.500.000',
	purchasedOn: '2024-10-08',
	currentValue: '2.100.000'
};
const photoJpeg = () => ({
	bytes: jpeg({ orientation: 6 }),
	name: 'IMG_0001.jpg',
	type: 'image/jpeg'
});

const act = (who: Person, name: string, opts: Parameters<typeof ev>[1]) =>
	run(async () => (page.actions as Record<string, Action>)[name]!(await ev(who, opts)));
const load = (who: Person, spaceCookie?: string) =>
	run(async () => page.load(await ev(who, { spaceCookie })));
type Item = {
	id: string;
	name: string;
	updatedAt: number;
	hasPhoto: boolean;
	valueMinor: number;
	gainMinor: number;
	isDemo: boolean;
};
async function items(who: Person, spaceCookie?: string) {
	const r = await load(who, spaceCookie);
	if (r.kind !== 'ok') throw new Error(`load: ${JSON.stringify(r)}`);
	return r.value as unknown as {
		items: Item[];
		totals: { currency: string; valueMinor: number | null; gainMinor: number | null }[];
	};
}
const getPhoto = (who: Person | null, id: string, headers?: Record<string, string>) =>
	run(async () => {
		const res = (await photoRoute.GET(
			await ev(who, {
				path: `/koleksi/${id}/foto`,
				routeId: '/(app)/koleksi/[id]/foto',
				params: { id },
				headers
			})
		)) as Response;
		return res;
	});
const status = (r: Awaited<ReturnType<typeof getPhoto>>) =>
	r.kind === 'ok' ? (r.value as unknown as Response).status : r;
const row = async (id: string) =>
	(await d1.prepare('select * from collectibles where id = ?').bind(id).first()) as Record<
		string,
		unknown
	> | null;
const outbox = async () =>
	(await d1.prepare('select key, due_at, attempts from file_deletions order by key').all())
		.results as { key: string; due_at: number; attempts: number }[];
const objectsUnder = async (prefix: string) =>
	(await realFiles.list({ prefix })).objects.map((o) => o.key);
async function spaceOf(who: Person) {
	return (await resolveCurrentSpace(db, who.user.id, undefined))!.id;
}
async function create(who: Person, form: Record<string, string> = ITEM, file = photoJpeg()) {
	const r = await act(who, 'create', { form, file });
	expect(r).toMatchObject({ kind: 'ok' });
	return (await items(who)).items[0]!;
}
const kekayaanOf = async (who: Person) => {
	const k = await run(async () =>
		kekayaan.load(await ev(who, { path: '/kekayaan', routeId: '/(app)/kekayaan' }))
	);
	if (k.kind !== 'ok') throw new Error('kekayaan load');
	return (k.value as { collectibles: unknown }).collectibles;
};
/** Inserts `count` live collectibles straight into D1 (cap set-up). */
async function fill(spaceId: string, count: number, demo = 0) {
	const now = Date.now();
	await d1.batch(
		Array.from({ length: count }, (_, i) =>
			d1
				.prepare(
					`insert into collectibles (id, space_id, name, purchase_price_minor, currency, purchased_on,
					manual_value_minor, is_demo, created_at, updated_at, seq)
					values (?, ?, ?, 100, 'IDR', '2024-01-01', 200, ?, ?, ?, 1)`
				)
				.bind(crypto.randomUUID(), spaceId, `Isi ${i}`, demo, now, now)
		)
	);
}

describe('values, gain and totals', () => {
	it('the current value is the own figure, the gain exact; the total reconciles with /kekayaan', async () => {
		const a = await person();
		await act(a, 'create', { form: ITEM });
		await act(a, 'create', {
			form: { ...ITEM, name: 'Sepatu', purchasePrice: '3.200.000', currentValue: '2.800.000' }
		});
		const data = await items(a);
		const card = data.items.find((i) => i.name === 'Kartu langka')!;
		const shoes = data.items.find((i) => i.name === 'Sepatu')!;
		expect(card).toMatchObject({ valueMinor: 210_000_000, gainMinor: 60_000_000, isDemo: false });
		expect(shoes).toMatchObject({ valueMinor: 280_000_000, gainMinor: -40_000_000 });
		expect(data.totals).toEqual([
			{ currency: 'IDR', valueMinor: 490_000_000, gainMinor: 20_000_000 }
		]);
		expect(await kekayaanOf(a)).toEqual({ totals: data.totals, failed: false });
	});

	it('Data demo rows are listed but left out of both totals', async () => {
		const a = await person();
		await fill(await spaceOf(a), 2, 1);
		await act(a, 'create', { form: ITEM });
		const data = await items(a);
		expect(data.items).toHaveLength(3);
		expect(data.items.filter((i) => i.isDemo)).toHaveLength(2);
		expect(data.totals).toEqual([
			{ currency: 'IDR', valueMinor: 210_000_000, gainMinor: 60_000_000 }
		]);
		expect(await kekayaanOf(a)).toEqual({ totals: data.totals, failed: false });
	});

	it('a total past the safe integer range is null ("too large"), never rounded or a failed page', async () => {
		const a = await person();
		for (let i = 0; i < 10; i++)
			await act(a, 'create', { form: { ...ITEM, currentValue: '9.999.999.999.999' } });
		const data = await items(a);
		expect(data.items).toHaveLength(10);
		expect(data.totals).toEqual([{ currency: 'IDR', valueMinor: null, gainMinor: null }]);
	});

	it('refuses a missing current value, a future date and a decimal, echoing the values', async () => {
		const a = await person();
		const blank = await act(a, 'create', { form: { ...ITEM, currentValue: '' } });
		expect(blank).toMatchObject({
			kind: 'fail',
			status: 400,
			data: {
				errors: { manualValueMinor: VALUE_INVALID },
				values: { name: 'Kartu langka', currentValue: '' }
			}
		});
		const future = await act(a, 'create', { form: { ...ITEM, purchasedOn: '2099-01-01' } });
		expect(future).toMatchObject({ data: { errors: { purchasedOn: PURCHASED_ON_INVALID } } });
		expect((await items(a)).items).toEqual([]);
	});

	it('no create, edit or delete calls out to any network (no automated price source)', async () => {
		const spy = vi.spyOn(globalThis, 'fetch');
		try {
			const a = await person();
			const item = await create(a);
			await act(a, 'update', {
				form: { ...ITEM, collectibleId: item.id, updatedAt: String(item.updatedAt) }
			});
			await items(a);
			await kekayaanOf(a);
			const fresh = (await items(a)).items[0]!;
			await act(a, 'archive', {
				form: { collectibleId: fresh.id, updatedAt: String(fresh.updatedAt) }
			});
			expect(spy.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
				expect.stringMatching(/pokemontcg|scrydex|tcgplayer/)
			);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});

describe('photo upload (FN-27 shared module)', () => {
	it('stores a sanitized JPEG under a collectibles key and serves it to a member with the photo headers', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a);
		expect(item.hasPhoto).toBe(true);
		const stored = await row(item.id);
		const key = stored!.photo_key as string;
		expect(key).toMatch(
			new RegExp(
				`^spaces/${spaceId}/collectibles/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$`
			)
		);
		expect((await outbox()).map((o) => o.key)).not.toContain(key);
		const object = new Uint8Array(await (await realFiles.get(key))!.arrayBuffer());
		expect(has(object, 'GPSLAT')).toBe(false);

		const res = await getPhoto(a, item.id);
		const response = (res as { value: unknown }).value as Response;
		expect(response.status).toBe(200);
		expect(Object.fromEntries(response.headers)).toMatchObject({
			'content-type': 'image/jpeg',
			'x-content-type-options': 'nosniff',
			'content-disposition': 'inline',
			'cache-control': 'private, no-cache',
			'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'"
		});
		expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(object))).toBe(true);
		const etag = response.headers.get('etag')!;
		expect(status(await getPhoto(a, item.id, { 'if-none-match': etag }))).toBe(304);
	});

	it.each([
		[
			'HTML named .jpg sent as image/jpeg',
			bytes('<html><script>alert(1)</script></html>'),
			'x.jpg',
			'image/jpeg',
			PHOTO_NOT_IMAGE
		],
		[
			'SVG',
			bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
			'x.svg',
			'image/svg+xml',
			PHOTO_NOT_IMAGE
		],
		[
			'JPEG magic bytes + HTML (polyglot)',
			bytes([0xff, 0xd8, 0xff], '<html><script>alert(1)</script>'),
			'x.jpg',
			'image/jpeg',
			PHOTO_UNREADABLE
		],
		['PNG sent as text/html', png(), 'x.png', 'text/html', null]
	])('%s: decided by its bytes only', async (_label, data, name, type, refusal) => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const r = await act(a, 'create', { form: ITEM, file: { bytes: data, name, type } });
		if (refusal === null) {
			expect(r).toMatchObject({ kind: 'ok' });
			const item = (await items(a)).items[0]!;
			expect((await row(item.id))!.photo_type).toBe('image/png');
			return;
		}
		expect(r).toMatchObject({ kind: 'fail', status: 400, data: { errors: { photo: refusal } } });
		expect((await items(a)).items).toEqual([]);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
	});

	it('refuses an oversized photo and an announced oversized body, writing nothing', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
		big.set(jpeg());
		expect(
			await act(a, 'create', {
				form: ITEM,
				file: { bytes: big, name: 'big.jpg', type: 'image/jpeg' }
			})
		).toMatchObject({ kind: 'fail', status: 400, data: { errors: { photo: PHOTO_TOO_LARGE } } });
		expect(
			await act(a, 'create', {
				form: ITEM,
				headers: { 'content-length': String(PHOTO_MAX_BYTES * 2) }
			})
		).toMatchObject({ kind: 'fail', status: 413, data: { error: PHOTO_TOO_LARGE } });
		expect((await items(a)).items).toEqual([]);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
	});

	it('an R2 outage on upload leaves no row and only a reservation the sweep clears after the grace', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		fault.put = true;
		expect(await act(a, 'create', { form: ITEM, file: photoJpeg() })).toMatchObject({
			kind: 'fail',
			status: 503,
			data: { errors: { photo: PHOTO_UPLOAD_FAILED } }
		});
		fault.put = false;
		expect((await items(a)).items).toEqual([]);
		const reserved = (await outbox()).filter((o) => o.key.startsWith(`spaces/${spaceId}/`));
		expect(reserved).toHaveLength(1);
		await sweepFileDeletions(db, files, Date.now());
		expect((await outbox()).map((o) => o.key)).toContain(reserved[0]!.key);
		await sweepFileDeletions(db, files, Date.now() + UPLOAD_GRACE_MS + 1000);
		expect((await outbox()).map((o) => o.key)).not.toContain(reserved[0]!.key);
	});

	it('the sweep never deletes an object a live collectible still holds', async () => {
		const a = await person();
		const item = await create(a);
		const key = (await row(item.id))!.photo_key as string;
		await d1
			.prepare('insert into file_deletions (key, due_at, attempts) values (?, 0, 0)')
			.bind(key)
			.run();
		await sweepFileDeletions(db, files, Date.now());
		expect(await outbox()).not.toContainEqual(expect.objectContaining({ key }));
		expect(await realFiles.head(key)).not.toBeNull();
		expect(status(await getPhoto(a, item.id))).toBe(200);
	});

	it('replace deletes the old object; a stale replace (409) deletes the new one and changes nothing', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a);
		const oldKey = (await row(item.id))!.photo_key as string;
		expect(
			await act(a, 'update', {
				form: { ...ITEM, collectibleId: item.id, updatedAt: String(item.updatedAt) },
				file: { bytes: png(), name: 'b.png', type: 'image/png' }
			})
		).toMatchObject({ kind: 'ok' });
		const after = (await row(item.id))!;
		expect(after.photo_type).toBe('image/png');
		expect(oldKey).not.toBe(after.photo_key);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([after.photo_key]);
		const stale = await act(a, 'update', {
			form: {
				...ITEM,
				currentValue: '1',
				collectibleId: item.id,
				updatedAt: String(item.updatedAt)
			},
			file: photoJpeg()
		});
		expect(stale).toMatchObject({ kind: 'fail', status: 409, data: { error: BELONGING_CHANGED } });
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([after.photo_key]);
		expect(await row(item.id)).toEqual(after);
	});

	it('"Hapus foto" removes the photo and its object', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a);
		expect(
			await act(a, 'update', {
				form: {
					...ITEM,
					collectibleId: item.id,
					updatedAt: String(item.updatedAt),
					removePhoto: 'on'
				}
			})
		).toMatchObject({ kind: 'ok' });
		expect((await row(item.id))!.photo_key).toBeNull();
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
		expect(await getPhoto(a, item.id)).toMatchObject({ kind: 'error', status: 404 });
	});
});

describe('deleting (archive)', () => {
	it('leaves a content-free tombstone, deletes the object, and the photo route answers the unknown-id 404', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a, { ...ITEM, note: 'Kondisi mulus' });
		const r = await act(a, 'archive', {
			form: { collectibleId: item.id, updatedAt: String(item.updatedAt) }
		});
		expect(r).toMatchObject({ kind: 'ok', value: { saved: 'archived' } });
		const tomb = (await row(item.id))!;
		expect(tomb).toMatchObject({
			name: null,
			purchase_price_minor: null,
			purchased_on: null,
			manual_value_minor: null,
			photo_key: null,
			photo_type: null,
			note: null,
			created_at: null
		});
		expect(tomb.deleted_at).not.toBeNull();
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
		expect(await outbox()).toEqual([]);
		const unknown = await getPhoto(a, '00000000-0000-4000-8000-000000000000');
		expect(await getPhoto(a, item.id)).toEqual(unknown);
		expect(unknown).toEqual({
			kind: 'error',
			status: 404,
			body: { message: 'Not found', status: 404 }
		});
		expect((await items(a)).items).toEqual([]);
	});

	it('a tombstone with content is refused by the CHECK', async () => {
		const a = await person();
		const item = await create(a);
		await expect(
			d1.prepare('update collectibles set deleted_at = 1 where id = ?').bind(item.id).run()
		).rejects.toThrow(/CHECK/);
	});

	it('when the R2 delete fails the key waits in the outbox, a retry is queued, and the sweep finishes it', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a);
		const key = (await row(item.id))!.photo_key as string;
		fault.delete = true;
		expect(
			await act(a, 'archive', {
				form: { collectibleId: item.id, updatedAt: String(item.updatedAt) }
			})
		).toMatchObject({ kind: 'ok' });
		expect(await getPhoto(a, item.id)).toMatchObject({ kind: 'error', status: 404 });
		expect(await outbox()).toMatchObject([{ key, attempts: 1 }]);
		expect(queued).toEqual([{ type: 'file_sweep' }]);
		fault.delete = false;
		expect(await sweepFileDeletions(db, files, Date.now())).toBe(1);
		expect(await outbox()).toEqual([]);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
	});
});

describe('one access rule', () => {
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
		const r = await run(async () =>
			(page.actions as Record<string, Action>).create!(
				await ev(owner, { form: ITEM, file: photoJpeg(), spaceCookie: spaceId })
			)
		);
		expect(r).toMatchObject({ kind: 'ok' });
		const item = (await items(owner, spaceId)).items[0]!;
		return { owner, member, spaceId, item };
	}

	it.each([
		['koleksi', '/koleksi', '/(app)/koleksi', 'collectibleId'],
		['barang', '/barang', '/(app)/barang', 'belongingId']
	] as const)(
		'L1 (%s): a removed member’s archive is refused before its body is read (malformed body → same 404)',
		async (route, path, routeId, idName) => {
			const { owner, member, spaceId, item } = await shared();
			// The member's session still points at the shared space (resolved before the removal).
			const staleSpace = await resolveCurrentSpace(db, member.user.id, spaceId);
			expect(staleSpace!.id).toBe(spaceId);
			const memberRow = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
			await removeMember(
				db,
				{ spaceId, actorUserId: owner.user.id, memberId: memberRow.id },
				Date.now()
			);
			const actions = (route === 'koleksi' ? page.actions : barang.actions) as Record<
				string,
				Action
			>;
			const post = async (request: Request) => {
				const { event } = fakeEvent({
					url: `http://localhost${path}`,
					routeId,
					db,
					user: member.user,
					space: staleSpace
				});
				let read = false;
				const watched = new Proxy(request, {
					get(target, prop) {
						if (prop === 'body' || prop === 'formData' || prop === 'arrayBuffer') read = true;
						const value = Reflect.get(target, prop, target);
						return typeof value === 'function' ? value.bind(target) : value;
					}
				});
				(event as { request: Request }).request = watched;
				return { result: await run(() => actions.archive!(event as never)), read };
			};
			const valid = new FormData();
			valid.set(idName, item.id);
			valid.set('updatedAt', String(item.updatedAt));
			const asForm = await post(
				new Request(`http://localhost${path}`, { method: 'POST', body: valid })
			);
			const malformed = await post(
				new Request(`http://localhost${path}`, {
					method: 'POST',
					body: '\u0000not a form',
					headers: { 'content-type': 'text/plain' }
				})
			);
			const notFound = { kind: 'error', status: 404, body: { message: 'Not found', status: 404 } };
			expect(asForm.result).toEqual(notFound);
			expect(malformed.result).toEqual(notFound);
			expect(asForm.read || malformed.read).toBe(false);
		}
	);

	it('a member sees the photo; a stranger, a removed member, signed out and odd ids get the same 404', async () => {
		const { owner, member, spaceId, item } = await shared();
		expect(status(await getPhoto(member, item.id))).toBe(200);
		const stranger = await person();
		const unknown = await getPhoto(stranger, '00000000-0000-4000-8000-000000000000');
		expect(unknown).toEqual({
			kind: 'error',
			status: 404,
			body: { message: 'Not found', status: 404 }
		});
		expect(await getPhoto(stranger, item.id)).toEqual(unknown);
		expect(await getPhoto(stranger, 'x'.repeat(500))).toEqual(unknown);
		expect(await getPhoto(null, item.id)).toEqual(unknown);
		const memberRow = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(
			db,
			{ spaceId, actorUserId: owner.user.id, memberId: memberRow.id },
			Date.now()
		);
		expect(await getPhoto(member, item.id)).toEqual(unknown);
	});

	it('a removed member can no longer list, edit or delete the shared space’s collectibles', async () => {
		const { owner, member, spaceId, item } = await shared();
		const memberRow = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(
			db,
			{ spaceId, actorUserId: owner.user.id, memberId: memberRow.id },
			Date.now()
		);
		const before = await row(item.id);
		// The space cookie of the old space falls back to their personal space: nothing of the shared one shows.
		expect((await items(member, spaceId)).items).toEqual([]);
		const upd = await run(async () =>
			(page.actions as Record<string, Action>).update!(
				await ev(member, {
					form: {
						...ITEM,
						name: 'Diambil',
						collectibleId: item.id,
						updatedAt: String(item.updatedAt)
					},
					spaceCookie: spaceId
				})
			)
		);
		expect(upd).toEqual({ kind: 'fail', status: 404, data: { error: COLLECTIBLE_NOT_FOUND } });
		expect(await row(item.id)).toEqual(before);
	});

	it('a stranger cannot update or delete another space’s item (same answer as an unknown id)', async () => {
		const { spaceId, item } = await shared();
		const stranger = await person();
		const before = await row(item.id);
		const objects = await objectsUnder(`spaces/${spaceId}/`);
		const upd = await act(stranger, 'update', {
			form: { ...ITEM, name: 'Diambil', collectibleId: item.id, updatedAt: String(item.updatedAt) },
			file: photoJpeg()
		});
		const del = await act(stranger, 'archive', {
			form: { collectibleId: item.id, updatedAt: String(item.updatedAt) }
		});
		const unknown = await act(stranger, 'archive', {
			form: { collectibleId: '00000000-0000-4000-8000-000000000000', updatedAt: '1' }
		});
		expect(upd).toEqual({ kind: 'fail', status: 404, data: { error: COLLECTIBLE_NOT_FOUND } });
		expect(del).toEqual(unknown);
		expect(await row(item.id)).toEqual(before);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual(objects);
		expect(await objectsUnder(`spaces/${await spaceOf(stranger)}/`)).toEqual([]);
	});

	it('signed out: the page redirects to /masuk', async () => {
		expect(await run(async () => page.load(await ev(null)))).toMatchObject({
			kind: 'redirect',
			location: '/masuk'
		});
	});
});

describe('L2: Data demo rows are read-only', () => {
	it('edit (with or without a photo) and delete are refused; the row and the bucket are unchanged', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		await fill(spaceId, 1, 1);
		const demo = (await items(a)).items[0]!;
		expect(demo.isDemo).toBe(true);
		const before = await row(demo.id);
		const refusal = { kind: 'fail', status: 400, data: { error: COLLECTIBLE_DEMO_READONLY } };
		const form = { ...ITEM, collectibleId: demo.id, updatedAt: String(demo.updatedAt) };
		expect(await act(a, 'update', { form })).toEqual(refusal);
		expect(await act(a, 'update', { form, file: photoJpeg() })).toEqual(refusal);
		expect(
			await act(a, 'archive', {
				form: { collectibleId: demo.id, updatedAt: String(demo.updatedAt) }
			})
		).toEqual(refusal);
		expect(await row(demo.id)).toEqual(before);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
		expect((await outbox()).filter((o) => o.key.startsWith(`spaces/${spaceId}/`))).toEqual([]);
		// A stale demo form gets the same answer (no oracle on its updated_at).
		expect(await act(a, 'archive', { form: { collectibleId: demo.id, updatedAt: '1' } })).toEqual(
			refusal
		);
	});
});

describe('cap and concurrency', () => {
	it(`20 concurrent creates at ${MAX_COLLECTIBLES_PER_SPACE - 10} stop at exactly ${MAX_COLLECTIBLES_PER_SPACE}`, async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		await fill(spaceId, MAX_COLLECTIBLES_PER_SPACE - 10);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => act(a, 'create', { form: ITEM }))
		);
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(10);
		expect(
			results.filter((r) => r.kind === 'fail' && r.data.error === COLLECTIBLE_LIMIT)
		).toHaveLength(10);
		const count = await d1
			.prepare('select count(*) as n from collectibles where space_id = ? and deleted_at is null')
			.bind(spaceId)
			.first<{ n: number }>();
		expect(count!.n).toBe(MAX_COLLECTIBLES_PER_SPACE);
	});

	it('a create refused at the cap deletes the photo it had already written', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		await fill(spaceId, MAX_COLLECTIBLES_PER_SPACE);
		expect(await act(a, 'create', { form: ITEM, file: photoJpeg() })).toMatchObject({
			kind: 'fail',
			status: 409
		});
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
		expect((await outbox()).filter((o) => o.key.startsWith(`spaces/${spaceId}/`))).toEqual([]);
	});

	it('the collectibles cap is its own: 300 belongings do not block a collectible', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const now = Date.now();
		await d1.batch(
			Array.from({ length: 300 }, (_, i) =>
				d1
					.prepare(
						`insert into belongings (id, space_id, name, purchase_price_minor, currency, purchased_on,
						created_at, updated_at, seq) values (?, ?, ?, 100, 'IDR', '2024-01-01', ?, ?, 1)`
					)
					.bind(crypto.randomUUID(), spaceId, `Isi ${i}`, now, now)
			)
		);
		expect(await act(a, 'create', { form: ITEM })).toMatchObject({ kind: 'ok' });
	});
});

describe('account deletion', () => {
	it('purges the personal space’s collectibles and photos; a shared space’s stay for the others', async () => {
		const leaving = await person('Pergi');
		const other = await person('Tinggal');
		const personal = await spaceOf(leaving);
		await create(leaving);
		// A belonging with a photo too: both photo tables are released by the same purge.
		await run(async () =>
			(barang.actions as Record<string, Action>).create!(
				await ev(leaving, {
					path: '/barang',
					routeId: '/(app)/barang',
					form: { name: 'Laptop', purchasePrice: '1.000.000', purchasedOn: '2024-01-01' },
					file: photoJpeg()
				})
			)
		);
		const sharedId = (await createSharedSpace(db, other.user.id, 'Rumah', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId: sharedId, userId: other.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, leaving.user.id, Date.now());
		await run(async () =>
			(page.actions as Record<string, Action>).create!(
				await ev(leaving, { form: ITEM, file: photoJpeg(), spaceCookie: sharedId })
			)
		);
		expect(await objectsUnder(`spaces/${personal}/collectibles/`)).toHaveLength(1);
		expect(await objectsUnder(`spaces/${personal}/belongings/`)).toHaveLength(1);
		expect(await objectsUnder(`spaces/${sharedId}/`)).toHaveLength(1);

		const proof = await signInWithPassword(db, leaving.user.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof');
		expect(await deleteAccount(db, leaving.user.id, proof.hash)).toBe(true);
		const personalRows = await d1
			.prepare('select count(*) as n from collectibles where space_id = ?')
			.bind(personal)
			.first<{ n: number }>();
		expect(personalRows!.n).toBe(0);
		expect(
			(await outbox()).filter((o) => o.key.startsWith(`spaces/${personal}/`)).map((o) => o.key)
		).toHaveLength(2);
		await sweepSoon(binding as never, db, Date.now());
		expect(await objectsUnder(`spaces/${personal}/`)).toEqual([]);
		expect((await outbox()).some((o) => o.key.startsWith(`spaces/${personal}/`))).toBe(false);
		const sharedItems = (await items(other, sharedId)).items;
		expect(sharedItems).toHaveLength(1);
		expect(await objectsUnder(`spaces/${sharedId}/`)).toHaveLength(1);
		expect(status(await getPhoto(other, sharedItems[0]!.id))).toBe(200);
	});
});

describe('loaders log only an error label', () => {
	it('a failing list shows the error state and logs no query, message or space id', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		await d1.prepare('alter table collectibles rename to collectibles_hidden').run();
		try {
			const r = await load(a);
			expect(r.kind === 'ok' && (r.value as { loadError: unknown }).loadError).toBeTruthy();
			expect(await kekayaanOf(a)).toEqual({ totals: [], failed: true });
		} finally {
			await d1.prepare('alter table collectibles_hidden rename to collectibles').run();
		}
		const text = JSON.stringify(logged.mock.calls);
		logged.mockRestore();
		expect(text).toContain('koleksi: list failed');
		expect(text).not.toMatch(/no such table|select|collectibles_hidden/i);
		expect(text).not.toContain(spaceId);
	});
});
