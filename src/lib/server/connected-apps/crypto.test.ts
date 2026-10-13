import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode } from '../../shared/base64url.ts';
import {
	decryptToken,
	encryptToken,
	isConnectedAppsConfigured,
	TOKEN_MAX_BYTES,
	type TokenBinding
} from './crypto.ts';

const key = (fill: number) => base64urlEncode(new Uint8Array(32).fill(fill));
const KEY_A = key(1);
const KEY_B = key(2);
const env = (current?: string, previous?: string) => ({
	CONNECTED_APPS_ENCRYPTION_KEY: current,
	CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS: previous
});
const ROW: TokenBinding = { rowId: 'row-1', spaceId: 'space-1', provider: 'google_sheets' };
const TOKEN = 'ya29.synthetic-access-token-for-tests';

describe('isConnectedAppsConfigured', () => {
	it('is true only for exactly 32 bytes (base64url or standard base64)', () => {
		expect(isConnectedAppsConfigured(env(KEY_A))).toBe(true);
		const standard = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xfb)));
		expect(standard).toMatch(/[+/=]/);
		expect(isConnectedAppsConfigured(env(standard))).toBe(true);
		expect(isConnectedAppsConfigured(env(`  ${KEY_A}\n`))).toBe(true);
	});

	it('is false when unset, empty, malformed or not 32 bytes (never a guessed default)', () => {
		expect(isConnectedAppsConfigured(undefined)).toBe(false);
		expect(isConnectedAppsConfigured(env())).toBe(false);
		expect(isConnectedAppsConfigured(env(''))).toBe(false);
		expect(isConnectedAppsConfigured(env('not a key!'))).toBe(false);
		expect(isConnectedAppsConfigured(env(base64urlEncode(new Uint8Array(31))))).toBe(false);
		expect(isConnectedAppsConfigured(env(base64urlEncode(new Uint8Array(33))))).toBe(false);
		// A previous key alone configures nothing: new seals always use the current key.
		expect(isConnectedAppsConfigured(env(undefined, KEY_A))).toBe(false);
	});
});

