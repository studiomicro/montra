import { browser } from '$app/env';
import { deserialize } from '$app/forms';
import {
	generateKeyPair,
	keyCheck,
	newKdfSalt,
	SCRYPT_PARAMS,
	unwrapPrivateKey,
	wrapPrivateKey,
	type ScryptParams
} from '#lib/shared/account-key';
import {
	ACCOUNT_KEY_FIELD_NAMES,
	decodeAccountKey,
	encodeAccountKey,
	type AccountKeyFields
} from '#lib/shared/account-key-fields';
import { base64urlEncode } from '#lib/shared/base64url';

/**
 * The account key on this device (FN-21). Browser only.
 *
 * The opened private key lives only in this module variable for the current page session: never in
 * IndexedDB, localStorage or any persisted store. A reload or the full page load of sign-out (and the
 * Clear-Site-Data it sends) drops it; it is opened again at the next sign-in. It is also dropped when the
 * session ends elsewhere (watchSessionEnd, the (auth) layout, a 401 error page).
 */
export interface DeviceKey {
	/** Non-extractable X25519 private key: usable for unseal, never exportable by page script. */
	privateKey: CryptoKey;
	/** base64url public key, compared with the server's to know which account's key this is. */
	publicKey: string;
}

let held: DeviceKey | null = null;
/** The last sign-in on this page found a key it could not open with the password given. */
let openFailed = false;

export function holdDeviceKey(key: DeviceKey | null): void {
	if (!browser) return;
	held = key;
	openFailed = false;
}

export function markOpenFailed(): void {
	if (!browser) return;
	held = null;
	openFailed = true;
}

export function deviceKeyOpenFailed(): boolean {
	return openFailed;
}

export function deviceKey(): DeviceKey | null {
	return held;
}

export function dropDeviceKey(): void {
	held = null;
	openFailed = false;
}

/** Tabs of this browser tell each other the session ended here (also read by the FN-02 offline queue). */
export const SESSION_CHANNEL = 'financer-session';

/**
 * This tab's session ended here (sign-out, account deletion): drops the key and tells the other tabs of this
 * browser, which share the cookie and so the ended session (red team L2).
 */
export function announceSignOut(): void {
	dropDeviceKey();
	if (!browser || typeof BroadcastChannel === 'undefined') return;
	const channel = new BroadcastChannel(SESSION_CHANNEL);
	channel.postMessage('signed-out');
	channel.close();
}

/**
 * Drops the held key when the session ends elsewhere (red team L2): another tab of this browser signs out
 * (broadcast), or the tab comes back into view and `stillSignedIn` answers false (expired, or revoked from
 * another device, e.g. by a password change). Returns the cleanup.
 */
export function watchSessionEnd(
	doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>,
	stillSignedIn: () => Promise<boolean>
): () => void {
	const channel =
		typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SESSION_CHANNEL);
	const onMessage = (e: MessageEvent) => {
		if (e.data === 'signed-out') dropDeviceKey();
	};
	const onVisibility = async () => {
		if (doc.visibilityState !== 'visible' || !held) return;
		if (!(await stillSignedIn().catch(() => true))) dropDeviceKey();
	};
	channel?.addEventListener('message', onMessage);
	doc.addEventListener('visibilitychange', onVisibility);
	return () => {
		channel?.close();
		doc.removeEventListener('visibilitychange', onVisibility);
	};
}

/**
 * Whether this browser's session is still signed in: the account page's data answers 401 or a redirect to
 * /masuk once the session is gone. A network failure counts as still signed in (offline is not signed out).
 */
export async function sessionStillSignedIn(): Promise<boolean> {
	const response = await fetch('/pengaturan/akun/__data.json', { cache: 'no-store' });
	if (response.status === 401) return false;
	const body = (await response.json().catch(() => null)) as { type?: string } | null;
	return body?.type !== 'redirect';
}

export type KeyMaterial = AccountKeyFields & { version: number };

/**
 * The signed-in account's wrapped key, fetched from /pengaturan/akun's `keyMaterial` action after it re-proves
 * `password`: what this device needs to re-wrap it. `ok: false` with the server's refusal otherwise.
 */
export async function fetchKeyMaterial(
	password: string
): Promise<{ ok: true; material: KeyMaterial | null } | { ok: false; error?: string }> {
	const body = new FormData();
	body.set('password', password);
	const response = await fetch('/pengaturan/akun?/keyMaterial', {
		method: 'POST',
		body,
		headers: { 'x-sveltekit-action': 'true' }
	});
	const result = deserialize(await response.text());
	if (result.type === 'failure')
		return { ok: false, error: (result.data as { keyError?: string } | undefined)?.keyError };
	if (result.type !== 'success') return { ok: false };
	const material = (result.data as { material?: KeyMaterial | null } | undefined)?.material;
	return { ok: true, material: material ?? null };
}

/** How long a derivation may take before the form gives up with a clear message (QA note, cycle 1). */
const DERIVE_TIMEOUT_MS = 30_000;

/** The Web Worker did not answer within DERIVE_TIMEOUT_MS (a slow device, or a worker killed silently). */
export class KeyDerivationTimeout extends Error {
	constructor() {
		super('Key derivation timed out');
	}
}

