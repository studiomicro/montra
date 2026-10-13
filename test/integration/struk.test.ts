import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveKey } from '#lib/server/ai-keys/repo';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { exportAccount } from '#lib/server/export/account-export';
import { sanitizeImage } from '#lib/server/photos/image';
import { PHOTO_NOT_IMAGE } from '#lib/server/photos/messages';
import { sweepFileDeletions, sweepSoon } from '#lib/server/photos/store';
import { receiptKeyPrefix } from '#lib/server/receipts/dedupe';
import {
	RECEIPT_ALREADY_SAVED,
	RECEIPT_READ_FIRST,
	RECEIPT_NO_KEY,
	RECEIPT_NOT_A_RECEIPT,
	RECEIPT_NOT_CONFIGURED,
	RECEIPT_RATE_LIMITED,
	RECEIPT_SPLIT_DISCOUNT,
	RECEIPT_TOTAL_MISMATCH,
	RECEIPT_UNREADABLE
} from '#lib/server/receipts/messages';
import { parseReceiptForm, saveReceiptTransactions } from '#lib/server/receipts/save';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { createTransaction, deleteTransaction, MANUAL } from '#lib/server/transactions/repo';
import { WALLET_NOT_FOUND } from '#lib/server/wallets/messages';
import { createWallet } from '#lib/server/wallets/repo';
import { AI_KEY_TEST_LABELS } from '#lib/shared/ai-keys';
import { base64urlEncode } from '#lib/shared/base64url';
import { createTranslator } from '#lib/shared/i18n';
import type { JobMessage } from '#lib/shared/jobs';
import { RECEIPT_READS_PER_WINDOW, type ReceiptFormValues } from '#lib/shared/receipts';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { bytes, jpeg } from '../helpers/images';
import { readZip, textOf } from '../helpers/zip';
import {
	errorResponse,
	messagesResponse,
	receiptAnswer,
	type ReceiptFixture
} from '../helpers/receipts';

// FN-15 /riwayat/struk, /riwayat/[id]/foto and the photo-carrying /riwayat/baru create against a local D1 and a
// local R2 bucket. The provider call is the real readReceiptImage with an injected fetch double: no test here
// reaches the network, the AI Gateway or Anthropic.

const { fakeFetch } = vi.hoisted(() => ({
	fakeFetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
}));
vi.mock('#lib/server/receipts/anthropic', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/receipts/anthropic')>();
	return {
		...actual,
		readReceiptImage: (
			env: Parameters<typeof actual.readReceiptImage>[0],
			key: string,
			image: Parameters<typeof actual.readReceiptImage>[2]
		) => actual.readReceiptImage(env, key, image, fakeFetch as unknown as typeof fetch)
	};
});

const ENC = base64urlEncode(new Uint8Array(32).fill(21));
const queued: JobMessage[] = [];
const binding: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const page = await import('../../src/routes/(app)/riwayat/struk/+page.server');
const baru = await import('../../src/routes/(app)/riwayat/baru/+page.server');
const photoRoute = await import('../../src/routes/(app)/riwayat/[id]/foto/+server');

let d1: D1Database;
let db: Db;
let files: R2Bucket;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

function configure(o: { gateway?: boolean } = {}) {
	for (const k of Object.keys(binding)) delete binding[k];
	binding.DB = d1;
	binding.FILES = files;
	binding.JOBS_QUEUE = {
		send: async (body: JobMessage) => {
			queued.push(body);
		}
	};
	binding.AI_KEYS_ENCRYPTION_KEY = ENC;
	if (o.gateway !== false) {
		binding.AI_GATEWAY_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
		binding.AI_GATEWAY_ID = 'montra-test';
	}
}

beforeAll(async () => {
	const local = await openLocalD1();
	({ db: d1, dispose } = local);
	files = local.env.FILES;
	db = getDb(d1);
});
afterAll(() => dispose());
beforeEach(() => {
	configure();
	queued.length = 0;
	fakeFetch.mockReset();
	fakeFetch.mockImplementation(async () => messagesResponse(receiptAnswer('clean')));
});

