import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAccountKey, getAccountKeyStatus } from '#lib/server/account-keys/repo';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { createPasswordSession, resolveSession } from '#lib/server/auth/session';
import { sha256Hex } from '#lib/server/util';
import { getDb, type Db } from '#lib/server/db';
import {
	deriveWrapKey,
	generateKeyPair,
	keyCheck,
	newKdfSalt,
	SCRYPT_PARAMS,
	sealToPublicKey,
	unseal,
	unwrapPrivateKey,
	wrapPrivateKey
} from '#lib/shared/account-key';
import {
	decodeAccountKey,
	encodeAccountKey,
	type AccountKeyFields
} from '#lib/shared/account-key-fields';
import { base64urlEncode } from '#lib/shared/base64url';
import { openLocalD1 } from '../helpers/d1';
import { pinThrottleWindow } from '../helpers/clock';
import { fakeEvent } from '../helpers/event';

// Kit 3: bindings come from getEnv() (cloudflare:workers), which Node cannot load; tests hand it the local D1.
const binding: { DB?: D1Database; DEV_ROUTES?: string } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
vi.mock('$app/env', () => ({ dev: false, building: false }));

const { handle } = await import('../../src/hooks.server');
const masuk = await import('../../src/routes/(auth)/masuk/+page.server');
const daftar = await import('../../src/routes/(auth)/daftar/+page.server');
const akun = await import('../../src/routes/(app)/pengaturan/akun/+page.server');
const devUi = await import('../../src/routes/(app)/dev/ui/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NEW_PASSWORD = 'teh-sore-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

type Action = (event: never) => unknown;
const action = (actions: unknown, name: string) =>
	(actions as Record<string, Action>)[name] as Action;

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
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status };
		throw e;
	}
}

let ip = 0;
const client = () => ({ 'cf-connecting-ip': `198.51.100.${++ip}` });
let n = 0;
const freshEmail = () => `kunci-${++n}-${Date.now()}@contoh.id`;

/** Well-formed key fields with random bytes: the server can never check what is inside a wrap anyway. */
function randomFields(over: Partial<AccountKeyFields> = {}): AccountKeyFields {
	const r = (len: number) => base64urlEncode(crypto.getRandomValues(new Uint8Array(len)));
	return {
		publicKey: r(32),
		wrappedPrivateKey: r(64),
		wrapNonce: r(12),
		kdfSalt: r(16),
		kdfParams: JSON.stringify(SCRYPT_PARAMS),
		...over
	};
}

/** What a device does at sign-up: a real key pair wrapped under `password`. */
async function realKey(password: string) {
	const pair = await generateKeyPair();
	const kdfSalt = newKdfSalt();
	const wrapKey = await deriveWrapKey(password, kdfSalt, SCRYPT_PARAMS);
	const { wrapped, nonce } = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
	checks.set(
		base64urlEncode(pair.publicKeyRaw),
		base64urlEncode(await keyCheck(pair.privateKey, pair.publicKeyRaw))
	);
	return {
		pair,
		fields: encodeAccountKey({
			publicKey: pair.publicKeyRaw,
			wrappedPrivateKey: wrapped,
			wrapNonce: nonce,
			kdfSalt,
			kdfParams: SCRYPT_PARAMS
		})
	};
}

/** What a device does at a password change: open with the old password, wrap under the new one. */
async function rewrapOnDevice(fields: AccountKeyFields, oldPassword: string, newPassword: string) {
	const bytes = decodeAccountKey(fields)!;
	const oldKey = await deriveWrapKey(oldPassword, bytes.kdfSalt, bytes.kdfParams);
	const priv = await unwrapPrivateKey(
		bytes.wrappedPrivateKey,
		bytes.wrapNonce,
		bytes.publicKey,
		oldKey,
		true
	);
	if (!priv) return null;
	const kdfSalt = newKdfSalt();
	const newKey = await deriveWrapKey(newPassword, kdfSalt, SCRYPT_PARAMS);
	const { wrapped, nonce } = await wrapPrivateKey(priv, bytes.publicKey, newKey);
	return {
		...encodeAccountKey({
			publicKey: bytes.publicKey,
			wrappedPrivateKey: wrapped,
			wrapNonce: nonce,
			kdfSalt,
			kdfParams: SCRYPT_PARAMS
		}),
		// The key confirmation only the opened private key can compute.
		keyCheck: base64urlEncode(await keyCheck(priv, bytes.publicKey))
	};
}

