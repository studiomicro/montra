import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import {
	BELONGING_CHANGED,
	BELONGING_LIMIT,
	BELONGING_NOT_FOUND,
	PURCHASED_ON_INVALID
} from '#lib/server/belongings/messages';
import { MAX_BELONGINGS_PER_SPACE } from '#lib/server/belongings/repo';
import { COLLECTIBLE_DEMO_READONLY } from '#lib/server/collectibles/messages';
import { getDb, type Db } from '#lib/server/db';
import {
	PHOTO_HEIF,
	PHOTO_NOT_IMAGE,
	PHOTO_TOO_LARGE,
	PHOTO_UNREADABLE,
	PHOTO_UPLOAD_FAILED
} from '#lib/server/photos/messages';
import { sweepFileDeletions, sweepSoon, UPLOAD_GRACE_MS } from '#lib/server/photos/store';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { estimatedValueMinor } from '#lib/shared/belongings';
import { wibTodayString } from '#lib/shared/dates';
import type { JobMessage } from '#lib/shared/jobs';
import { PHOTO_MAX_BYTES } from '#lib/shared/photos';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { bytes, has, jpeg, png } from '../helpers/images';

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

const page = await import('../../src/routes/(app)/barang/+page.server');
const photoRoute = await import('../../src/routes/(app)/barang/[id]/foto/+server');
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
	const email = `barang${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name, createdAt: 0 } };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An event for /barang; `multipart` builds a real multipart body (with a file) like a browser form. */
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
	const url = `http://localhost${opts.path ?? '/barang'}`;
	const { event } = fakeEvent({
		url,
		routeId: opts.routeId ?? '/(app)/barang',
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

const today = wibTodayString();
const ITEM = { name: 'Laptop kerja', purchasePrice: '15.000.000', purchasedOn: '2024-10-08' };
const photoJpeg = () => ({
	bytes: jpeg({ orientation: 6 }),
	name: 'IMG_0001.jpg',
	type: 'image/jpeg'
});

const act = (who: Person, name: string, opts: Parameters<typeof ev>[1]) =>
	run(async () => (page.actions as Record<string, Action>)[name]!(await ev(who, opts)));
const load = (who: Person, spaceCookie?: string) =>
	run(async () => page.load(await ev(who, { spaceCookie })));
async function items(who: Person, spaceCookie?: string) {
	const r = await load(who, spaceCookie);
	if (r.kind !== 'ok') throw new Error(`load: ${JSON.stringify(r)}`);
	return r.value as unknown as {
		items: Item[];
		totals: { currency: string; totalMinor: number | null; estimated: boolean }[];
	};
}
type Item = {
	id: string;
	name: string;
	updatedAt: number;
	hasPhoto: boolean;
	valueMinor: number;
	estimated: boolean;
	currentValueMinor: number | null;
	isDemo: boolean;
};
const getPhoto = (who: Person, id: string, headers?: Record<string, string>) =>
	run(async () => {
		const res = (await photoRoute.GET(
			await ev(who, {
				path: `/barang/${id}/foto`,
				routeId: '/(app)/barang/[id]/foto',
				params: { id },
				headers
			})
		)) as Response;
		return res;
	});
const row = async (id: string) =>
	(await d1.prepare('select * from belongings where id = ?').bind(id).first()) as Record<
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
	const list = (await items(who)).items;
	return list[0]!;
}

describe('create, list and the estimate', () => {
	it('shows the estimate (labelled) without an own figure, and the own figure when set', async () => {
		const a = await person();
		await act(a, 'create', { form: ITEM });
		await act(a, 'create', {
			form: { ...ITEM, name: 'Motor', currentValue: '9.000.000', purchasedOn: '2020-01-01' }
		});
		const data = await items(a);
		const laptop = data.items.find((i) => i.name === 'Laptop kerja')!;
		const motor = data.items.find((i) => i.name === 'Motor')!;
		expect(laptop).toMatchObject({
			estimated: true,
			valueMinor: estimatedValueMinor(1_500_000_000, '2024-10-08', today)
		});
		expect(motor).toMatchObject({ estimated: false, valueMinor: 900_000_000 });
		// The total is the sum of exactly the listed values.
		expect(data.totals).toEqual([
			{ currency: 'IDR', totalMinor: laptop.valueMinor + motor.valueMinor, estimated: true }
		]);
		// /kekayaan shows the same total.
		const k = await run(async () =>
			kekayaan.load(await ev(a, { path: '/kekayaan', routeId: '/(app)/kekayaan' }))
		);
		expect(k.kind === 'ok' && (k.value as { belongings: unknown }).belongings).toEqual({
			totals: data.totals,
			failed: false
		});
	});

	it('refuses a future purchase date, a decimal price and an over-long name, echoing the values', async () => {
		const a = await person();
		const future = await act(a, 'create', { form: { ...ITEM, purchasedOn: '2099-01-01' } });
		expect(future).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { purchasedOn: PURCHASED_ON_INVALID } }
		});
		const bad = await act(a, 'create', {
			form: { ...ITEM, purchasePrice: '12,50', name: 'x'.repeat(81) }
		});
		expect(bad.kind === 'fail' && Object.keys(bad.data.errors as object).sort()).toEqual([
			'name',
			'purchasePriceMinor'
		]);
		expect((await items(a)).items).toEqual([]);
	});
});

