import { base64urlDecode, base64urlEncode } from '#lib/shared/base64url';
import { isPasskeyAlgorithm, type PasskeyAlgorithm } from '#lib/shared/passkeys';
import { bytesToHex } from '../util';

/**
 * FN-50: a minimal WebAuthn verifier for attestation `none` (PRD Owner decision 13, fallback branch). Spike
 * 2026-10-12: `@simplewebauthn/server` 14.0.3 (published 2026-09-25, ≥ 2 weeks old) verified the recorded Chromium
 * registration and assertion (test/fixtures/webauthn/) under `wrangler dev` (workerd), but its minified Worker
 * bundle was 323.84 KiB (89.94 KiB gzip), above the PRD's 300 KB bar for a feature that never reads an
 * attestation statement. This module, verifying the same fixture on workerd, bundles to 8.52 KiB. Only what a
 * passkey needs is implemented here, on WebCrypto alone:
 *
 * - a bounded CBOR decoder for the attestation object and the COSE key (definite lengths only);
 * - the authenticator-data parse (rpIdHash, flags, counter, AAGUID, credential id, COSE key);
 * - COSE → JWK → `crypto.subtle.importKey` for ES256 (-7, P-256) and RS256 (-257) only;
 * - `clientDataJSON` type / challenge / origin checks;
 * - the assertion signature over `authenticatorData || SHA-256(clientDataJSON)` (an ECDSA signature arrives
 *   DER-encoded and is converted to the raw r||s form WebCrypto verifies).
 *
 * Every refusal is a short reason label for a log line; the user sees one fixed message. Nothing here logs,
 * stores or echoes a challenge, credential id or key. Field sizes are capped before any decoding.
 */

/** Longest base64url field accepted (an RS256 attestation object is ~1 KB; extensions stay small). */
export const WEBAUTHN_FIELD_MAX_CHARS = 6000;
/** Longest clientDataJSON accepted. */
const CLIENT_DATA_MAX_CHARS = 4000;
/** Most nested CBOR containers followed. */
const CBOR_MAX_DEPTH = 8;
/** Most entries one CBOR array or map may hold. */
const CBOR_MAX_ITEMS = 64;

const AUTH_DATA_MIN_BYTES = 37;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export type WebAuthnRefusal =
	| 'malformed'
	| 'client_data'
	| 'type'
	| 'challenge'
	| 'origin'
	| 'rp_id'
	| 'user_presence'
	| 'no_credential'
	| 'algorithm'
	| 'public_key'
	| 'signature';

/** What a registration response was checked against. */
export interface ExpectedRegistration {
	/** The challenge as issued (base64url, no padding). */
	challenge: string;
	origin: string;
	rpId: string;
}

export interface RegistrationFields {
	attestationObject: string;
	clientDataJSON: string;
}

/** What a verified registration yields: exactly what the `passkeys` row stores. */
export interface VerifiedCredential {
	credentialId: string;
	/** The COSE key as sent (base64url). */
	publicKey: string;
	algorithm: PasskeyAlgorithm;
	counter: number;
	/** The AAGUID as a 36-character UUID (the zero UUID when the authenticator gives none). */
	aaguid: string;
	backedUp: boolean;
	userVerified: boolean;
}

export type RegistrationResult =
	{ ok: true; credential: VerifiedCredential } | { ok: false; reason: WebAuthnRefusal };

export interface AssertionFields {
	authenticatorData: string;
	clientDataJSON: string;
	signature: string;
}

export type AssertionResult =
	{ ok: true; counter: number; userVerified: boolean } | { ok: false; reason: WebAuthnRefusal };

type CborValue =
	number | string | Uint8Array | boolean | null | CborValue[] | Map<CborValue, CborValue>;