let n = 0;
async function person(o: { key?: boolean } = {}) {
	const email = `struk${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const user = { id: r.userId, email, name: 'Uji', createdAt: 0 };
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope = { spaceId: space.id, userId: r.userId };
	const wallet = await createWallet(
		db,
		scope,
		{
			name: 'GoPay',
			type: 'e_wallet',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		Date.now()
	);
	if (!wallet.ok) throw new Error('wallet failed');
	await ensurePresetCategories(db, space.id);
	if (o.key !== false)
		await saveKey(
			db,
			r.userId,
			'anthropic',
			`sk-ant-api03-synthetic-${String(n).padStart(4, '0')}-AbCdEfGh`,
			binding as never,
			Date.now()
		);
	return { user, scope, walletId: wallet.id };
}
type Person = Awaited<ReturnType<typeof person>>;

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

/** A request event; `fields` and `photo` build a real multipart body like a browser form. */
async function ev(
	who: Person | null,
	o: {
		path?: string;
		routeId?: string;
		params?: Record<string, string>;
		fields?: [string, string][];
		photo?: Uint8Array;
		spaceCookie?: string;
	} = {}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, o.spaceCookie) : null;
	const url = `http://localhost${o.path ?? '/riwayat/struk'}`;
	const { event } = fakeEvent({
		url,
		routeId: o.routeId ?? '/(app)/riwayat/struk',
		db,
		user: who?.user ?? null,
		space,
		params: o.params
	});
	if (o.fields || o.photo) {
		const body = new FormData();
		for (const [k, v] of o.fields ?? []) body.append(k, v);
		if (o.photo)
			body.set('photo', new File([o.photo as BlobPart], 'struk.jpg', { type: 'image/jpeg' }));
		(event as { request: Request }).request = new Request(url, { method: 'POST', body });
	}
	return event as never;
}

type Action = (event: never) => unknown;
const act = (who: Person | null, name: 'read' | 'save', o: Parameters<typeof ev>[1] = {}) =>
	run(async () => (page.actions as Record<string, Action>)[name]!(await ev(who, o)));
const load = (who: Person | null) => run(async () => page.load(await ev(who)));

/** A distinct, valid (sanitisable) receipt photo per call: the dedupe key follows the bytes. */
let shot = 0;
const receiptPhoto = () => jpeg({ width: 16 + (++shot % 200), height: 24 });
const read = (who: Person, photo: Uint8Array) => act(who, 'read', { photo });

/** The review form's fields as a browser posts them. */
function fields(values: ReceiptFormValues): [string, string][] {
	const out: [string, string][] = [
		['mode', values.mode],
		['shop', values.shop],
		['occurredOn', values.occurredOn],
		['walletId', values.walletId],
		['categoryId', values.categoryId],
		['paymentMethod', values.paymentMethod],
		['count', String(values.items.length)],
		['tax', values.tax],
		['service', values.service],
		['discount', values.discount],
		['total', values.total]
	];
	values.items.forEach((item, i) =>
		out.push(
			[`itemName.${i}`, item.name],
			[`itemAmount.${i}`, item.amount],
			[`itemCategory.${i}`, item.categoryId]
		)
	);
	if (values.keepPhoto) out.push(['keepPhoto', 'on']);
	if (values.acceptMismatch) out.push(['acceptMismatch', 'on']);
	if (values.readTicket) out.push(['readTicket', values.readTicket]);
	return out;
}

/** Reads `photo` with the fixture answer and returns the review values the page would show. */
async function reviewOf(who: Person, photo: Uint8Array, fixture: ReceiptFixture = 'clean') {
	fakeFetch.mockImplementation(async () => messagesResponse(receiptAnswer(fixture)));
	const r = await read(who, photo);
	if (r.kind !== 'ok') throw new Error(`read: ${JSON.stringify(r)}`);
	return r.value.review as {
		values: ReceiptFormValues;
		dateCheck: string;
		duplicates: string[];
		alreadySaved: boolean;
	};
}

async function categoryId(who: Person, tile: string) {
	const all = await listCategories(db, who.scope.spaceId);
	return all.find((c) => c.isPreset && c.tileKey === tile)!.id;
}