describe('photo upload', () => {
	it('stores a sanitized JPEG under a space-scoped random key and serves it to a member', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a);
		expect(item.hasPhoto).toBe(true);
		const stored = await row(item.id);
		const key = stored!.photo_key as string;
		expect(key).toMatch(
			new RegExp(
				`^spaces/${spaceId}/belongings/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$`
			)
		);
		expect(key).not.toContain('IMG_0001');
		expect(stored!.photo_type).toBe('image/jpeg');
		// The reservation was cleared in the same batch.
		expect((await outbox()).map((o) => o.key)).not.toContain(key);
		// EXIF GPS is gone from the stored object.
		const object = new Uint8Array(await (await realFiles.get(key))!.arrayBuffer());
		expect(has(object, 'GPSLAT')).toBe(false);
		expect(has(object, '106.8456')).toBe(false);

		const res = await getPhoto(a, item.id);
		expect(res.kind).toBe('ok');
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
		// Revalidation: the same ETag answers 304 without a body.
		const etag = response.headers.get('etag')!;
		const again = await getPhoto(a, item.id, { 'if-none-match': etag });
		expect(((again as { value: unknown }).value as Response).status).toBe(304);
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
		['HEIC', bytes('\0\0\0\x18ftypheic\0\0\0\0mif1heic'), 'x.heic', 'image/heic', PHOTO_HEIF],
		['GIF', bytes('GIF89a\x01\0\x01\0\0\0\0;'), 'x.gif', 'image/gif', PHOTO_NOT_IMAGE],
		['PDF', bytes('%PDF-1.7\n%\xe2\xe3\n1 0 obj'), 'x.pdf', 'application/pdf', PHOTO_NOT_IMAGE],
		[
			'JPEG magic bytes + HTML (polyglot)',
			bytes([0xff, 0xd8, 0xff], '<html><script>alert(1)</script>'),
			'x.jpg',
			'image/jpeg',
			PHOTO_UNREADABLE
		],
		['PNG named .png sent as text/html', png(), 'x.png', 'text/html', null]
	])('%s: refused or accepted by its bytes only', async (_label, data, name, type, refusal) => {
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

	it('refuses an oversized photo with a clear message and writes nothing', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
		big.set(jpeg());
		const r = await act(a, 'create', {
			form: ITEM,
			file: { bytes: big, name: 'big.jpg', type: 'image/jpeg' }
		});
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { photo: PHOTO_TOO_LARGE } }
		});
		// A body announced past the cap is refused before it is read.
		const announced = await act(a, 'create', {
			form: ITEM,
			headers: { 'content-length': String(PHOTO_MAX_BYTES * 2) }
		});
		expect(announced).toMatchObject({
			kind: 'fail',
			status: 413,
			data: { error: PHOTO_TOO_LARGE }
		});
		expect((await items(a)).items).toEqual([]);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
	});

	it('an R2 outage on upload leaves no row and only a reservation the sweep clears', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		fault.put = true;
		const r = await act(a, 'create', { form: ITEM, file: photoJpeg() });
		expect(r).toMatchObject({
			kind: 'fail',
			status: 503,
			data: { errors: { photo: PHOTO_UPLOAD_FAILED } }
		});
		expect((await items(a)).items).toEqual([]);
		const reserved = (await outbox()).filter((o) => o.key.startsWith(`spaces/${spaceId}/`));
		expect(reserved).toHaveLength(1);
		fault.put = false;
		// Not swept before the grace period, swept after it.
		await sweepFileDeletions(db, files, Date.now());
		expect((await outbox()).map((o) => o.key)).toContain(reserved[0]!.key);
		await sweepFileDeletions(db, files, Date.now() + UPLOAD_GRACE_MS + 1000);
		expect((await outbox()).map((o) => o.key)).not.toContain(reserved[0]!.key);
	});

	it('replacing a photo deletes the old object; a stale replace deletes the new one and changes nothing', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a);
		const oldKey = (await row(item.id))!.photo_key as string;
		const replaced = await act(a, 'update', {
			form: { ...ITEM, belongingId: item.id, updatedAt: String(item.updatedAt) },
			file: { bytes: png(), name: 'b.png', type: 'image/png' }
		});
		expect(replaced).toMatchObject({ kind: 'ok' });
		const after = (await row(item.id))!;
		expect(after.photo_type).toBe('image/png');
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([after.photo_key]);
		expect(oldKey).not.toBe(after.photo_key);
		// The old form again (stale): refused, and its freshly uploaded object is removed.
		const stale = await act(a, 'update', {
			form: { ...ITEM, belongingId: item.id, updatedAt: String(item.updatedAt) },
			file: photoJpeg()
		});
		expect(stale).toMatchObject({ kind: 'fail', status: 409, data: { error: BELONGING_CHANGED } });
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([after.photo_key]);
		expect((await row(item.id))!.photo_key).toBe(after.photo_key);
	});

	it('"Hapus foto" removes the photo and its object', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a);
		const r = await act(a, 'update', {
			form: { ...ITEM, belongingId: item.id, updatedAt: String(item.updatedAt), removePhoto: 'on' }
		});
		expect(r).toMatchObject({ kind: 'ok' });
		expect((await row(item.id))!.photo_key).toBeNull();
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
		expect((await getPhoto(a, item.id)).kind).toBe('error');
	});
});