/** The key confirmation stored with each public key (random for random fields, real for realKey). */
const checks = new Map<string, string>();
const checkFor = (publicKey: string) => {
	if (!checks.has(publicKey))
		checks.set(publicKey, base64urlEncode(crypto.getRandomValues(new Uint8Array(32))));
	return checks.get(publicKey)!;
};
/** A form carrying key fields gets the stored key confirmation unless the test sets `keyCheck` itself. */
const withCheck = (form: Record<string, string>) =>
	form.publicKey && !('keyCheck' in form) ? { ...form, keyCheck: checkFor(form.publicKey) } : form;

/** Session tokens by user id: actions run as that session (a password change keeps it, revokes the rest). */
const tokens = new Map<string, string>();

async function makeUser(fields: AccountKeyFields | null = null) {
	const email = freshEmail();
	const r = await signUp(
		db,
		{
			name: 'Budi',
			email,
			password: PASSWORD,
			adultConfirmed: true,
			consentAccepted: true,
			accountKey: fields
				? { fields, keyCheckHash: await sha256Hex(checkFor(fields.publicKey)) }
				: null
		},
		Date.now()
	);
	if (!r.ok) throw new Error('sign-up failed');
	tokens.set(r.userId, r.token);
	return { id: r.userId, email, name: 'Budi', createdAt: Date.now() };
}

type User = Awaited<ReturnType<typeof makeUser>>;

function akunEvent(user: User, name: string, form: Record<string, string>) {
	return fakeEvent({
		url: `http://localhost/pengaturan/akun?/${name}`,
		routeId: '/(app)/pengaturan/akun',
		db,
		user,
		sessionToken: tokens.get(user.id) ?? null,
		headers: client(),
		form: withCheck(form)
	}).event;
}
const akunAction = (user: User, name: string, form: Record<string, string>) =>
	run(() => action(akun.actions, name)(akunEvent(user, name, form) as never));

const passwordHash = async (userId: string) =>
	(
		await d1
			.prepare('select hash from user_passwords where user_id = ?')
			.bind(userId)
			.first<{ hash: string }>()
	)?.hash;
const keyRow = async (userId: string) =>
	d1.prepare('select * from account_keys where user_id = ?').bind(userId).first();

describe('sign-up (/daftar) with the account key', () => {
	const submit = (form: Record<string, string>) => {
		const { event } = fakeEvent({
			url: 'http://localhost/daftar',
			routeId: '/(auth)/daftar',
			db,
			headers: client(),
			form: withCheck(form)
		});
		return run(() => action(daftar.actions, 'default')(event as never));
	};
	const base = (email: string) => ({
		name: 'Budi',
		email,
		password: PASSWORD,
		adult: 'on',
		consent: 'on'
	});
	const userId = async (email: string) =>
		(await d1.prepare('select id from users where email = ?').bind(email).first<{ id: string }>())
			?.id;

	it('stores the public key and wrapped key in the same batch as the account', async () => {
		const email = freshEmail();
		const fields = randomFields();
		expect((await submit({ ...base(email), ...fields })).kind).toBe('redirect');
		const row = await keyRow((await userId(email))!);
		expect(row).toMatchObject({
			public_key: fields.publicKey,
			wrapped_private_key: fields.wrappedPrivateKey,
			wrap_nonce: fields.wrapNonce,
			kdf_salt: fields.kdfSalt,
			kdf_params: fields.kdfParams
		});
	});

	it('without JavaScript (no key fields) creates the account and no key row', async () => {
		const email = freshEmail();
		expect((await submit(base(email))).kind).toBe('redirect');
		const id = await userId(email);
		expect(id).toBeTruthy();
		expect(await keyRow(id!)).toBeNull();
	});

	it.each([
		[
			'a scrypt cost below the OWASP minimum',
			{ kdfParams: JSON.stringify({ ...SCRYPT_PARAMS, N: 2 ** 15 }) }
		],
		[
			'p raised to weaken memory',
			{ kdfParams: JSON.stringify({ ...SCRYPT_PARAMS, N: 1024, p: 128 }) }
		],
		['params that are not JSON', { kdfParams: 'N=131072' }],
		['a short public key', { publicKey: base64urlEncode(new Uint8Array(31)) }],
		['a missing nonce', { wrapNonce: '' }],
		['an oversized wrapped key', { wrappedPrivateKey: 'A'.repeat(300) }]
	])('refuses %s and creates nothing', async (_, over) => {
		const email = freshEmail();
		const r = await submit({ ...base(email), ...randomFields(over) });
		expect(r.kind).toBe('fail');
		if (r.kind === 'fail') {
			expect(r.status).toBe(400);
			expect(r.data.error).toBe(
				'Kunci akun tidak bisa disimpan. Muat ulang halaman lalu coba lagi.'
			);
			expect(JSON.stringify(r.data)).not.toContain(PASSWORD);
		}
		expect(await userId(email)).toBeUndefined();
	});
});