const rowsOf = async (spaceId: string) =>
	(
		await d1
			.prepare(
				`select id, type, amount_minor, currency, title, note, occurred_on, source, dedupe_key, category_id,
					wallet_id, payment_method, photo_key, photo_type, deleted_at
				from transactions where space_id = ? and source = 'receipt' order by dedupe_key`
			)
			.bind(spaceId)
			.all<Record<string, unknown>>()
	).results;
const objectsUnder = async (prefix: string) =>
	(await files.list({ prefix })).objects.map((o) => o.key);
const prefixOf = async (photo: Uint8Array) => {
	const image = sanitizeImage(photo);
	if (!image.ok) throw new Error('fixture photo does not sanitise');
	return receiptKeyPrefix(image.bytes);
};
const getPhoto = (who: Person, id: string) =>
	run(async () => {
		const res = (await photoRoute.GET(
			await ev(who, {
				path: `/riwayat/${id}/foto`,
				routeId: '/(app)/riwayat/[id]/foto',
				params: { id }
			})
		)) as Response;
		return { status: res.status, type: res.headers.get('content-type') };
	});

describe('gating and access', () => {
	it('load says whether the gateway is configured and the user has a key (never the key)', async () => {
		const withKey = await person();
		const noKey = await person({ key: false });
		const a = await load(withKey);
		expect(a).toMatchObject({ kind: 'ok', value: { configured: true, hasKey: true } });
		expect(JSON.stringify(a)).not.toMatch(/sk-ant/);
		expect(await load(noKey)).toMatchObject({ kind: 'ok', value: { hasKey: false } });
		configure({ gateway: false });
		expect(await load(withKey)).toMatchObject({
			kind: 'ok',
			value: { configured: false, hasKey: false }
		});
	});

	it('signed out: load, read and save redirect to /masuk', async () => {
		const redirect = { kind: 'redirect', status: 303, location: '/masuk' };
		expect(await load(null)).toEqual(redirect);
		expect(await act(null, 'read', { photo: receiptPhoto() })).toEqual(redirect);
		expect(await act(null, 'save', { photo: receiptPhoto() })).toEqual(redirect);
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it('without a key or without the gateway nothing reaches the provider', async () => {
		const noKey = await person({ key: false });
		expect(await read(noKey, receiptPhoto())).toEqual({
			kind: 'fail',
			status: 400,
			data: { action: 'read', error: RECEIPT_NO_KEY, noKey: true }
		});
		const withKey = await person();
		configure({ gateway: false });
		expect(await read(withKey, receiptPhoto())).toMatchObject({
			kind: 'fail',
			status: 503,
			data: { error: RECEIPT_NOT_CONFIGURED }
		});
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it('a file that is not a JPEG/PNG/WebP, or a missing photo, is refused before any provider call', async () => {
		const p = await person();
		expect(await read(p, bytes('%PDF-1.7 not an image'))).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { error: PHOTO_NOT_IMAGE }
		});
		expect(await act(p, 'read', { fields: [['x', '1']] })).toMatchObject({
			kind: 'fail',
			status: 400
		});
		expect(fakeFetch).not.toHaveBeenCalled();
	});

	it(`the ${RECEIPT_READS_PER_WINDOW + 1}th read in the window is refused before the provider is called`, async () => {
		const p = await person();
		for (let i = 0; i < RECEIPT_READS_PER_WINDOW; i++)
			expect((await read(p, receiptPhoto())).kind).toBe('ok');
		expect(await read(p, receiptPhoto())).toMatchObject({
			kind: 'fail',
			status: 429,
			data: { error: RECEIPT_RATE_LIMITED }
		});
		expect(fakeFetch).toHaveBeenCalledTimes(RECEIPT_READS_PER_WINDOW);
		// Per user: another user still reads.
		expect((await read(await person(), receiptPhoto())).kind).toBe('ok');
	});
});

describe('read', () => {
	it('a clean read fills the review form: whole rupiah, the favourite IDR wallet, no banner data', async () => {
		const p = await person();
		const review = await reviewOf(p, receiptPhoto());
		expect(review.values).toMatchObject({
			mode: 'single',
			shop: 'Warung Contoh Sejahtera',
			occurredOn: '2026-10-08',
			walletId: p.walletId,
			paymentMethod: 'QRIS',
			tax: '5.100',
			total: '56.100',
			keepPhoto: true
		});
		expect(review.values.items.map((i) => [i.name, i.amount])).toEqual([
			['Nasi goreng', '25.000'],
			['Es teh manis', '8.000'],
			['Kopi susu', '18.000']
		]);
		expect(review.values.items[2]!.categoryId).toBe(await categoryId(p, 'kopi'));
		expect(review.duplicates).toEqual([]);
		expect(review.alreadySaved).toBe(false);
	});

	it.each([
		['not-a-receipt', 422, RECEIPT_NOT_A_RECEIPT],
		['invalid', 422, RECEIPT_UNREADABLE]
	] as const)('the "%s" answer → its own message', async (fixture, status, error) => {
		fakeFetch.mockImplementation(async () => messagesResponse(receiptAnswer(fixture)));
		expect(await read(await person(), receiptPhoto())).toEqual({
			kind: 'fail',
			status,
			data: { action: 'read', error }
		});
	});

	it.each([
		[401, 'authentication_error', AI_KEY_TEST_LABELS.invalid],
		[429, 'rate_limit_error', AI_KEY_TEST_LABELS.quota],
		[500, 'api_error', AI_KEY_TEST_LABELS.network]
	])('a provider %d → the FN-41 message', async (status, type, error) => {
		fakeFetch.mockImplementation(async () => errorResponse(status, type));
		const r = await read(await person(), receiptPhoto());
		expect(r).toMatchObject({ kind: 'fail', data: { action: 'read', error } });
		// Never the provider's body, the key or a stack in what the user sees.
		expect(JSON.stringify(r)).not.toMatch(/synthetic|sk-ant|Error:/);
	});

	it('flags "Mungkin sudah dicatat" for an amount already recorded on the date ±1 day', async () => {
		const p = await person();
		const input = {
			type: 'expense' as const,
			amountMinor: 2_500_000,
			currency: 'IDR',
			walletId: p.walletId,
			transferToWalletId: null,
			categoryId: await categoryId(p, 'makan'),
			title: 'Makan siang',
			note: null,
			occurredOn: '2026-10-07',
			occurredTime: null
		};
		expect((await createTransaction(db, p.scope, input, Date.now(), MANUAL)).ok).toBe(true);
		const far = { ...input, amountMinor: 800_000, occurredOn: '2026-10-01' };
		expect((await createTransaction(db, p.scope, far, Date.now(), MANUAL)).ok).toBe(true);
		const review = await reviewOf(p, receiptPhoto());
		expect(review.duplicates).toEqual(['item.0']);
	});
});

describe('save', () => {
	it('"Satu transaksi": one receipt row with the note, the dedupe key and the kept photo', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo);
		const values = { ...review.values, categoryId: await categoryId(p, 'makan') };
		const r = await act(p, 'save', { fields: fields(values), photo });
		expect(r).toMatchObject({ kind: 'ok', value: { saved: { count: 1, photo: true } } });
		const rows = await rowsOf(p.scope.spaceId);
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row).toMatchObject({
			type: 'expense',
			amount_minor: 5_610_000,
			currency: 'IDR',
			title: 'Warung Contoh Sejahtera',
			occurred_on: '2026-10-08',
			source: 'receipt',
			dedupe_key: `${await prefixOf(photo)}0`,
			wallet_id: p.walletId,
			payment_method: 'QRIS',
			photo_type: 'image/jpeg'
		});
		expect(String(row.note).split(' · ')).toEqual([
			'Nasi goreng Rp 25.000',
			'Es teh manis Rp 8.000',
			'Kopi susu Rp 18.000',
			'Pajak Rp 5.100',
			'Total Rp 56.100'
		]);
		expect(String(row.photo_key)).toMatch(new RegExp(`^spaces/${p.scope.spaceId}/receipts/`));
		expect(await objectsUnder(`spaces/${p.scope.spaceId}/receipts/`)).toEqual([row.photo_key]);
		// The reservation was dropped in the same batch: the sweep leaves the kept photo alone.
		await sweepFileDeletions(db, files, Date.now() + 24 * 60 * 60 * 1000);
		expect(await objectsUnder(`spaces/${p.scope.spaceId}/receipts/`)).toHaveLength(1);
		expect(await getPhoto(p, String(row.id))).toEqual({
			kind: 'ok',
			value: { status: 200, type: 'image/jpeg' }
		});
	});

	it('red team L3: no `receipt` row without a read of these very bytes by this user in this space', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo);
		const values = { ...review.values, categoryId: await categoryId(p, 'makan') };
		const readFirst = {
			kind: 'fail',
			status: 400,
			data: { action: 'save', error: RECEIPT_READ_FIRST }
		};
		// No ticket, a ticket of another photo, and this photo's ticket replayed by another user.
		expect(
			await act(p, 'save', { fields: fields({ ...values, readTicket: '' }), photo })
		).toMatchObject(readFirst);
		expect(await act(p, 'save', { fields: fields(values), photo: receiptPhoto() })).toMatchObject(
			readFirst
		);
		expect(await act(await person(), 'save', { fields: fields(values), photo })).toMatchObject(
			readFirst
		);
		expect(await rowsOf(p.scope.spaceId)).toEqual([]);
		expect(await objectsUnder(`spaces/${p.scope.spaceId}/receipts/`)).toEqual([]);
		// The refusal hands the ticket back with the values, so "Simpan" works once the form is fixed.
		const refused = await act(p, 'save', { fields: fields({ ...values, total: '' }), photo });
		expect(refused).toMatchObject({
			kind: 'fail',
			data: { values: { readTicket: values.readTicket } }
		});
		expect((await act(p, 'save', { fields: fields(values), photo })).kind).toBe('ok');
	});

	it('the same photo saved again ("Baca lagi" then Simpan) writes nothing; a deleted row is never recreated', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo);
		const values = { ...review.values, categoryId: await categoryId(p, 'makan') };
		expect((await act(p, 'save', { fields: fields(values), photo })).kind).toBe('ok');
		const again = await reviewOf(p, photo);
		expect(again.alreadySaved).toBe(true);
		expect(await act(p, 'save', { fields: fields(values), photo })).toMatchObject({
			kind: 'fail',
			status: 409,
			data: { error: RECEIPT_ALREADY_SAVED }
		});
		expect(await rowsOf(p.scope.spaceId)).toHaveLength(1);
		expect(await objectsUnder(`spaces/${p.scope.spaceId}/receipts/`)).toHaveLength(1);

		// Deleting the row releases its photo at once; the tombstone keeps the dedupe key.
		const [row] = await rowsOf(p.scope.spaceId);
		const updatedAt = (await d1
			.prepare('select updated_at as u from transactions where id = ?')
			.bind(row!.id)
			.first<{ u: number }>())!.u;
		expect(
			await deleteTransaction(db, p.scope, String(row!.id), updatedAt, Date.now(), binding as never)
		).toBe('ok');
		expect(await objectsUnder(`spaces/${p.scope.spaceId}/receipts/`)).toEqual([]);
		expect(await getPhoto(p, String(row!.id))).toMatchObject({ kind: 'error', status: 404 });
		expect(await act(p, 'save', { fields: fields(values), photo })).toMatchObject({
			kind: 'fail',
			status: 409
		});
		const after = await rowsOf(p.scope.spaceId);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ deleted_at: expect.any(Number), photo_key: null, note: null });
	});

	it('"Pisah per item": a row per item plus "Pajak & servis", adding up to the total; no photo when not kept', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo);
		const makan = await categoryId(p, 'makan');
		const values: ReceiptFormValues = {
			...review.values,
			mode: 'split',
			categoryId: makan,
			keepPhoto: false
		};
		const r = await act(p, 'save', { fields: fields(values), photo });
		expect(r).toMatchObject({ kind: 'ok', value: { saved: { count: 4, photo: false } } });
		const rows = await rowsOf(p.scope.spaceId);
		const prefix = await prefixOf(photo);
		expect(rows.map((row) => [row.dedupe_key, row.title, row.amount_minor])).toEqual([
			[`${prefix}0`, 'Nasi goreng', 2_500_000],
			[`${prefix}1`, 'Es teh manis', 800_000],
			[`${prefix}2`, 'Kopi susu', 1_800_000],
			[`${prefix}3`, 'Pajak & servis', 510_000]
		]);
		expect(rows.reduce((s, row) => s + Number(row.amount_minor), 0)).toBe(5_610_000);
		// "Kopi susu" kept its guessed preset; the others follow the receipt's category.
		expect(rows.map((row) => row.category_id)).toEqual([
			makan,
			makan,
			await categoryId(p, 'kopi'),
			makan
		]);
		expect(rows.every((row) => row.photo_key === null && row.payment_method === 'QRIS')).toBe(true);
		expect(await objectsUnder(`spaces/${p.scope.spaceId}/`)).toEqual([]);
	});

	it('the kept photo goes on the "Pajak & servis" row of a split', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo);
		const values = {
			...review.values,
			mode: 'split' as const,
			categoryId: await categoryId(p, 'makan')
		};
		expect((await act(p, 'save', { fields: fields(values), photo })).kind).toBe('ok');
		const rows = await rowsOf(p.scope.spaceId);
		expect(rows.map((row) => row.photo_key !== null)).toEqual([false, false, false, true]);
	});

	it('a discount larger than tax and service cannot be split, and saves as one transaction', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo, 'discount-heavy');
		const values = { ...review.values, categoryId: await categoryId(p, 'makan') };
		expect(review.values.discount).toBe('10.000');
		expect(
			await act(p, 'save', { fields: fields({ ...values, mode: 'split' }), photo })
		).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { form: RECEIPT_SPLIT_DISCOUNT } }
		});
		expect(await act(p, 'save', { fields: fields(values), photo })).toMatchObject({
			kind: 'ok',
			value: { saved: { count: 1 } }
		});
	});

	it('figures that do not add up need the user to accept them; the edited values are what is checked', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo, 'mismatch');
		const values = { ...review.values, categoryId: await categoryId(p, 'belanja-harian') };
		expect(await act(p, 'save', { fields: fields(values), photo })).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { form: RECEIPT_TOTAL_MISMATCH }, values: { total: '30.000' } }
		});
		// Corrected by the user: no acceptance needed.
		const fixed = { ...values, total: '27.500' };
		expect((await act(p, 'save', { fields: fields(fixed), photo })).kind).toBe('ok');
		expect((await rowsOf(p.scope.spaceId))[0]).toMatchObject({ amount_minor: 2_750_000 });
	});

	it('another space’s wallet or category is refused like an unknown one; nothing is written', async () => {
		const p = await person();
		const other = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo);
		const values = { ...review.values, categoryId: await categoryId(p, 'makan') };
		expect(
			await act(p, 'save', { fields: fields({ ...values, walletId: other.walletId }), photo })
		).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { walletId: WALLET_NOT_FOUND } }
		});
		const foreignCategory = await categoryId(other, 'makan');
		const r = await act(p, 'save', {
			fields: fields({ ...values, categoryId: foreignCategory }),
			photo
		});
		expect(r).toMatchObject({ kind: 'fail', status: 400 });
		expect(await rowsOf(p.scope.spaceId)).toEqual([]);
		expect(await rowsOf(other.scope.spaceId)).toEqual([]);
		expect(await objectsUnder(`spaces/${p.scope.spaceId}/`)).toEqual([]);
	});

	it('20 concurrent saves of the same receipt write its rows exactly once (guarded insert)', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo);
		const values = {
			...review.values,
			mode: 'split' as const,
			categoryId: await categoryId(p, 'makan')
		};
		const parsed = parseReceiptForm(values, createTranslator('id'));
		if (!parsed.ok) throw new Error('parse');
		const prefix = await prefixOf(photo);
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				saveReceiptTransactions(
					db,
					p.scope,
					parsed.draft,
					prefix,
					null,
					createTranslator('id'),
					Date.now(),
					'2026-10-09'
				)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => !r.ok && r.reason === 'already')).toHaveLength(19);
		expect(await rowsOf(p.scope.spaceId)).toHaveLength(4);
		// Through the action too: one success, the rest refused (busy or already saved), never a 500.
		const q = await person();
		const qPhoto = receiptPhoto();
		const qReview = await reviewOf(q, qPhoto);
		const qValues = { ...qReview.values, categoryId: await categoryId(q, 'makan') };
		const answers = await Promise.all(
			Array.from({ length: 20 }, () => act(q, 'save', { fields: fields(qValues), photo: qPhoto }))
		);
		expect(answers.filter((a) => a.kind === 'ok')).toHaveLength(1);
		for (const a of answers.filter((x) => x.kind !== 'ok'))
			expect(a.kind === 'fail' && [409, 503].includes(a.status)).toBe(true);
		expect(await rowsOf(q.scope.spaceId)).toHaveLength(1);
		expect(await objectsUnder(`spaces/${q.scope.spaceId}/receipts/`)).toHaveLength(1);
	});
});

