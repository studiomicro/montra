import { describe, expect, it } from 'vitest';
import { SCRYPT_PARAMS } from '#lib/shared/account-key';
import { encodeAccountKey } from '#lib/shared/account-key-fields';
import { base64urlEncode } from '#lib/shared/base64url';
import { sha256Hex } from '../util';
import { readAccountKeyForm, readKeyVersion } from './validation';

const fields = encodeAccountKey({
	publicKey: new Uint8Array(32).fill(1),
	wrappedPrivateKey: new Uint8Array(64).fill(2),
	wrapNonce: new Uint8Array(12).fill(3),
	kdfSalt: new Uint8Array(16).fill(4),
	kdfParams: SCRYPT_PARAMS
});
const keyCheck = base64urlEncode(new Uint8Array(32).fill(9));
const form = (entries: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(entries)) f.set(k, v);
	return f;
};

describe('readAccountKeyForm', async () => {
	it('is absent when no key field was sent', async () => {
		expect(await readAccountKeyForm(form({ password: 'x' }))).toEqual({ kind: 'absent' });
	});

	it('is present, re-encoded canonically, for a complete well-formed set with the SHA-256 of its key check (N2)', async () => {
		expect(await readAccountKeyForm(form({ ...fields, keyCheck }))).toEqual({
			kind: 'present',
			fields,
			keyCheckHash: await sha256Hex(keyCheck)
		});
		const padded = { ...fields, wrapNonce: `${fields.wrapNonce}==`, keyCheck: `${keyCheck}=` };
		expect(await readAccountKeyForm(form(padded))).toEqual({
			kind: 'present',
			fields,
			keyCheckHash: await sha256Hex(keyCheck)
		});
	});

	it('is invalid without a 32-byte key check (red team L1), or with a key check alone', async () => {
		expect(await readAccountKeyForm(form({ ...fields }))).toEqual({ kind: 'invalid' });
		expect(await readAccountKeyForm(form({ ...fields, keyCheck: keyCheck.slice(0, 20) }))).toEqual({
			kind: 'invalid'
		});
		expect(await readAccountKeyForm(form({ keyCheck }))).toEqual({ kind: 'invalid' });
	});

	it('is invalid for a partial set, a file in a field, or an over-long field', async () => {
		expect(await readAccountKeyForm(form({ publicKey: fields.publicKey }))).toEqual({
			kind: 'invalid'
		});
		const withFile = form({ ...fields });
		withFile.set('kdfSalt', new Blob(['x']), 'salt.bin');
		expect(await readAccountKeyForm(withFile)).toEqual({ kind: 'invalid' });
		expect(await readAccountKeyForm(form({ ...fields, kdfParams: 'x'.repeat(201) }))).toEqual({
			kind: 'invalid'
		});
	});
});

describe('readKeyVersion', () => {
	it.each([
		['1791408243183', 1791408243183],
		['0', 0],
		['', null],
		['-1', null],
		['1.5', null],
		['1e3', null],
		['99999999999999999', null]
	])('%j → %j', (text, expected) => {
		expect(readKeyVersion(form({ keyVersion: text }))).toBe(expected);
	});
});