describe('sign-in (/masuk) hands the wrapped key to a key-capable device', () => {
	const submit = (form: Record<string, string>, next?: string) => {
		const { event, written } = fakeEvent({
			url: `http://localhost/masuk${next ? `?next=${encodeURIComponent(next)}` : ''}`,
			routeId: '/(auth)/masuk',
			db,
			headers: client(),
			form
		});
		return {
			written,
			result: run(() => action(masuk.actions, 'password')(event as never))
		};
	};

	it('returns the stored material (and sets the session) when asked with withKey=1', async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		const { result, written } = submit(
			{ email: user.email, password: PASSWORD, withKey: '1' },
			'/laporan'
		);
		const r = await result;
		expect(r.kind).toBe('ok');
		if (r.kind !== 'ok') return;
		expect(r.value.signedIn).toBe(true);
		expect(r.value.next).toBe('/laporan');
		expect(r.value.accountKey).toMatchObject(fields);
		expect(written.get('financer_session')?.value).toBeTruthy();
	});

	it('redirects as before without withKey, or when the account has no key', async () => {
		const keyed = await makeUser(randomFields());
		expect((await submit({ email: keyed.email, password: PASSWORD }).result).kind).toBe('redirect');
		const plain = await makeUser(null);
		const r = await submit({ email: plain.email, password: PASSWORD, withKey: '1' }).result;
		expect(r).toEqual({ kind: 'redirect', status: 303, location: '/' });
	});

	it('gives nothing to a wrong password', async () => {
		const user = await makeUser(randomFields());
		const r = await submit({ email: user.email, password: 'salah-sekali-1', withKey: '1' }).result;
		expect(r.kind).toBe('fail');
		expect(JSON.stringify(r)).not.toContain('wrappedPrivateKey');
	});
});

describe('/pengaturan/akun load', () => {
	it('reports whether a key exists and whether it is stale, never wrapped material', async () => {
		const user = await makeUser(randomFields());
		const { event } = fakeEvent({ url: 'http://localhost/pengaturan/akun', db, user });
		const data = (await akun.load(event as never)) as Record<string, unknown>;
		expect(data.accountKey).toEqual({ exists: true, stale: false });
		expect(JSON.stringify(data)).not.toMatch(/wrapped|kdf|publicKey/i);
		const plain = await makeUser(null);
		const { event: e2 } = fakeEvent({ url: 'http://localhost/pengaturan/akun', db, user: plain });
		expect(((await akun.load(e2 as never)) as Record<string, unknown>).accountKey).toEqual({
			exists: false,
			stale: false
		});
	});
});

describe('keyMaterial', () => {
	it('refuses a wrong password with the sign-in error and no material', async () => {
		const user = await makeUser(randomFields());
		const r = await akunAction(user, 'keyMaterial', { password: 'salah-sekali-1' });
		expect(r).toEqual({
			kind: 'fail',
			status: 400,
			data: { keyError: 'E-mail atau kata sandi salah.' }
		});
	});

	it("returns only the signed-in user's own row, whatever id the form names", async () => {
		const a = await makeUser(randomFields());
		const bFields = randomFields();
		const b = await makeUser(bFields);
		const r = await akunAction(b, 'keyMaterial', { password: PASSWORD, userId: a.id });
		expect(r.kind).toBe('ok');
		if (r.kind !== 'ok') return;
		const material = r.value.material as Record<string, unknown>;
		expect(material).toMatchObject(bFields);
		expect(material.publicKey).not.toBe((await getAccountKey(db, a.id))?.publicKey);
		// A user without a key gets null, never someone else's.
		const c = await makeUser(null);
		const none = await akunAction(c, 'keyMaterial', { password: PASSWORD, userId: a.id });
		expect(none).toEqual({ kind: 'ok', value: { material: null } });
	});
});