describe('encryptToken / decryptToken', () => {
	it('round-trips a synthetic token exactly, with stored-shape fields', async () => {
		const sealed = (await encryptToken(env(KEY_A), TOKEN, ROW))!;
		expect(sealed.nonce).toHaveLength(16);
		expect(base64urlDecode(sealed.nonce)).toHaveLength(12);
		expect(sealed.keyId).toHaveLength(11);
		expect(sealed.ciphertext).not.toContain(TOKEN);
		expect(await decryptToken(env(KEY_A), sealed, ROW)).toBe(TOKEN);
		const unicode = 'tøken-🙂-' + 'x'.repeat(100);
		expect(
			await decryptToken(env(KEY_A), (await encryptToken(env(KEY_A), unicode, ROW))!, ROW)
		).toBe(unicode);
	});

	it('uses a fresh nonce per seal', async () => {
		const nonces = new Set<string>();
		const ciphertexts = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const s = (await encryptToken(env(KEY_A), TOKEN, ROW))!;
			nonces.add(s.nonce);
			ciphertexts.add(s.ciphertext);
		}
		expect(nonces.size).toBe(50);
		expect(ciphertexts.size).toBe(50);
	});

	it('fails closed with a different well-formed key (even when relabelled with that key id)', async () => {
		const sealed = (await encryptToken(env(KEY_A), TOKEN, ROW))!;
		expect(await decryptToken(env(KEY_B), sealed, ROW)).toBeNull();
		const otherId = (await encryptToken(env(KEY_B), TOKEN, ROW))!.keyId;
		expect(await decryptToken(env(KEY_B), { ...sealed, keyId: otherId }, ROW)).toBeNull();
	});

	it('fails closed for a ciphertext moved to another row, space or provider', async () => {
		const sealed = (await encryptToken(env(KEY_A), TOKEN, ROW))!;
		for (const binding of [
			{ ...ROW, rowId: 'row-2' },
			{ ...ROW, spaceId: 'space-2' },
			{ ...ROW, provider: 'notion' as const },
			// No delimiter confusion: the ids are bound as a JSON array.
			{ rowId: 'row-1","space-1', spaceId: '', provider: ROW.provider }
		])
			expect(await decryptToken(env(KEY_A), sealed, binding)).toBeNull();
	});

	it('fails closed for a tampered ciphertext, nonce or key id, and malformed fields', async () => {
		const sealed = (await encryptToken(env(KEY_A), TOKEN, ROW))!;
		const bytes = base64urlDecode(sealed.ciphertext)!;
		bytes[0] = (bytes[0] as number) ^ 1;
		expect(
			await decryptToken(env(KEY_A), { ...sealed, ciphertext: base64urlEncode(bytes) }, ROW)
		).toBeNull();
		const nonce = base64urlDecode(sealed.nonce)!;
		nonce[11] = (nonce[11] as number) ^ 1;
		expect(
			await decryptToken(env(KEY_A), { ...sealed, nonce: base64urlEncode(nonce) }, ROW)
		).toBeNull();
		expect(await decryptToken(env(KEY_A), { ...sealed, keyId: 'AAAAAAAAAAA' }, ROW)).toBeNull();
		expect(await decryptToken(env(KEY_A), { ...sealed, nonce: '!!' }, ROW)).toBeNull();
		expect(
			await decryptToken(env(KEY_A), { ...sealed, nonce: base64urlEncode(new Uint8Array(8)) }, ROW)
		).toBeNull();
		expect(await decryptToken(env(KEY_A), { ...sealed, ciphertext: '' }, ROW)).toBeNull();
	});

	it('seals nothing and opens nothing without a configured key', async () => {
		expect(await encryptToken(env(), TOKEN, ROW)).toBeNull();
		expect(await encryptToken(undefined, TOKEN, ROW)).toBeNull();
		const sealed = (await encryptToken(env(KEY_A), TOKEN, ROW))!;
		expect(await decryptToken(env(), sealed, ROW)).toBeNull();
	});

	it('rotation: the previous key still opens its rows; new seals use the current key', async () => {
		const old = (await encryptToken(env(KEY_A), TOKEN, ROW))!;
		const rotated = env(KEY_B, KEY_A);
		expect(await decryptToken(rotated, old, ROW)).toBe(TOKEN);
		const fresh = (await encryptToken(rotated, TOKEN, ROW))!;
		expect(fresh.keyId).not.toBe(old.keyId);
		expect(await decryptToken(env(KEY_B), fresh, ROW)).toBe(TOKEN);
		// Once the previous key is retired, its rows no longer open.
		expect(await decryptToken(env(KEY_B), old, ROW)).toBeNull();
	});

	it('refuses an empty or over-long token without echoing it', async () => {
		await expect(encryptToken(env(KEY_A), '', ROW)).rejects.toThrow(RangeError);
		const long = 'r'.repeat(TOKEN_MAX_BYTES + 1);
		const error = await encryptToken(env(KEY_A), long, ROW).catch((e: Error) => e);
		expect(error).toBeInstanceOf(RangeError);
		expect(String((error as Error).message)).not.toContain('rrrr');
		expect(await encryptToken(env(KEY_A), 'r'.repeat(TOKEN_MAX_BYTES), ROW)).not.toBeNull();
	});
});

describe('server-seal refactor (FN-41)', () => {
	it('still opens a token sealed by the pre-FN-41 implementation (same labels, same bytes)', async () => {
		// Sealed by connected-apps/crypto.ts as of v0.4.0, before it moved onto server-seal.ts.
		const sealed = {
			ciphertext: 'A8fDCehRdQIEeek0MnrV87Dux56Oyr6YG6rMTuHNJrgW',
			nonce: '1mcBxrqOR3vjtSZP',
			keyId: '_B-PmJLVJh4'
		};
		const binding: TokenBinding = { rowId: 'row-v', spaceId: 'space-v', provider: 'gmail' };
		expect(await decryptToken(env(key(7)), sealed, binding)).toBe('ya29.vector-token');
	});
});
