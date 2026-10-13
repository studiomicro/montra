import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode } from '../../shared/base64url';
import { isPushConfigured, vapidAuthorization, vapidKeys } from './vapid';

const ES256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const bytes = (text: string) => base64urlDecode(text) as Uint8Array<ArrayBuffer>;

async function verify(token: string, publicRaw: Uint8Array<ArrayBuffer>) {
	const [h, p, s] = token.split('.') as [string, string, string];
	const key = await crypto.subtle.importKey('raw', publicRaw, ES256, false, ['verify']);
	return crypto.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		bytes(s),
		new TextEncoder().encode(`${h}.${p}`)
	);
}

/** A fresh VAPID key set in the env format (what `npx web-push generate-vapid-keys` prints). */
async function generatedEnv() {
	const pair = (await crypto.subtle.generateKey(ES256, true, ['sign', 'verify'])) as CryptoKeyPair;
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
	return {
		raw,
		env: {
			VAPID_PUBLIC_KEY: base64urlEncode(raw),
			VAPID_PRIVATE_KEY: jwk.d as string,
			VAPID_SUBJECT: 'mailto:dev@montra.local'
		}
	};
}

describe('VAPID (RFC 8292)', () => {
	it('verifies the RFC 8292 §2.4 example token with its JWK: the r||s signature form matches', async () => {
		const token =
			'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA';
		const k = bytes(
			'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs'
		);
		// The RFC's JWK x/y are the same point as its k= value.
		expect(base64urlEncode(k.slice(1, 33))).toBe('DUfHPKLVFQzVvnCPGyfucbECzPDa7rWbXriLcysAjEc');
		expect(await verify(token, k)).toBe(true);
	});

	it('signs a token the public key verifies, with aud = push origin, exp ≤ 24 h and sub', async () => {
		const { raw, env } = await generatedEnv();
		const keys = vapidKeys(env);
		expect(keys).not.toBeNull();
		const now = Date.UTC(2026, 9, 8, 3, 0, 0);
		const header = await vapidAuthorization(
			'https://fcm.googleapis.com/fcm/send/abc:def',
			keys!,
			now
		);
		const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
		expect(m?.[2]).toBe(env.VAPID_PUBLIC_KEY);
		const token = m![1] as string;
		expect(await verify(token, raw)).toBe(true);
		const claims = JSON.parse(new TextDecoder().decode(bytes(token.split('.')[1] as string)));
		expect(claims).toEqual({
			aud: 'https://fcm.googleapis.com',
			exp: now / 1000 + 12 * 3600,
			sub: 'mailto:dev@montra.local'
		});
		// The private scalar never appears in what is sent.
		expect(header).not.toContain(env.VAPID_PRIVATE_KEY);
	});

	it('is configured only when all three values are present and well-formed', async () => {
		const { env } = await generatedEnv();
		expect(isPushConfigured(env)).toBe(true);
		expect(isPushConfigured(undefined)).toBe(false);
		expect(isPushConfigured({})).toBe(false);
		expect(isPushConfigured({ ...env, VAPID_PUBLIC_KEY: '' })).toBe(false);
		expect(isPushConfigured({ ...env, VAPID_PRIVATE_KEY: undefined })).toBe(false);
		expect(isPushConfigured({ ...env, VAPID_SUBJECT: '  ' })).toBe(false);
		expect(isPushConfigured({ ...env, VAPID_SUBJECT: 'http://insecure.example' })).toBe(false);
		expect(isPushConfigured({ ...env, VAPID_PUBLIC_KEY: env.VAPID_PRIVATE_KEY })).toBe(false);
		expect(isPushConfigured({ ...env, VAPID_PRIVATE_KEY: 'not base64!' })).toBe(false);
	});
});