describe('changePassword', () => {
	const change = (user: User, extra: Record<string, string> = {}) =>
		akunAction(user, 'changePassword', {
			password: PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD,
			...extra
		});

	it('refuses a wrong current password with the sign-in error; hash and key unchanged', async () => {
		const user = await makeUser(randomFields());
		const before = { hash: await passwordHash(user.id), key: await keyRow(user.id) };
		const r = await change(user, { password: 'salah-sekali-1' });
		expect(r).toEqual({
			kind: 'fail',
			status: 400,
			data: { passwordError: 'E-mail atau kata sandi salah.' }
		});
		expect({ hash: await passwordHash(user.id), key: await keyRow(user.id) }).toEqual(before);
	});

	it('refuses a mismatched confirmation and a weak new password before any proof', async () => {
		const user = await makeUser(null);
		expect(await change(user, { confirmPassword: 'lain-lagi-2026' })).toMatchObject({
			status: 400,
			data: { passwordError: 'Konfirmasi kata sandi tidak sama.' }
		});
		expect(
			await change(user, { newPassword: 'password', confirmPassword: 'password' })
		).toMatchObject({ status: 400, data: { passwordError: 'Kata sandi terlalu mudah ditebak.' } });
		expect(await signInWithPassword(db, user.email, PASSWORD, Date.now())).toMatchObject({
			ok: true
		});
	});

	it('refuses key fields without a version, or malformed ones, and changes nothing', async () => {
		const user = await makeUser(randomFields());
		const before = await passwordHash(user.id);
		expect(await change(user, { ...randomFields() })).toMatchObject({ status: 400 });
		expect(
			await change(user, { ...randomFields({ kdfSalt: 'x' }), keyVersion: '1' })
		).toMatchObject({ status: 400 });
		expect(await passwordHash(user.id)).toBe(before);
	});

	it('re-wraps on the device: same key pair, new wrap, a result sealed before opens with the new password', async () => {
		const { pair, fields } = await realKey(PASSWORD);
		const user = await makeUser(fields);
		const sealed = await sealToPublicKey(
			new TextEncoder().encode('Mutasi BCA Oktober'),
			pair.publicKeyRaw
		);
		const material = await akunAction(user, 'keyMaterial', { password: PASSWORD });
		if (material.kind !== 'ok') throw new Error('material');
		const m = material.value.material as AccountKeyFields & { version: number };
		const rewrapped = (await rewrapOnDevice(m, PASSWORD, NEW_PASSWORD))!;
		const r = await change(user, { ...rewrapped, keyVersion: String(m.version) });
		expect(r).toEqual({ kind: 'ok', value: { passwordChanged: true, keyNotice: undefined } });

		const row = (await getAccountKey(db, user.id))!;
		expect(row.publicKey).toBe(fields.publicKey);
		expect(row.wrappedPrivateKey).not.toBe(fields.wrappedPrivateKey);
		expect(row.wrapNonce).not.toBe(fields.wrapNonce);
		expect(row.kdfSalt).not.toBe(fields.kdfSalt);
		expect((await getAccountKeyStatus(db, user.id))?.stale).toBe(false);

		const bytes = decodeAccountKey(row)!;
		const open = async (password: string) =>
			unwrapPrivateKey(
				bytes.wrappedPrivateKey,
				bytes.wrapNonce,
				bytes.publicKey,
				await deriveWrapKey(password, bytes.kdfSalt, bytes.kdfParams)
			);
		expect(await open(PASSWORD)).toBeNull();
		const key = (await open(NEW_PASSWORD))!;
		expect(new TextDecoder().decode(await unseal(sealed, key, pair.publicKeyRaw))).toBe(
			'Mutasi BCA Oktober'
		);
		expect(await signInWithPassword(db, user.email, NEW_PASSWORD, Date.now())).toMatchObject({
			ok: true
		});
	});

	it('without a re-wrap (JS off) changes the password, leaves the key and says so', async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		const before = await keyRow(user.id);
		const r = await change(user);
		expect(r).toEqual({
			kind: 'ok',
			value: {
				passwordChanged: true,
				keyNotice:
					'Kunci akun tidak bisa dibuka dengan kata sandi barumu. Kunci ulang di bawah ini.'
			}
		});
		expect(await keyRow(user.id)).toEqual(before);
		expect(await getAccountKeyStatus(db, user.id)).toEqual({
			publicKey: fields.publicKey,
			stale: true
		});
		expect(await signInWithPassword(db, user.email, NEW_PASSWORD, Date.now())).toMatchObject({
			ok: true
		});
	});

	it('without a key at all changes the password with no notice', async () => {
		const user = await makeUser(null);
		expect(await change(user)).toEqual({
			kind: 'ok',
			value: { passwordChanged: true, keyNotice: undefined }
		});
	});

	it('a re-wrap against a version that moved on is refused whole (changed meanwhile)', async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		const before = { hash: await passwordHash(user.id), key: await keyRow(user.id) };
		const r = await change(user, {
			...randomFields({ publicKey: fields.publicKey }),
			keyVersion: '1'
		});
		expect(r).toMatchObject({ kind: 'fail', status: 409 });
		expect({ hash: await passwordHash(user.id), key: await keyRow(user.id) }).toEqual(before);
	});

	it('a re-wrap that names another public key is refused whole (the key pair never changes)', async () => {
		const user = await makeUser(randomFields());
		const version = (await getAccountKey(db, user.id))!.updatedAt;
		const before = { hash: await passwordHash(user.id), key: await keyRow(user.id) };
		const r = await change(user, { ...randomFields(), keyVersion: String(version) });
		expect(r).toMatchObject({ kind: 'fail', status: 409 });
		expect({ hash: await passwordHash(user.id), key: await keyRow(user.id) }).toEqual(before);
	});

	it('20 concurrent changes: exactly one commits, and the password and wrap are both its own', async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		const version = (await getAccountKey(db, user.id))!.updatedAt;
		const attempts = Array.from({ length: 20 }, (_, i) => ({
			newPassword: `ganti-paralel-${i}-2026`,
			fields: randomFields({ publicKey: fields.publicKey })
		}));
		const results = await Promise.all(
			attempts.map((a) =>
				akunAction(user, 'changePassword', {
					password: PASSWORD,
					newPassword: a.newPassword,
					confirmPassword: a.newPassword,
					...a.fields,
					keyVersion: String(version)
				})
			)
		);
		const winners = results.flatMap((r, i) => (r.kind === 'ok' ? [i] : []));
		expect(winners).toHaveLength(1);
		const losers = results.filter((r) => r.kind !== 'ok');
		// A loser either lost the race at the guarded write (409) or proved against an already-changed hash.
		for (const l of losers) expect(l.kind === 'fail' && [400, 409].includes(l.status)).toBe(true);
		const winner = attempts[winners[0]!]!;
		const row = (await getAccountKey(db, user.id))!;
		expect(row.wrappedPrivateKey).toBe(winner.fields.wrappedPrivateKey);
		expect(row.kdfSalt).toBe(winner.fields.kdfSalt);
		expect(row.publicKey).toBe(fields.publicKey);
		expect(await signInWithPassword(db, user.email, winner.newPassword, Date.now())).toMatchObject({
			ok: true
		});
		expect((await getAccountKeyStatus(db, user.id))?.stale).toBe(false);
	});

	it('answers 415 to a non-form body and 400 to an oversized one, never 500', async () => {
		const user = await makeUser(null);
		const json = fakeEvent({
			url: 'http://localhost/pengaturan/akun?/changePassword',
			db,
			user,
			method: 'POST',
			headers: { 'content-type': 'application/json' }
		}).event;
		expect(await run(() => action(akun.actions, 'changePassword')(json as never))).toEqual({
			kind: 'error',
			status: 415
		});
		const big = akunEvent(user, 'activateAccountKey', {
			password: PASSWORD,
			pad: 'x'.repeat(9000)
		});
		expect(await run(() => action(akun.actions, 'activateAccountKey')(big as never))).toEqual({
			kind: 'error',
			status: 400
		});
	});
});