describe('deleting (archive)', () => {
	it('leaves a content-free tombstone, deletes the object, and the photo route answers 404', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a, { ...ITEM, note: 'Garansi sampai 2026' });
		const r = await act(a, 'archive', {
			form: { belongingId: item.id, updatedAt: String(item.updatedAt) }
		});
		expect(r).toMatchObject({ kind: 'ok', value: { saved: 'archived' } });
		const tomb = (await row(item.id))!;
		expect(tomb).toMatchObject({
			name: null,
			purchase_price_minor: null,
			purchased_on: null,
			current_value_minor: null,
			photo_key: null,
			photo_type: null,
			note: null,
			created_at: null
		});
		expect(tomb.deleted_at).not.toBeNull();
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
		expect(await outbox()).toEqual([]);
		expect(await getPhoto(a, item.id)).toEqual({
			kind: 'error',
			status: 404,
			body: { message: 'Not found', status: 404 }
		});
		expect((await items(a)).items).toEqual([]);
	});

	it('when R2 delete fails the key stays in the outbox, a retry is queued, and the sweep finishes it', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const item = await create(a);
		const key = (await row(item.id))!.photo_key as string;
		fault.delete = true;
		const r = await act(a, 'archive', {
			form: { belongingId: item.id, updatedAt: String(item.updatedAt) }
		});
		expect(r).toMatchObject({ kind: 'ok' });
		expect((await row(item.id))!.photo_key).toBeNull();
		expect(await getPhoto(a, item.id)).toMatchObject({ kind: 'error', status: 404 });
		expect(await outbox()).toMatchObject([{ key, attempts: 1 }]);
		expect(queued).toEqual([{ type: 'file_sweep' }]);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([key]);
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
	const asResponse = (r: Awaited<ReturnType<typeof getPhoto>>) =>
		r.kind === 'ok' ? (r.value as unknown as Response).status : r;

	it('a member sees the photo; a stranger and a removed member get the unknown-id answer', async () => {
		const { owner, member, spaceId, item } = await shared();
		expect(asResponse(await getPhoto(member, item.id))).toBe(200);
		const stranger = await person();
		const unknown = await getPhoto(stranger, '00000000-0000-4000-8000-000000000000');
		expect(unknown).toEqual({
			kind: 'error',
			status: 404,
			body: { message: 'Not found', status: 404 }
		});
		expect(await getPhoto(stranger, item.id)).toEqual(unknown);
		expect(await getPhoto(stranger, 'x'.repeat(500))).toEqual(unknown);
		const memberRow = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(
			db,
			{ spaceId, actorUserId: owner.user.id, memberId: memberRow.id },
			Date.now()
		);
		expect(await getPhoto(member, item.id)).toEqual(unknown);
	});

	it('a stranger cannot update or delete another space’s item (same answer as an unknown id)', async () => {
		const { spaceId, item } = await shared();
		const stranger = await person();
		const before = await row(item.id);
		const objects = await objectsUnder(`spaces/${spaceId}/`);
		const upd = await act(stranger, 'update', {
			form: { ...ITEM, name: 'Diambil', belongingId: item.id, updatedAt: String(item.updatedAt) },
			file: photoJpeg()
		});
		const del = await act(stranger, 'archive', {
			form: { belongingId: item.id, updatedAt: String(item.updatedAt) }
		});
		const unknown = await act(stranger, 'archive', {
			form: { belongingId: '00000000-0000-4000-8000-000000000000', updatedAt: '1' }
		});
		expect(upd).toEqual({ kind: 'fail', status: 404, data: { error: BELONGING_NOT_FOUND } });
		expect(del).toEqual(unknown);
		expect(await row(item.id)).toEqual(before);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual(objects);
		// The stranger's own upload attempt left no object behind in their own space either.
		expect(await objectsUnder(`spaces/${await spaceOf(stranger)}/`)).toEqual([]);
	});

	it('signed out: the page redirects and the photo route answers 404', async () => {
		const { item } = await shared();
		expect(await run(async () => page.load(await ev(null)))).toMatchObject({
			kind: 'redirect',
			location: '/masuk'
		});
		expect(
			await run(async () =>
				photoRoute.GET(
					await ev(null, {
						path: `/barang/${item.id}/foto`,
						routeId: '/(app)/barang/[id]/foto',
						params: { id: item.id }
					})
				)
			)
		).toMatchObject({ kind: 'error', status: 404 });
	});
});