describe('/riwayat/[id]/foto: one access rule', () => {
	it('a member sees the photo; a stranger, a removed member and an unknown id get the same 404', async () => {
		const owner = await person();
		const member = await person();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const wallet = await createWallet(
			db,
			{ spaceId, userId: owner.user.id },
			{
				name: 'Tunai',
				type: 'tunai',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: true,
				lastFour: null
			},
			Date.now()
		);
		if (!wallet.ok) throw new Error('wallet');
		await ensurePresetCategories(db, spaceId);
		const shared = { ...owner, scope: { spaceId, userId: owner.user.id }, walletId: wallet.id };
		const photo = receiptPhoto();
		fakeFetch.mockImplementation(async () => messagesResponse(receiptAnswer('clean')));
		const r = await act(shared, 'read', { photo, spaceCookie: spaceId });
		if (r.kind !== 'ok') throw new Error('read');
		const values = {
			...(r.value.review as { values: ReceiptFormValues }).values,
			categoryId: await categoryId(shared, 'makan')
		};
		expect(
			(await act(shared, 'save', { fields: fields(values), photo, spaceCookie: spaceId })).kind
		).toBe('ok');
		const [row] = await rowsOf(spaceId);
		const id = String(row!.id);
		expect(row!.wallet_id).toBe(wallet.id);

		expect(await getPhoto(member, id)).toMatchObject({ kind: 'ok', value: { status: 200 } });
		const stranger = await person();
		const unknown = await getPhoto(stranger, '00000000-0000-4000-8000-000000000000');
		expect(unknown).toEqual({
			kind: 'error',
			status: 404,
			body: { message: 'Not found', status: 404 }
		});
		expect(await getPhoto(stranger, id)).toEqual(unknown);
		expect(await getPhoto(stranger, 'x'.repeat(500))).toEqual(unknown);
		const memberRow = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(
			db,
			{ spaceId, actorUserId: owner.user.id, memberId: memberRow.id },
			Date.now()
		);
		expect(await getPhoto(member, id)).toEqual(unknown);
	});
});