describe('activateAccountKey ("Kunci dengan akunku")', () => {
	it('without key fields (JS off) answers that the browser cannot make a key', async () => {
		const user = await makeUser(null);
		expect(await akunAction(user, 'activateAccountKey', { password: PASSWORD })).toEqual({
			kind: 'fail',
			status: 400,
			data: {
				keyError:
					'Browser ini belum bisa membuat kunci akun. Gunakan browser terbaru dengan JavaScript aktif.'
			}
		});
		expect(await keyRow(user.id)).toBeNull();
	});

	it('refuses a wrong password and writes nothing', async () => {
		const user = await makeUser(null);
		const r = await akunAction(user, 'activateAccountKey', {
			password: 'salah-sekali-1',
			...randomFields()
		});
		expect(r).toMatchObject({ kind: 'fail', status: 400 });
		expect(await keyRow(user.id)).toBeNull();
	});

	it('creates the first key; a second activation is refused and the first key stays', async () => {
		const user = await makeUser(null);
		const fields = randomFields();
		expect(await akunAction(user, 'activateAccountKey', { password: PASSWORD, ...fields })).toEqual(
			{ kind: 'ok', value: { keyActivated: true } }
		);
		expect((await getAccountKey(db, user.id))?.publicKey).toBe(fields.publicKey);
		const again = await akunAction(user, 'activateAccountKey', {
			password: PASSWORD,
			...randomFields()
		});
		expect(again).toMatchObject({ kind: 'fail', status: 409 });
		expect((await getAccountKey(db, user.id))?.publicKey).toBe(fields.publicKey);
		const { event } = fakeEvent({ url: 'http://localhost/pengaturan/akun', db, user });
		expect(((await akun.load(event as never)) as Record<string, unknown>).accountKey).toEqual({
			exists: true,
			stale: false
		});
	});

	it('20 concurrent activations write exactly one key', async () => {
		const user = await makeUser(null);
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				akunAction(user, 'activateAccountKey', { password: PASSWORD, ...randomFields() })
			)
		);
		expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
		const count = await d1
			.prepare('select count(*) as n from account_keys where user_id = ?')
			.bind(user.id)
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
	});
});