describe('cap and concurrency', () => {
	it(`20 concurrent creates at ${MAX_BELONGINGS_PER_SPACE - 10} stop at exactly ${MAX_BELONGINGS_PER_SPACE}`, async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const now = Date.now();
		const fill = Array.from({ length: MAX_BELONGINGS_PER_SPACE - 10 }, (_, i) =>
			d1
				.prepare(
					`insert into belongings (id, space_id, name, purchase_price_minor, currency, purchased_on,
					created_at, updated_at, seq) values (?, ?, ?, 100, 'IDR', '2024-01-01', ?, ?, 1)`
				)
				.bind(crypto.randomUUID(), spaceId, `Isi ${i}`, now, now)
		);
		await d1.batch(fill);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => act(a, 'create', { form: ITEM }))
		);
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(10);
		expect(
			results.filter((r) => r.kind === 'fail' && r.data.error === BELONGING_LIMIT)
		).toHaveLength(10);
		const count = await d1
			.prepare('select count(*) as n from belongings where space_id = ? and deleted_at is null')
			.bind(spaceId)
			.first<{ n: number }>();
		expect(count!.n).toBe(MAX_BELONGINGS_PER_SPACE);
	});

	it('a create refused at the cap deletes the photo it had already written', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const now = Date.now();
		await d1.batch(
			Array.from({ length: MAX_BELONGINGS_PER_SPACE }, (_, i) =>
				d1
					.prepare(
						`insert into belongings (id, space_id, name, purchase_price_minor, currency, purchased_on,
						created_at, updated_at, seq) values (?, ?, ?, 100, 'IDR', '2024-01-01', ?, ?, 1)`
					)
					.bind(crypto.randomUUID(), spaceId, `Isi ${i}`, now, now)
			)
		);
		const r = await act(a, 'create', { form: ITEM, file: photoJpeg() });
		expect(r).toMatchObject({ kind: 'fail', status: 409 });
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
		expect((await outbox()).filter((o) => o.key.startsWith(`spaces/${spaceId}/`))).toEqual([]);
	});
});