describe('"Lampirkan fotonya saja" → /riwayat/baru', () => {
	const baruCreate = async (
		who: Person,
		fieldsList: [string, string][],
		photo?: Uint8Array,
		spaceCookie?: string
	) =>
		run(async () =>
			(baru.actions as Record<string, Action>).create!(
				await ev(who, {
					path: '/riwayat/baru',
					routeId: '/(app)/riwayat/baru',
					fields: fieldsList,
					photo,
					spaceCookie
				})
			)
		);

	it("red team L1: a clientId naming another member's existing row attaches nothing to it and keeps no upload", async () => {
		const owner = await person();
		const member = await person();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const wallet = await createWallet(
			db,
			{ spaceId, userId: owner.user.id },
			{
				name: 'Tunai',
				type: 'tunai',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: true,
				lastFour: null
			},
			Date.now()
		);
		if (!wallet.ok) throw new Error('wallet');
		await ensurePresetCategories(db, spaceId);
		const shared = { ...owner, scope: { spaceId, userId: owner.user.id }, walletId: wallet.id };
		const form = async (title: string, clientId: string): Promise<[string, string][]> => [
			['type', 'expense'],
			['amount', '10.000'],
			['walletId', wallet.id],
			['categoryId', await categoryId(shared, 'makan')],
			['title', title],
			['occurredOn', '2026-10-08'],
			['clientId', clientId]
		];
		const victimId = crypto.randomUUID();
		expect(
			await baruCreate(owner, await form('Milik pemilik', victimId), undefined, spaceId)
		).toMatchObject({
			kind: 'redirect'
		});
		const before = await d1
			.prepare('select updated_at, seq, photo_key from transactions where id = ?')
			.bind(victimId)
			.first<Record<string, unknown>>();
		expect(before).toMatchObject({ photo_key: null });
		// The member resends the owner's row id as their own clientId, with a photo.
		await baruCreate(member, await form('Bukan milikku', victimId), receiptPhoto(), spaceId);
		const after = await d1
			.prepare('select updated_at, seq, photo_key, title from transactions where id = ?')
			.bind(victimId)
			.first<Record<string, unknown>>();
		expect(after).toEqual({ ...before, title: 'Milik pemilik' });
		expect(await objectsUnder(`spaces/${spaceId}/`)).toEqual([]);
		expect(
			await d1
				.prepare('select count(*) as n from file_deletions where key like ?')
				.bind(`spaces/${spaceId}/%`)
				.first<{ n: number }>()
		).toEqual({ n: 0 });
	});

	it('a manual entry with the carried photo keeps it; a non-image is refused and writes nothing', async () => {
		const p = await person();
		const form: [string, string][] = [
			['type', 'expense'],
			['amount', '42.000'],
			['walletId', p.walletId],
			['categoryId', await categoryId(p, 'makan')],
			['title', 'Makan malam'],
			['occurredOn', '2026-10-08']
		];
		expect(await baruCreate(p, form, bytes('not an image at all'))).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { error: PHOTO_NOT_IMAGE }
		});
		expect(await baruCreate(p, form, receiptPhoto())).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/riwayat?saved=created'
		});
		const row = await d1
			.prepare(
				'select id, source, photo_key, photo_type, amount_minor from transactions where space_id = ? and title = ?'
			)
			.bind(p.scope.spaceId, 'Makan malam')
			.all<Record<string, unknown>>();
		expect(row.results).toHaveLength(1);
		expect(row.results[0]).toMatchObject({
			source: 'manual',
			photo_type: 'image/jpeg',
			amount_minor: 4_200_000
		});
		expect(await getPhoto(p, String(row.results[0]!.id))).toMatchObject({
			kind: 'ok',
			value: { status: 200 }
		});
	});
});