describe('rewrapAccountKey (re-lock a stale key)', () => {
	async function staleUser() {
		const { pair, fields } = await realKey(PASSWORD);
		const user = await makeUser(fields);
		await akunAction(user, 'changePassword', {
			password: PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD
		});
		return { user, pair, fields };
	}

	it('re-wraps under the current password; the key is no longer stale and opens with it', async () => {
		const { user, pair, fields } = await staleUser();
		expect((await getAccountKeyStatus(db, user.id))?.stale).toBe(true);
		const material = await akunAction(user, 'keyMaterial', { password: NEW_PASSWORD });
		if (material.kind !== 'ok') throw new Error('material');
		const m = material.value.material as AccountKeyFields & { version: number };
		// The device opens it with the earlier password, which it never sends.
		const rewrapped = (await rewrapOnDevice(m, PASSWORD, NEW_PASSWORD))!;
		const r = await akunAction(user, 'rewrapAccountKey', {
			password: NEW_PASSWORD,
			...rewrapped,
			keyVersion: String(m.version)
		});
		expect(r).toEqual({ kind: 'ok', value: { keyRewrapped: true } });
		expect((await getAccountKeyStatus(db, user.id))?.stale).toBe(false);
		const row = (await getAccountKey(db, user.id))!;
		expect(row.publicKey).toBe(fields.publicKey);
		const bytes = decodeAccountKey(row)!;
		const key = await unwrapPrivateKey(
			bytes.wrappedPrivateKey,
			bytes.wrapNonce,
			bytes.publicKey,
			await deriveWrapKey(NEW_PASSWORD, bytes.kdfSalt, bytes.kdfParams)
		);
		const sealed = await sealToPublicKey(new TextEncoder().encode('ok'), pair.publicKeyRaw);
		expect(new TextDecoder().decode(await unseal(sealed, key!, pair.publicKeyRaw))).toBe('ok');
	});

	it('refuses a stale version, another public key, a wrong password and absent fields', async () => {
		const { user, fields } = await staleUser();
		const version = (await getAccountKey(db, user.id))!.updatedAt;
		const before = await keyRow(user.id);
		const attempt = (form: Record<string, string>) =>
			akunAction(user, 'rewrapAccountKey', { password: NEW_PASSWORD, ...form });
		expect(
			await attempt({ ...randomFields({ publicKey: fields.publicKey }), keyVersion: '1' })
		).toMatchObject({ status: 409 });
		expect(await attempt({ ...randomFields(), keyVersion: String(version) })).toMatchObject({
			status: 409
		});
		expect(
			await akunAction(user, 'rewrapAccountKey', {
				password: 'salah-sekali-1',
				...randomFields({ publicKey: fields.publicKey }),
				keyVersion: String(version)
			})
		).toMatchObject({ status: 400 });
		expect(await attempt({})).toMatchObject({ status: 400 });
		expect(await keyRow(user.id)).toEqual(before);
	});
});

describe('account deletion and the dev panel', () => {
	it('deleting the account deletes its key row', async () => {
		const user = await makeUser(randomFields());
		const hash = (await passwordHash(user.id))!;
		expect(await deleteAccount(db, user.id, hash)).toBe(true);
		expect(await keyRow(user.id)).toBeNull();
	});

	it("/dev/ui gives the signed-in user's own public key only, and is 404 without dev routes", async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		await makeUser(randomFields());
		binding.DEV_ROUTES = '1';
		const { event } = fakeEvent({ url: 'http://localhost/dev/ui', db, user });
		expect(await devUi.load(event as never)).toEqual({ accountPublicKey: fields.publicKey });
		binding.DEV_ROUTES = undefined;
		expect(await run(() => devUi.load(event as never))).toEqual({ kind: 'error', status: 404 });
	});
});