/** Decodes one CBOR item at `offset`; throws on anything outside the small subset a WebAuthn payload uses. */
function decodeItem(
	bytes: Uint8Array,
	offset: number,
	depth: number
): { value: CborValue; next: number } {
	if (depth > CBOR_MAX_DEPTH) throw new Error('cbor depth');
	if (offset >= bytes.length) throw new Error('cbor eof');
	const initial = bytes[offset]!;
	const major = initial >> 5;
	const info = initial & 0x1f;
	let next = offset + 1;
	let arg: number;
	if (info < 24) arg = info;
	else if (info === 24) {
		arg = bytes[next]!;
		next += 1;
	} else if (info === 25) {
		arg = (bytes[next]! << 8) | bytes[next + 1]!;
		next += 2;
	} else if (info === 26) {
		arg =
			bytes[next]! * 0x1000000 +
			((bytes[next + 1]! << 16) | (bytes[next + 2]! << 8) | bytes[next + 3]!);
		next += 4;
	} else throw new Error('cbor length');
	if (next > bytes.length) throw new Error('cbor eof');
	switch (major) {
		case 0:
			return { value: arg, next };
		case 1:
			return { value: -1 - arg, next };
		case 2:
		case 3: {
			const end = next + arg;
			if (end > bytes.length) throw new Error('cbor eof');
			const slice = bytes.subarray(next, end);
			return {
				value: major === 2 ? new Uint8Array(slice) : new TextDecoder().decode(slice),
				next: end
			};
		}
		case 4: {
			if (arg > CBOR_MAX_ITEMS) throw new Error('cbor items');
			const items: CborValue[] = [];
			for (let i = 0; i < arg; i++) {
				const item = decodeItem(bytes, next, depth + 1);
				items.push(item.value);
				next = item.next;
			}
			return { value: items, next };
		}
		case 5: {
			if (arg > CBOR_MAX_ITEMS) throw new Error('cbor items');
			const map = new Map<CborValue, CborValue>();
			for (let i = 0; i < arg; i++) {
				const key = decodeItem(bytes, next, depth + 1);
				const value = decodeItem(bytes, key.next, depth + 1);
				map.set(key.value, value.value);
				next = value.next;
			}
			return { value: map, next };
		}
		case 7:
			if (info === 20) return { value: false, next };
			if (info === 21) return { value: true, next };
			if (info === 22) return { value: null, next };
			throw new Error('cbor simple');
		default:
			throw new Error('cbor major');
	}
}

/** The one CBOR item `bytes` holds and how many bytes it used (an authData's COSE key may be followed by extensions). */
export function decodeCbor(bytes: Uint8Array): { value: CborValue; length: number } {
	const { value, next } = decodeItem(bytes, 0, 0);
	return { value, length: next };
}

const mapGet = (map: Map<CborValue, CborValue>, key: number | string) => map.get(key);

interface AuthData {
	rpIdHash: Uint8Array;
	flags: number;
	counter: number;
	credential: { aaguid: Uint8Array; id: Uint8Array; publicKey: Uint8Array } | null;
}

/** Parses authenticator data (WebAuthn § 6.1); the attested credential, when the AT flag is set. */
export function parseAuthData(bytes: Uint8Array): AuthData | null {
	if (bytes.length < AUTH_DATA_MIN_BYTES) return null;
	const flags = bytes[32]!;
	const counter = bytes[33]! * 0x1000000 + ((bytes[34]! << 16) | (bytes[35]! << 8) | bytes[36]!);
	let offset = AUTH_DATA_MIN_BYTES;
	let credential: AuthData['credential'] = null;
	if (flags & FLAG_AT) {
		if (bytes.length < offset + 18) return null;
		const aaguid = new Uint8Array(bytes.subarray(offset, offset + 16));
		const idLength = (bytes[offset + 16]! << 8) | bytes[offset + 17]!;
		offset += 18;
		if (idLength === 0 || idLength > 1023 || bytes.length < offset + idLength) return null;
		const id = new Uint8Array(bytes.subarray(offset, offset + idLength));
		offset += idLength;
		let key: { length: number };
		try {
			key = decodeCbor(bytes.subarray(offset));
		} catch {
			return null;
		}
		const publicKey = new Uint8Array(bytes.subarray(offset, offset + key.length));
		offset += key.length;
		credential = { aaguid, id, publicKey };
	}
	if (flags & FLAG_ED) {
		try {
			offset += decodeCbor(bytes.subarray(offset)).length;
		} catch {
			return null;
		}
	}
	if (offset !== bytes.length) return null;
	return { rpIdHash: new Uint8Array(bytes.subarray(0, 32)), flags, counter, credential };
}