describe('account deletion', () => {
	it('purges the personal space’s items and photos; a shared space’s items stay for the others', async () => {
		const leaving = await person('Pergi');
		const other = await person('Tinggal');
		const personal = await spaceOf(leaving);
		await create(leaving);
		// A shared space owned by `other`, where the leaving user added an item with a photo.
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
		expect(await objectsUnder(`spaces/${personal}/`)).toHaveLength(1);
		expect(await objectsUnder(`spaces/${sharedId}/`)).toHaveLength(1);

		const proof = await signInWithPassword(db, leaving.user.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof');
		expect(await deleteAccount(db, leaving.user.id, proof.hash)).toBe(true);
		const personalRows = await d1
			.prepare('select count(*) as n from belongings where space_id = ?')
			.bind(personal)
			.first<{ n: number }>();
		expect(personalRows!.n).toBe(0);
		// The photo key waits in the outbox until the sweep that the account action runs.
		expect((await outbox()).some((o) => o.key.startsWith(`spaces/${personal}/`))).toBe(true);
		await sweepSoon(binding as never, db, Date.now());
		expect(await objectsUnder(`spaces/${personal}/`)).toEqual([]);
		expect((await outbox()).some((o) => o.key.startsWith(`spaces/${personal}/`))).toBe(false);
		// The shared space keeps its item and photo for the remaining member.
		const sharedItems = (await items(other, sharedId)).items;
		expect(sharedItems).toHaveLength(1);
		expect(await objectsUnder(`spaces/${sharedId}/`)).toHaveLength(1);
		expect(asStatus(await getPhoto(other, sharedItems[0]!.id))).toBe(200);
	});
});

const asStatus = (r: Awaited<ReturnType<typeof getPhoto>>) =>
	r.kind === 'ok' ? (r.value as unknown as Response).status : r;

describe('L4: loaders log only an error label', () => {
	it('a failing list shows the error state and logs no query, message or space id', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		await d1.prepare('alter table belongings rename to belongings_hidden').run();
		try {
			const r = await load(a);
			expect(r.kind === 'ok' && (r.value as { loadError: unknown }).loadError).toBeTruthy();
			const k = await run(async () =>
				kekayaan.load(await ev(a, { path: '/kekayaan', routeId: '/(app)/kekayaan' }))
			);
			expect(k.kind === 'ok' && (k.value as { belongings: unknown }).belongings).toEqual({
				totals: [],
				failed: true
			});
		} finally {
			await d1.prepare('alter table belongings_hidden rename to belongings').run();
		}
		const text = JSON.stringify(logged.mock.calls);
		logged.mockRestore();
		expect(text).toContain('barang: list failed');
		expect(text).not.toMatch(/no such table|select|belongings_hidden/i);
		expect(text).not.toContain(spaceId);
	});
});