/**
 * The wrap key for `password`, derived in a dedicated Web Worker (scrypt is too heavy for the main thread).
 * Rejects with KeyDerivationTimeout after `timeoutMs`; the worker is terminated on every outcome.
 */
export function deriveWrapKeyOffThread(
	password: string,
	salt: Uint8Array,
	params: ScryptParams,
	timeoutMs = DERIVE_TIMEOUT_MS
): Promise<CryptoKey> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./derive.worker.ts', import.meta.url), { type: 'module' });
		const timer = setTimeout(() => {
			worker.terminate();
			reject(new KeyDerivationTimeout());
		}, timeoutMs);
		const done = () => {
			clearTimeout(timer);
			worker.terminate();
		};
		worker.addEventListener('message', (e: MessageEvent<{ ok: boolean; key?: CryptoKey }>) => {
			done();
			if (e.data.ok && e.data.key) resolve(e.data.key);
			else reject(new Error('Key derivation failed'));
		});
		worker.addEventListener('error', () => {
			done();
			reject(new Error('Key derivation failed'));
		});
		worker.postMessage({ password, salt, params });
	});
}

/** What a key write sends: the transported fields and the key confirmation (shared keyCheck). */
export interface KeyUpload {
	fields: AccountKeyFields;
	keyCheck: string;
}

/** Puts a key write on a form submission. */
export function setKeyFields(formData: FormData, upload: KeyUpload): void {
	for (const name of ACCOUNT_KEY_FIELD_NAMES) formData.set(name, upload.fields[name]);
	formData.set('keyCheck', upload.keyCheck);
}

const checkOf = async (privateKey: CryptoKey, publicKeyRaw: Uint8Array) =>
	base64urlEncode(await keyCheck(privateKey, publicKeyRaw));

/**
 * A brand-new key pair wrapped under `password`: what to send (public key, wrapped key, key confirmation) and
 * the key to hold once the server confirms it stored them.
 */
export async function createAccountKey(password: string): Promise<KeyUpload & { key: DeviceKey }> {
	const pair = await generateKeyPair();
	const kdfSalt = newKdfSalt();
	const wrapKey = await deriveWrapKeyOffThread(password, kdfSalt, SCRYPT_PARAMS);
	const { wrapped, nonce } = await wrapPrivateKey(pair.privateKey, pair.publicKeyRaw, wrapKey);
	// The held copy is non-extractable: opened from the wrap just made (also proves the wrap opens).
	const privateKey = await unwrapPrivateKey(wrapped, nonce, pair.publicKeyRaw, wrapKey);
	if (!privateKey) throw new Error('Wrap did not open');
	const fields = encodeAccountKey({
		publicKey: pair.publicKeyRaw,
		wrappedPrivateKey: wrapped,
		wrapNonce: nonce,
		kdfSalt,
		kdfParams: SCRYPT_PARAMS
	});
	return {
		fields,
		keyCheck: await checkOf(privateKey, pair.publicKeyRaw),
		key: { privateKey, publicKey: base64urlEncode(pair.publicKeyRaw) }
	};
}

/** The key inside stored fields, opened with `password`; null when the password does not open it. */
export async function openAccountKey(
	password: string,
	fields: AccountKeyFields
): Promise<DeviceKey | null> {
	const bytes = decodeAccountKey(fields);
	if (!bytes) return null;
	const wrapKey = await deriveWrapKeyOffThread(password, bytes.kdfSalt, bytes.kdfParams);
	const privateKey = await unwrapPrivateKey(
		bytes.wrappedPrivateKey,
		bytes.wrapNonce,
		bytes.publicKey,
		wrapKey
	);
	return privateKey ? { privateKey, publicKey: fields.publicKey } : null;
}

/**
 * The same key pair re-wrapped from `oldPassword` to `newPassword` (fresh salt and nonce), or null when the
 * old password does not open it. Sealed results stay openable: the key pair does not change. The key
 * confirmation sent along proves to the server that this device opened the current wrap.
 */
export async function rewrapAccountKey(
	fields: AccountKeyFields,
	oldPassword: string,
	newPassword: string
): Promise<(KeyUpload & { key: DeviceKey }) | null> {
	const bytes = decodeAccountKey(fields);
	if (!bytes) return null;
	const oldKey = await deriveWrapKeyOffThread(oldPassword, bytes.kdfSalt, bytes.kdfParams);
	const extractable = await unwrapPrivateKey(
		bytes.wrappedPrivateKey,
		bytes.wrapNonce,
		bytes.publicKey,
		oldKey,
		true
	);
	if (!extractable) return null;
	const kdfSalt = newKdfSalt();
	const newKey = await deriveWrapKeyOffThread(newPassword, kdfSalt, SCRYPT_PARAMS);
	const { wrapped, nonce } = await wrapPrivateKey(extractable, bytes.publicKey, newKey);
	const privateKey = await unwrapPrivateKey(wrapped, nonce, bytes.publicKey, newKey);
	if (!privateKey) return null;
	return {
		fields: encodeAccountKey({
			publicKey: bytes.publicKey,
			wrappedPrivateKey: wrapped,
			wrapNonce: nonce,
			kdfSalt,
			kdfParams: SCRYPT_PARAMS
		}),
		keyCheck: await checkOf(privateKey, bytes.publicKey),
		key: { privateKey, publicKey: fields.publicKey }
	};
}
