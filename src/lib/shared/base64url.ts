/**
 * URL-safe base64 without padding (RFC 4648 §5), the encoding of Web Push keys and JWT parts. Shared: the
 * browser decodes the VAPID public key with it, the Worker encodes keys and tokens.
 */
export function base64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
	return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Bytes turned into one binary string per call to String.fromCharCode (well below engine argument limits). */
const BINARY_CHUNK = 0x8000;

/**
 * Standard base64 with padding (RFC 4648 §4), e.g. an image sent inline to a provider (FN-15). Built from
 * 32 KiB chunks, so a multi-megabyte photo costs a few hundred string joins, not one per byte.
 */
export function base64Encode(bytes: Uint8Array | ArrayBuffer): string {
	const b = new Uint8Array(bytes);
	const parts: string[] = [];
	for (let i = 0; i < b.length; i += BINARY_CHUNK)
		parts.push(String.fromCharCode(...b.subarray(i, i + BINARY_CHUNK)));
	return btoa(parts.join(''));
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The bytes of a base64url string (padding tolerated); null when it is not base64url. */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
	const trimmed = text.replace(/=+$/, '');
	if (!BASE64URL.test(trimmed) || trimmed.length % 4 === 1) return null;
	const binary = atob(trimmed.replace(/-/g, '+').replace(/_/g, '/'));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}
