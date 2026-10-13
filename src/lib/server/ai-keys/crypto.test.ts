import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode } from '../../shared/base64url.ts';
import { encryptToken } from '../connected-apps/crypto.ts';
import { isAiKeysConfigured, openAiKey, sealAiKey, type AiKeyBinding } from './crypto.ts';

const key = (fill: number) => base64urlEncode(new Uint8Array(32).fill(fill));
const KEY_A = key(1);
const KEY_B = key(2);
const env = (current?: string, previous?: string) => ({
	AI_KEYS_ENCRYPTION_KEY: current,
	AI_KEYS_ENCRYPTION_KEY_PREVIOUS: previous
});
const ROW: AiKeyBinding = { rowId: 'row-1', userId: 'user-1', provider: 'anthropic' };
const SECRET = 'sk-ant-api03-synthetic-test-key-AbCd';

describe('isAiKeysConfigured', () => {
	it('is true only for exactly 32 bytes; a previous key alone configures nothing', () => {
		expect(isAiKeysConfigured(env(KEY_A))).toBe(true);
		expect(isAiKeysConfigured(undefined)).toBe(false);
		expect(isAiKeysConfigured(env(''))).toBe(false);
		expect(isAiKeysConfigured(env('not a key'))).toBe(false);
		expect(isAiKeysConfigured(env(base64urlEncode(new Uint8Array(31))))).toBe(false);
		expect(isAiKeysConfigured(env(undefined, KEY_A))).toBe(false);
		// The connected-apps secret is not this feature's (owner decision 2).
		expect(isAiKeysConfigured({ CONNECTED_APPS_ENCRYPTION_KEY: KEY_A } as never)).toBe(false);
	});
});

describe('sealAiKey / openAiKey', () => {
	it('round-trips with stored-shape fields and a fresh nonce per seal', async () => {
		const sealed = (await sealAiKey(env(KEY_A), SECRET, ROW))!;
		expect(base64urlDecode(sealed.nonce)).toHaveLength(12);
		expect(sealed.keyId).toHaveLength(11);
		expect(sealed.ciphertext).not.toContain('sk-ant');
		expect(await openAiKey(env(KEY_A), sealed, ROW)).toBe(SECRET);
		const again = (await sealAiKey(env(KEY_A), SECRET, ROW))!;
		expect(again.nonce).not.toBe(sealed.nonce);
		expect(again.ciphertext).not.toBe(sealed.ciphertext);
	});

	it('fails closed for another row, user or a wrong key', async () => {
		const sealed = (await sealAiKey(env(KEY_A), SECRET, ROW))!;
		expect(await openAiKey(env(KEY_A), sealed, { ...ROW, rowId: 'row-2' })).toBeNull();
		expect(await openAiKey(env(KEY_A), sealed, { ...ROW, userId: 'user-2' })).toBeNull();
		expect(await openAiKey(env(KEY_B), sealed, ROW)).toBeNull();
		expect(await openAiKey(env(), sealed, ROW)).toBeNull();
		const bytes = base64urlDecode(sealed.ciphertext)!;
		bytes[0] = (bytes[0] as number) ^ 1;
		expect(
			await openAiKey(env(KEY_A), { ...sealed, ciphertext: base64urlEncode(bytes) }, ROW)
		).toBeNull();
	});

	it('is domain-separated from connected-app tokens under the same secret value', async () => {
		const token = (await encryptToken({ CONNECTED_APPS_ENCRYPTION_KEY: KEY_A }, SECRET, {
			rowId: 'row-1',
			spaceId: 'user-1',
			provider: 'gmail'
		}))!;
		expect(await openAiKey(env(KEY_A), token, ROW)).toBeNull();
		expect(token.keyId).not.toBe((await sealAiKey(env(KEY_A), SECRET, ROW))!.keyId);
	});

	it('rotation: a row sealed under the previous key still opens (criterion 11)', async () => {
		const old = (await sealAiKey(env(KEY_A), SECRET, ROW))!;
		expect(await openAiKey(env(KEY_B, KEY_A), old, ROW)).toBe(SECRET);
		const fresh = (await sealAiKey(env(KEY_B, KEY_A), SECRET, ROW))!;
		expect(await openAiKey(env(KEY_B), fresh, ROW)).toBe(SECRET);
		expect(await openAiKey(env(KEY_B), old, ROW)).toBeNull();
	});

	it('seals nothing without a key; refuses an empty or over-long value without echoing it', async () => {
		expect(await sealAiKey(env(), SECRET, ROW)).toBeNull();
		await expect(sealAiKey(env(KEY_A), '', ROW)).rejects.toThrow(RangeError);
		const e = await sealAiKey(env(KEY_A), 'sk-ant-' + 'q'.repeat(400), ROW).catch((x: Error) => x);
		expect(e).toBeInstanceOf(RangeError);
		expect(String((e as Error).message)).not.toContain('qqqq');
	});
});