/** The 36-character UUID of 16 AAGUID bytes. */
export function aaguidToUuid(bytes: Uint8Array): string {
	const hex = bytesToHex(bytes);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The algorithm a COSE key declares, when it is one of ours and its curve or key type matches. */
export function coseAlgorithm(coseKey: Uint8Array): PasskeyAlgorithm | null {
	let decoded: CborValue;
	try {
		decoded = decodeCbor(coseKey).value;
	} catch {
		return null;
	}
	if (!(decoded instanceof Map)) return null;
	const kty = mapGet(decoded, 1);
	const alg = mapGet(decoded, 3);
	if (typeof alg !== 'number' || !isPasskeyAlgorithm(alg)) return null;
	if (alg === -7) {
		const x = mapGet(decoded, -2);
		const y = mapGet(decoded, -3);
		const okShape =
			kty === 2 &&
			mapGet(decoded, -1) === 1 &&
			x instanceof Uint8Array &&
			y instanceof Uint8Array &&
			x.length === 32 &&
			y.length === 32;
		return okShape ? alg : null;
	}
	const n = mapGet(decoded, -1);
	const e = mapGet(decoded, -2);
	const okShape =
		kty === 3 &&
		n instanceof Uint8Array &&
		e instanceof Uint8Array &&
		n.length >= 256 &&
		n.length <= 512 &&
		e.length >= 1 &&
		e.length <= 8;
	return okShape ? alg : null;
}

/** A COSE key (ES256 or RS256) as a WebCrypto verify key; null when it is not one we accept. */
export async function importCoseKey(coseKey: Uint8Array): Promise<CryptoKey | null> {
	const alg = coseAlgorithm(coseKey);
	if (alg === null) return null;
	const map = decodeCbor(coseKey).value as Map<CborValue, CborValue>;
	try {
		if (alg === -7) {
			return await crypto.subtle.importKey(
				'jwk',
				{
					kty: 'EC',
					crv: 'P-256',
					x: base64urlEncode(mapGet(map, -2) as Uint8Array),
					y: base64urlEncode(mapGet(map, -3) as Uint8Array)
				},
				{ name: 'ECDSA', namedCurve: 'P-256' },
				false,
				['verify']
			);
		}
		return await crypto.subtle.importKey(
			'jwk',
			{
				kty: 'RSA',
				n: base64urlEncode(mapGet(map, -1) as Uint8Array),
				e: base64urlEncode(mapGet(map, -2) as Uint8Array),
				alg: 'RS256'
			},
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['verify']
		);
	} catch {
		return null;
	}
}

/** One unsigned big-endian integer of a DER sequence, left-padded or trimmed to 32 bytes. */
function derInteger(der: Uint8Array, offset: number): { value: Uint8Array; next: number } | null {
	if (der[offset] !== 0x02) return null;
	const length = der[offset + 1]!;
	if (length === undefined || length > 33 || offset + 2 + length > der.length) return null;
	let value = der.subarray(offset + 2, offset + 2 + length);
	while (value.length > 32 && value[0] === 0) value = value.subarray(1);
	if (value.length > 32) return null;
	const padded = new Uint8Array(32);
	padded.set(value, 32 - value.length);
	return { value: padded, next: offset + 2 + length };
}

/** An ECDSA signature in DER (`SEQUENCE { INTEGER r, INTEGER s }`) as the 64-byte r||s WebCrypto verifies. */
export function derToRawEcdsa(der: Uint8Array): Uint8Array | null {
	if (der[0] !== 0x30 || der.length < 8) return null;
	const sequenceLength = der[1]!;
	if (sequenceLength + 2 !== der.length || sequenceLength > 72) return null;
	const r = derInteger(der, 2);
	if (!r) return null;
	const s = derInteger(der, r.next);
	if (!s || s.next !== der.length) return null;
	const raw = new Uint8Array(64);
	raw.set(r.value, 0);
	raw.set(s.value, 32);
	return raw;
}

const sha256 = async (bytes: Uint8Array) =>
	new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

/** A base64url field within the cap, decoded; null otherwise. */
function field(value: string, maxChars = WEBAUTHN_FIELD_MAX_CHARS): Uint8Array | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) return null;
	return base64urlDecode(value);
}

/**
 * `clientDataJSON` checked for `type`, `challenge` (base64url of the issued bytes, compared without padding) and
 * `origin` (exact). Anything else in it (tokenBinding, crossOrigin, topOrigin) is ignored.
 */
export function checkClientData(
	clientDataJSON: Uint8Array,
	expectedType: 'webauthn.create' | 'webauthn.get',
	expected: Pick<ExpectedRegistration, 'challenge' | 'origin'>
): WebAuthnRefusal | null {
	if (clientDataJSON.length > CLIENT_DATA_MAX_CHARS) return 'client_data';
	let data: unknown;
	try {
		data = JSON.parse(new TextDecoder().decode(clientDataJSON));
	} catch {
		return 'client_data';
	}
	if (typeof data !== 'object' || data === null) return 'client_data';
	const { type, challenge, origin } = data as Record<string, unknown>;
	if (type !== expectedType) return 'type';
	if (typeof challenge !== 'string' || challenge.replace(/=+$/, '') !== expected.challenge)
		return 'challenge';
	if (typeof origin !== 'string' || origin !== expected.origin) return 'origin';
	return null;
}