describe("account export (FN-31: a copy of all of the user's data)", () => {
	it('carries a kept receipt photo next to its transaction, never its R2 key', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo);
		const values = { ...review.values, categoryId: await categoryId(p, 'makan') };
		expect((await act(p, 'save', { fields: fields(values), photo })).kind).toBe('ok');
		const [row] = await rowsOf(p.scope.spaceId);
		const result = await exportAccount(db, p.user.id, { files });
		if (!result.ok) throw new Error('export refused');
		const zip = readZip(new Uint8Array(await new Response(result.stream).arrayBuffer()));
		const path = `photos/receipts/${row!.id}.jpg`;
		expect(zip.has(path)).toBe(true);
		const name = [...zip.keys()].find((k) => k.endsWith('/transactions.json'))!;
		const exported = JSON.parse(textOf(zip.get(name)));
		expect(exported).toHaveLength(1);
		expect(exported[0]).toMatchObject({ id: row!.id, photo: path });
		expect(JSON.stringify(exported)).not.toMatch(/spaces\/|photo_?[kK]ey/);
	});
});

describe('account deletion', () => {
	it('purges the personal space’s receipt photos', async () => {
		const p = await person();
		const photo = receiptPhoto();
		const review = await reviewOf(p, photo);
		const values = { ...review.values, categoryId: await categoryId(p, 'makan') };
		expect((await act(p, 'save', { fields: fields(values), photo })).kind).toBe('ok');
		expect(await objectsUnder(`spaces/${p.scope.spaceId}/receipts/`)).toHaveLength(1);
		const proof = await signInWithPassword(db, p.user.email, PASSWORD, Date.now());
		if (!proof.ok) throw new Error('proof');
		expect(await deleteAccount(db, p.user.id, proof.hash)).toBe(true);
		await sweepSoon(binding as never, db, Date.now());
		expect(await objectsUnder(`spaces/${p.scope.spaceId}/`)).toEqual([]);
	});
});
