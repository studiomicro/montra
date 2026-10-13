import {
	isAllowedScryptParams,
	KDF_SALT_BYTES,
	NONCE_BYTES,
	PUBLIC_KEY_BYTES,
	WRAPPED_KEY_BYTES,
	type ScryptParams
} from './account-key.ts';
import { base64urlDecode, base64urlEncode } from './base64url.ts';

/**
 * The account key as it travels between device and server (form fields, action data): base64url bytes and
 * the scrypt params as JSON. Only the public key and already-wrapped material, never the password or a
 * derived key. Shared so the device encodes and the server validates with one definition.
 */
export interface AccountKeyFields {
	publicKey: string;
	wrappedPrivateKey: string;
	wrapNonce: string;
	kdfSalt: string;
	kdfParams: string;
}

export const ACCOUNT_KEY_FIELD_NAMES = [
	'publicKey',
	'wrappedPrivateKey',
	'wrapNonce',
	'kdfSalt',
	'kdfParams'
] as const satisfies readonly (keyof AccountKeyFields)[];

export interface AccountKeyBytes {
	publicKey: Uint8Array;
	wrappedPrivateKey: Uint8Array;
	wrapNonce: Uint8Array;
	kdfSalt: Uint8Array;
	kdfParams: ScryptParams;
}

/** Longest stored params JSON; the allowed shape is about 50 characters. */
const KDF_PARAMS_MAX_LENGTH = 200;

export function encodeAccountKey(key: AccountKeyBytes): AccountKeyFields {
	const { alg, N, r, p, dkLen } = key.kdfParams;
	return {
		publicKey: base64urlEncode(key.publicKey),
		wrappedPrivateKey: base64urlEncode(key.wrappedPrivateKey),
		wrapNonce: base64urlEncode(key.wrapNonce),
		kdfSalt: base64urlEncode(key.kdfSalt),
		kdfParams: JSON.stringify({ alg, N, r, p, dkLen })
	};
}

const exact = (text: string, length: number) => {
	const bytes = base64urlDecode(text);
	return bytes && bytes.length === length ? bytes : null;
};

/**
 * The bytes of transported key material, or null when any field is not exactly the expected shape: lengths
 * fixed, scrypt params within the allowed (OWASP-minimum-or-above) range.
 */
export function decodeAccountKey(fields: AccountKeyFields): AccountKeyBytes | null {
	const publicKey = exact(fields.publicKey, PUBLIC_KEY_BYTES);
	const wrappedPrivateKey = exact(fields.wrappedPrivateKey, WRAPPED_KEY_BYTES);
	const wrapNonce = exact(fields.wrapNonce, NONCE_BYTES);
	const kdfSalt = exact(fields.kdfSalt, KDF_SALT_BYTES);
	if (!publicKey || !wrappedPrivateKey || !wrapNonce || !kdfSalt) return null;
	if (fields.kdfParams.length > KDF_PARAMS_MAX_LENGTH) return null;
	let kdfParams: unknown;
	try {
		kdfParams = JSON.parse(fields.kdfParams);
	} catch {
		return null;
	}
	if (!isAllowedScryptParams(kdfParams)) return null;
	return { publicKey, wrappedPrivateKey, wrapNonce, kdfSalt, kdfParams };
}
