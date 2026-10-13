import { base64urlDecode, base64urlEncode } from '../../shared/base64url.ts';

/**
 * VAPID (RFC 8292): the application server identifies itself to the push service with an ES256 JWT signed by
 * its own P-256 key, on WebCrypto only. Keys come from the Worker secrets VAPID_PUBLIC_KEY (base64url
 * uncompressed point, what the browser gets as `applicationServerKey`), VAPID_PRIVATE_KEY (base64url 32-octet
 * scalar) and VAPID_SUBJECT (`mailto:` or `https:` contact). Generate locally: docs/RUNBOOK.md › Web Push.
 */

export interface VapidKeys {
	/** base64url uncompressed P-256 point (65 octets). Public: sent to the browser. */
	publicKey: string;
	/** base64url 32-octet private scalar. Never leaves the server. */
	privateKey: string;
	subject: string;
}

export interface VapidEnv {
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
}

/** A JWT valid this long (RFC 8292 §2: at most 24 hours). */
const TOKEN_TTL_S = 12 * 60 * 60;

/** The VAPID keys of `env`, or null unless all three are set and well-formed. */
export function vapidKeys(env: VapidEnv | undefined): VapidKeys | null {
	const publicKey = env?.VAPID_PUBLIC_KEY?.trim() ?? '';
	const privateKey = env?.VAPID_PRIVATE_KEY?.trim() ?? '';
	const subject = env?.VAPID_SUBJECT?.trim() ?? '';
	const pub = base64urlDecode(publicKey);
	const priv = base64urlDecode(privateKey);
	if (!pub || pub.length !== 65 || pub[0] !== 0x04) return null;
	if (!priv || priv.length !== 32) return null;
	if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) return null;
	return { publicKey, privateKey, subject };
}

/** Push is usable only with a complete, well-formed VAPID key set; otherwise the UI shows "Belum dikonfigurasi". */
export function isPushConfigured(env: VapidEnv | undefined): boolean {
	return vapidKeys(env) !== null;
}

/** The ES256 signing key of a VAPID key set (JWK built from the raw public point and private scalar). */
async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
	const pub = base64urlDecode(keys.publicKey) as Uint8Array;
	return crypto.subtle.importKey(
		'jwk',
		{
			kty: 'EC',
			crv: 'P-256',
			x: base64urlEncode(pub.slice(1, 33)),
			y: base64urlEncode(pub.slice(33, 65)),
			d: keys.privateKey
		},
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign']
	);
}

const json = (value: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));

/**
 * The `Authorization` header value for a push to `endpoint`: `vapid t=<JWT>, k=<public key>` (RFC 8292 §3).
 * `aud` is the push service's origin; `exp` is `now` + 12 h. WebCrypto's ECDSA signature is already the
 * 64-octet r||s form JWS requires.
 */
export async function vapidAuthorization(
	endpoint: string,
	keys: VapidKeys,
	now: number
): Promise<string> {
	const claims = {
		aud: new URL(endpoint).origin,
		exp: Math.floor(now / 1000) + TOKEN_TTL_S,
		sub: keys.subject
	};
	const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${json(claims)}`;
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		await signingKey(keys),
		new TextEncoder().encode(unsigned)
	);
	return `vapid t=${unsigned}.${base64urlEncode(signature)}, k=${keys.publicKey}`;
}