describe('a password change signs out every other session (red team M1)', () => {
	async function secondSession(userId: string) {
		const hash = (await passwordHash(userId))!;
		return (await createPasswordSession(db, userId, hash, Date.now()))!.token;
	}
	async function subscribe(userId: string, token: string, endpoint: string) {
		const session = await d1
			.prepare('select id from sessions where token_hash = ?')
			.bind(await sha256Hex(token))
			.first<{ id: string }>();
		await d1
			.prepare(
				`insert into push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
				values (?, ?, ?, ?, 'p', 'a', null, 1, 1)`
			)
			.bind(crypto.randomUUID(), userId, session!.id, endpoint)
			.run();
	}
	const subscriptionDeleted = async (endpoint: string) =>
		(
			await d1
				.prepare('select deleted_at from push_subscriptions where endpoint = ?')
				.bind(endpoint)
				.first<{ deleted_at: number | null }>()
		)?.deleted_at !== null;
	const change = (user: User, password = PASSWORD) =>
		akunAction(user, 'changePassword', {
			password,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD
		});
	const endpoint = () => `https://push.example.test/${crypto.randomUUID()}`;

	it('revokes the other sessions and their push subscriptions; this session and other users stay', async () => {
		const user = await makeUser(randomFields());
		const here = tokens.get(user.id)!;
		const elsewhere = await secondSession(user.id);
		const other = await makeUser(null);
		const otherToken = tokens.get(other.id)!;
		const [hereEp, elsewhereEp, otherEp] = [endpoint(), endpoint(), endpoint()];
		await subscribe(user.id, here, hereEp);
		await subscribe(user.id, elsewhere, elsewhereEp);
		await subscribe(other.id, otherToken, otherEp);

		expect((await change(user)).kind).toBe('ok');

		expect(await resolveSession(db, elsewhere, Date.now())).toBeNull();
		expect((await resolveSession(db, here, Date.now()))?.id).toBe(user.id);
		expect((await resolveSession(db, otherToken, Date.now()))?.id).toBe(other.id);
		expect(await subscriptionDeleted(elsewhereEp)).toBe(true);
		expect(await subscriptionDeleted(hereEp)).toBe(false);
		expect(await subscriptionDeleted(otherEp)).toBe(false);

		// The revoked session's next request gets the signed-out flow.
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/akun',
			routeId: '/(app)/pengaturan/akun',
			db,
			cookies: { financer_session: elsewhere }
		});
		const res = await handle({
			event,
			resolve: vi.fn(async () => new Response('signed in'))
		} as never);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/masuk?next=%2Fpengaturan%2Fakun');
	});

	it('a refused change (wrong current password) revokes nothing', async () => {
		const user = await makeUser(null);
		const elsewhere = await secondSession(user.id);
		expect((await change(user, 'salah-sekali-1')).kind).toBe('fail');
		expect((await resolveSession(db, elsewhere, Date.now()))?.id).toBe(user.id);
	});
});