describe('R15: a motion-photo / Ultra HDR shaped upload is stored up to EOI', () => {
	it('uploads, and the stored object ends at EOI without the trailing JPEG and MP4', async () => {
		const a = await person();
		const trailer = bytes(jpeg(), [0, 0, 0, 0x18], 'ftypmp42', new Uint8Array(512 * 1024));
		const r = await act(a, 'create', {
			form: ITEM,
			file: { bytes: bytes(jpeg(), trailer), name: 'PXL_MP.jpg', type: 'image/jpeg' }
		});
		expect(r).toMatchObject({ kind: 'ok' });
		const item = (await items(a)).items[0]!;
		const key = (await row(item.id))!.photo_key as string;
		const stored = new Uint8Array(await (await realFiles.get(key))!.arrayBuffer());
		expect(Array.from(stored.subarray(-2))).toEqual([0xff, 0xd9]);
		expect(has(stored, 'ftyp')).toBe(false);
		expect(stored.length).toBeLessThan(1024);
	});
});

describe('Data demo rows (migration 0025)', () => {
	async function demoBelonging(spaceId: string) {
		const id = crypto.randomUUID();
		const now = Date.now();
		await d1
			.prepare(
				`insert into belongings (id, space_id, name, purchase_price_minor, currency, purchased_on,
				current_value_minor, is_demo, created_at, updated_at, seq)
				values (?, ?, 'Kamera demo', 900000000, 'IDR', '2024-01-01', 700000000, 1, ?, ?, 1)`
			)
			.bind(id, spaceId, now + 1, now)
			.run();
		return id;
	}

	it('a form-created item is real; a demo item is listed and badged but left out of both totals', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const real = await create(a, { ...ITEM, currentValue: '5.000.000' });
		expect((await row(real.id))!.is_demo).toBe(0);
		const demoId = await demoBelonging(spaceId);
		const list = await items(a);
		expect(list.items.find((i) => i.id === demoId)).toMatchObject({
			isDemo: true,
			valueMinor: 7_000_000_00
		});
		expect(list.items.find((i) => i.id === real.id)?.isDemo).toBe(false);
		expect(list.totals).toEqual([{ currency: 'IDR', totalMinor: 5_000_000_00, estimated: false }]);
		const k = await run(async () =>
			kekayaan.load(await ev(a, { path: '/kekayaan', routeId: '/(app)/kekayaan' }))
		);
		expect(k).toMatchObject({
			kind: 'ok',
			value: {
				belongings: {
					totals: [{ currency: 'IDR', totalMinor: 5_000_000_00, estimated: false }],
					failed: false
				}
			}
		});
	});

	it('edit (with or without a photo) and delete are refused; the row and the bucket are unchanged', async () => {
		const a = await person();
		const spaceId = await spaceOf(a);
		const id = await demoBelonging(spaceId);
		const before = await row(id);
		const updatedAt = String(before!.updated_at);
		const refusal = { kind: 'fail', status: 400, data: { error: COLLECTIBLE_DEMO_READONLY } };
		const form = { ...ITEM, belongingId: id, updatedAt };
		expect(await act(a, 'update', { form })).toEqual(refusal);
		expect(await act(a, 'update', { form, file: photoJpeg() })).toEqual(refusal);
		expect(await act(a, 'archive', { form: { belongingId: id, updatedAt } })).toEqual(refusal);
		expect(await act(a, 'archive', { form: { belongingId: id, updatedAt: '1' } })).toEqual(refusal);
		expect(await row(id)).toEqual(before);
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
	});
});