/**
 * Verifies a registration response (attestation `none`: the statement is ignored, never parsed) and returns
 * the credential to store. Refusals: malformed base64url/CBOR/authData, a wrong type/challenge/origin, an
 * rpIdHash of another host, no user presence, no attested credential, an algorithm other than ES256/RS256, or a
 * public key WebCrypto cannot import.
 */
export async function verifyRegistration(
	fields: RegistrationFields,
	expected: ExpectedRegistration
): Promise<RegistrationResult> {
	const attestation = field(fields.attestationObject);
	const clientData = field(fields.clientDataJSON, CLIENT_DATA_MAX_CHARS);
	if (!attestation || !clientData) return { ok: false, reason: 'malformed' };
	const clientProblem = checkClientData(clientData, 'webauthn.create', expected);
	if (clientProblem) return { ok: false, reason: clientProblem };
	let decoded: CborValue;
	try {
		decoded = decodeCbor(attestation).value;
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (!(decoded instanceof Map)) return { ok: false, reason: 'malformed' };
	const authDataBytes = mapGet(decoded, 'authData');
	if (!(authDataBytes instanceof Uint8Array)) return { ok: false, reason: 'malformed' };
	const authData = parseAuthData(authDataBytes);
	if (!authData) return { ok: false, reason: 'malformed' };
	if (!bytesEqual(authData.rpIdHash, await sha256(new TextEncoder().encode(expected.rpId))))
		return { ok: false, reason: 'rp_id' };
	if (!(authData.flags & FLAG_UP)) return { ok: false, reason: 'user_presence' };
	if (!authData.credential) return { ok: false, reason: 'no_credential' };
	const algorithm = coseAlgorithm(authData.credential.publicKey);
	if (algorithm === null) return { ok: false, reason: 'algorithm' };
	if (!(await importCoseKey(authData.credential.publicKey)))
		return { ok: false, reason: 'public_key' };
	return {
		ok: true,
		credential: {
			credentialId: base64urlEncode(authData.credential.id),
			publicKey: base64urlEncode(authData.credential.publicKey),
			algorithm,
			counter: authData.counter,
			aaguid: aaguidToUuid(authData.credential.aaguid),
			backedUp: (authData.flags & FLAG_BE) !== 0 && (authData.flags & FLAG_BS) !== 0,
			userVerified: (authData.flags & FLAG_UV) !== 0
		}
	};
}

/**
 * Verifies an assertion against a stored COSE public key: type/challenge/origin, rpIdHash, user presence, then
 * the signature over `authenticatorData || SHA-256(clientDataJSON)`. The counter is returned for the caller's
 * rollback check (it is a policy, not a signature matter).
 */
export async function verifyAssertion(
	fields: AssertionFields,
	expected: ExpectedRegistration,
	storedPublicKey: string
): Promise<AssertionResult> {
	const authDataBytes = field(fields.authenticatorData);
	const clientData = field(fields.clientDataJSON, CLIENT_DATA_MAX_CHARS);
	const signature = field(fields.signature);
	const coseKey = field(storedPublicKey);
	if (!authDataBytes || !clientData || !signature || !coseKey)
		return { ok: false, reason: 'malformed' };
	const clientProblem = checkClientData(clientData, 'webauthn.get', expected);
	if (clientProblem) return { ok: false, reason: clientProblem };
	const authData = parseAuthData(authDataBytes);
	if (!authData) return { ok: false, reason: 'malformed' };
	if (!bytesEqual(authData.rpIdHash, await sha256(new TextEncoder().encode(expected.rpId))))
		return { ok: false, reason: 'rp_id' };
	if (!(authData.flags & FLAG_UP)) return { ok: false, reason: 'user_presence' };
	const algorithm = coseAlgorithm(coseKey);
	const key = await importCoseKey(coseKey);
	if (algorithm === null || !key) return { ok: false, reason: 'public_key' };
	const signed = new Uint8Array(authDataBytes.length + 32);
	signed.set(authDataBytes, 0);
	signed.set(await sha256(clientData), authDataBytes.length);
	let valid: boolean;
	try {
		if (algorithm === -7) {
			const raw = derToRawEcdsa(signature);
			valid =
				raw !== null &&
				(await crypto.subtle.verify(
					{ name: 'ECDSA', hash: 'SHA-256' },
					key,
					raw as BufferSource,
					signed as BufferSource
				));
		} else {
			valid = await crypto.subtle.verify(
				'RSASSA-PKCS1-v1_5',
				key,
				signature as BufferSource,
				signed as BufferSource
			);
		}
	} catch {
		valid = false;
	}
	if (!valid) return { ok: false, reason: 'signature' };
	return { ok: true, counter: authData.counter, userVerified: (authData.flags & FLAG_UV) !== 0 };
}