describe('re-wraps must prove the device opened the current wrap (red team L1)', () => {
	const randomCheck = () => base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

	it('refuses a re-lock of a key that is not stale, even with the right version and key check', async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		const version = (await getAccountKey(db, user.id))!.updatedAt;
		const before = await keyRow(user.id);
		const r = await akunAction(user, 'rewrapAccountKey', {
			password: PASSWORD,
			...randomFields({ publicKey: fields.publicKey }),
			keyVersion: String(version)
		});
		expect(r).toMatchObject({ kind: 'fail', status: 409 });
		expect(await keyRow(user.id)).toEqual(before);
	});

	it('refuses a password-change re-wrap whose key check is not the stored one; nothing changes', async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		const version = (await getAccountKey(db, user.id))!.updatedAt;
		const before = { hash: await passwordHash(user.id), key: await keyRow(user.id) };
		const r = await akunAction(user, 'changePassword', {
			password: PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD,
			...randomFields({ publicKey: fields.publicKey }),
			keyCheck: randomCheck(),
			keyVersion: String(version)
		});
		expect(r).toMatchObject({ kind: 'fail', status: 409 });
		expect({ hash: await passwordHash(user.id), key: await keyRow(user.id) }).toEqual(before);
	});

	it('refuses a stale re-lock whose key check is not the stored one (earlier password unknown)', async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		await akunAction(user, 'changePassword', {
			password: PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD
		});
		expect((await getAccountKeyStatus(db, user.id))?.stale).toBe(true);
		const version = (await getAccountKey(db, user.id))!.updatedAt;
		const before = await keyRow(user.id);
		const r = await akunAction(user, 'rewrapAccountKey', {
			password: NEW_PASSWORD,
			...randomFields({ publicKey: fields.publicKey }),
			keyCheck: randomCheck(),
			keyVersion: String(version)
		});
		expect(r).toMatchObject({ kind: 'fail', status: 409 });
		expect(await keyRow(user.id)).toEqual(before);
	});

	it('refuses key fields without a valid key check at sign-up and activation', async () => {
		const email = freshEmail();
		const { event } = fakeEvent({
			url: 'http://localhost/daftar',
			routeId: '/(auth)/daftar',
			db,
			headers: client(),
			form: {
				name: 'Budi',
				email,
				password: PASSWORD,
				adult: 'on',
				consent: 'on',
				...randomFields(),
				keyCheck: ''
			}
		});
		expect(await run(() => action(daftar.actions, 'default')(event as never))).toMatchObject({
			kind: 'fail',
			status: 400
		});
		const user = await makeUser(null);
		expect(
			await akunAction(user, 'activateAccountKey', {
				password: PASSWORD,
				...randomFields(),
				keyCheck: 'pendek'
			})
		).toMatchObject({ kind: 'fail', status: 400 });
		expect(await keyRow(user.id)).toBeNull();
	});

	it('the stored key check is never sent to a client', async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		const r = await akunAction(user, 'keyMaterial', { password: PASSWORD });
		expect(r.kind).toBe('ok');
		expect(JSON.stringify(r)).not.toContain(checkFor(fields.publicKey));
	});

	it('stores only SHA-256 of the key check, so a leaked row cannot be replayed (red team N2)', async () => {
		const fields = randomFields();
		const user = await makeUser(fields);
		const row = await d1
			.prepare('select key_check_hash from account_keys where user_id = ?')
			.bind(user.id)
			.first<{ key_check_hash: string }>();
		expect(row?.key_check_hash).toBe(await sha256Hex(checkFor(fields.publicKey)));
		// Replaying the stored digest as the key check is refused.
		const version = (await getAccountKey(db, user.id))!.updatedAt;
		const before = await keyRow(user.id);
		const r = await akunAction(user, 'changePassword', {
			password: PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD,
			...randomFields({ publicKey: fields.publicKey }),
			keyCheck: base64urlEncode(
				Uint8Array.from(row!.key_check_hash.match(/../g)!, (h) => parseInt(h, 16))
			),
			keyVersion: String(version)
		});
		expect(r).toMatchObject({ kind: 'fail', status: 409 });
		expect(await keyRow(user.id)).toEqual(before);
	});
});

describe('password-proving account actions are throttled (red team L3)', () => {
	const material = (user: User, ipAddr: string) => {
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/akun?/keyMaterial',
			routeId: '/(app)/pengaturan/akun',
			db,
			user,
			sessionToken: tokens.get(user.id) ?? null,
			headers: { 'cf-connecting-ip': ipAddr },
			form: { password: PASSWORD }
		});
		return run(() => action(akun.actions, 'keyMaterial')(event as never));
	};

	it('per client: the 21st attempt in the window answers 429 without deriving', async () => {
		// 21 password derivations take seconds; a window boundary in between would reset the counter.
		pinThrottleWindow();
		const results = [];
		for (let i = 0; i < 21; i++) results.push(await material(await makeUser(null), '203.0.113.77'));
		expect(results.slice(0, 20).every((r) => r.kind === 'ok')).toBe(true);
		expect(results[20]).toEqual({
			kind: 'fail',
			status: 429,
			data: { keyError: 'Terlalu banyak percobaan. Coba lagi dalam beberapa menit.' }
		});
	});

	it('per user: the 21st attempt from rotating addresses answers 429', async () => {
		// 21 password derivations take seconds; a window boundary in between would reset the counter.
		pinThrottleWindow();
		const user = await makeUser(null);
		const results = [];
		for (let i = 0; i < 21; i++) results.push(await material(user, `203.0.113.${100 + i}`));
		expect(results.slice(0, 20).every((r) => r.kind === 'ok')).toBe(true);
		expect(results[20]).toMatchObject({ kind: 'fail', status: 429 });
	});
});
