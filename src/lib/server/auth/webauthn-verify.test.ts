import { describe, expect, it } from 'vitest';
import { base64urlEncode } from '#lib/shared/base64url';
import { encodeCbor, FakeAuthenticator, rawToDerEcdsa } from '../../../../test/helpers/webauthn';
import {
	aaguidToUuid,
	checkClientData,
	coseAlgorithm,
	decodeCbor,
	derToRawEcdsa,
	parseAuthData,
	verifyAssertion,
	verifyRegistration,
	WEBAUTHN_FIELD_MAX_CHARS
} from './webauthn-verify';

const CHALLENGE = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
const EXPECTED = { challenge: CHALLENGE, origin: 'http://localhost', rpId: 'localhost' };

describe('decodeCbor', () => {
	it('decodes ints, negative ints, text, bytes, arrays and maps, reporting the length used', () => {
		const bytes = encodeCbor(
			new Map<unknown, unknown>([
				[1, 2],
				[3, -7],
				['s', 'teks'],
				[-2, new Uint8Array([1, 2, 3])],
				[4, [1, true, null]]
			])
		);
		const { value, length } = decodeCbor(new Uint8Array([...bytes, 0xff, 0xff]));
		expect(length).toBe(bytes.length);
		const map = value as Map<unknown, unknown>;
		expect(map.get(1)).toBe(2);
		expect(map.get(3)).toBe(-7);
		expect(map.get('s')).toBe('teks');
		expect(map.get(-2)).toEqual(new Uint8Array([1, 2, 3]));
		expect(map.get(4)).toEqual([1, true, null]);
	});

	it('refuses indefinite lengths, truncated input, deep nesting and huge containers', () => {
		expect(() => decodeCbor(new Uint8Array([0x9f]))).toThrow();
		expect(() => decodeCbor(new Uint8Array([0x58, 0x10, 1, 2]))).toThrow(/eof/);
		let nested: unknown = 1;
		for (let i = 0; i < 12; i++) nested = [nested];
		expect(() => decodeCbor(encodeCbor(nested))).toThrow(/depth/);
		expect(() => decodeCbor(new Uint8Array([0x98, 0x64]))).toThrow(/items/);
		expect(() => decodeCbor(new Uint8Array([0x1b, 0, 0, 0, 0, 0, 0, 0, 1]))).toThrow(/length/);
	});
});

describe('derToRawEcdsa', () => {
	it('round-trips a raw signature through DER, including high-bit and leading-zero integers', () => {
		const raw = new Uint8Array(64);
		raw[0] = 0x80;
		raw[1] = 0x01;
		raw[32] = 0x00;
		raw[33] = 0x00;
		raw[34] = 0x7f;
		raw[63] = 0x01;
		expect(derToRawEcdsa(rawToDerEcdsa(raw))).toEqual(raw);
	});

	it('refuses a non-sequence, a wrong length and an oversized integer', () => {
		expect(derToRawEcdsa(new Uint8Array([0x02, 0x01, 0x01]))).toBeNull();
		expect(derToRawEcdsa(new Uint8Array([0x30, 0x10, 0x02, 0x01, 0x01]))).toBeNull();
		const big = new Uint8Array([
			0x30,
			0x27,
			0x02,
			0x22,
			0x01,
			...new Uint8Array(33),
			0x02,
			0x01,
			0x01
		]);
		expect(derToRawEcdsa(big)).toBeNull();
	});
});

describe('parseAuthData and aaguidToUuid', () => {
	it('refuses data shorter than 37 bytes, a truncated credential and trailing garbage', async () => {
		expect(parseAuthData(new Uint8Array(36))).toBeNull();
		const a = await FakeAuthenticator.create();
		const reg = await a.register(CHALLENGE);
		const attestation = decodeCbor(
			Uint8Array.from(atob(reg.attestationObject.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
				c.charCodeAt(0)
			)
		).value as Map<string, Uint8Array>;
		const authData = attestation.get('authData')!;
		expect(parseAuthData(authData)?.credential?.id).toEqual(a.credentialId);
		expect(parseAuthData(authData.subarray(0, 60))).toBeNull();
		expect(parseAuthData(new Uint8Array([...authData, 0x00]))).toBeNull();
	});

	it('formats the AAGUID as a UUID', () => {
		expect(aaguidToUuid(new Uint8Array(16))).toBe('00000000-0000-0000-0000-000000000000');
		expect(
			aaguidToUuid(
				new Uint8Array([
					0xad, 0xce, 0, 2, 0x35, 0xbc, 0xc6, 0x0a, 0x64, 0x8b, 0x0b, 0x25, 0xf1, 0xf0, 0x55, 0x03
				])
			)
		).toBe('adce0002-35bc-c60a-648b-0b25f1f05503');
	});
});

describe('coseAlgorithm', () => {
	it('accepts ES256 P-256 and RS256 keys, refuses other algorithms, curves and shapes', async () => {
		const es = await FakeAuthenticator.create({ algorithm: -7 });
		const rs = await FakeAuthenticator.create({ algorithm: -257 });
		const decode = (s: string) =>
			Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
		expect(coseAlgorithm(decode(es.publicKeyB64))).toBe(-7);
		expect(coseAlgorithm(decode(rs.publicKeyB64))).toBe(-257);
		// EdDSA (-8) is not accepted; a P-384 curve under alg -7 is refused; a map without alg is refused.
		expect(
			coseAlgorithm(
				encodeCbor(
					new Map<number, unknown>([
						[1, 1],
						[3, -8],
						[-1, 6],
						[-2, new Uint8Array(32)]
					])
				)
			)
		).toBeNull();
		expect(
			coseAlgorithm(
				encodeCbor(
					new Map<number, unknown>([
						[1, 2],
						[3, -7],
						[-1, 2],
						[-2, new Uint8Array(48)],
						[-3, new Uint8Array(48)]
					])
				)
			)
		).toBeNull();
		expect(coseAlgorithm(encodeCbor(new Map([[1, 2]])))).toBeNull();
		expect(coseAlgorithm(new Uint8Array([0xff]))).toBeNull();
	});
});

describe('checkClientData', () => {
	const json = (o: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(o));
	it('passes the exact type, challenge (padding tolerated) and origin; refuses each deviation', () => {
		const ok = { type: 'webauthn.get', challenge: CHALLENGE, origin: 'http://localhost' };
		expect(checkClientData(json(ok), 'webauthn.get', EXPECTED)).toBeNull();
		expect(
			checkClientData(json({ ...ok, challenge: `${CHALLENGE}=` }), 'webauthn.get', EXPECTED)
		).toBeNull();
		expect(
			checkClientData(json({ ...ok, type: 'webauthn.create' }), 'webauthn.get', EXPECTED)
		).toBe('type');
		expect(checkClientData(json({ ...ok, challenge: 'AAAA' }), 'webauthn.get', EXPECTED)).toBe(
			'challenge'
		);
		expect(
			checkClientData(json({ ...ok, origin: 'https://evil.example' }), 'webauthn.get', EXPECTED)
		).toBe('origin');
		expect(checkClientData(new TextEncoder().encode('{nope'), 'webauthn.get', EXPECTED)).toBe(
			'client_data'
		);
		expect(checkClientData(json({}), 'webauthn.get', EXPECTED)).toBe('type');
	});
});

describe('verifyRegistration', () => {
	it.each([-7, -257] as const)(
		'accepts a %d registration and returns the stored shape',
		async (algorithm) => {
			const a = await FakeAuthenticator.create({ algorithm, counter: 3, backedUp: true });
			const result = await verifyRegistration(await a.register(CHALLENGE), EXPECTED);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.credential).toEqual({
				credentialId: a.credentialIdB64,
				publicKey: a.publicKeyB64,
				algorithm,
				counter: 3,
				aaguid: '00000000-0000-0000-0000-000000000000',
				backedUp: true,
				userVerified: true
			});
		}
	);

	it('ignores the attestation format (none requested; a packed statement is never parsed)', async () => {
		const a = await FakeAuthenticator.create();
		expect(
			(await verifyRegistration(await a.register(CHALLENGE, { fmt: 'packed' }), EXPECTED)).ok
		).toBe(true);
	});

	it('refuses a wrong origin, another host’s rpIdHash, a wrong type, a stale challenge, no UP and no AT', async () => {
		const a = await FakeAuthenticator.create();
		const reason = async (r: Awaited<ReturnType<FakeAuthenticator['register']>>) => {
			const v = await verifyRegistration(r, EXPECTED);
			return v.ok ? 'ok' : v.reason;
		};
		expect(await reason(await a.register(CHALLENGE, { origin: 'https://evil.example' }))).toBe(
			'origin'
		);
		expect(await reason(await a.register(CHALLENGE, { rpId: 'evil.example' }))).toBe('rp_id');
		expect(await reason(await a.register(CHALLENGE, { type: 'webauthn.get' }))).toBe('type');
		expect(await reason(await a.register('lain'))).toBe('challenge');
		expect(await reason(await a.register(CHALLENGE, { flags: 0x44 }))).toBe('user_presence');
		expect(await reason(await a.register(CHALLENGE, { flags: 0x05 }))).toBe('malformed');
	});

	it('answers malformed input (bad base64url, bad CBOR, over-length) with a refusal, never a throw', async () => {
		const a = await FakeAuthenticator.create();
		const good = await a.register(CHALLENGE);
		expect(await verifyRegistration({ ...good, attestationObject: '!!!' }, EXPECTED)).toEqual({
			ok: false,
			reason: 'malformed'
		});
		expect(await verifyRegistration({ ...good, attestationObject: 'AAAA' }, EXPECTED)).toEqual({
			ok: false,
			reason: 'malformed'
		});
		expect(
			await verifyRegistration(
				{ ...good, attestationObject: 'A'.repeat(WEBAUTHN_FIELD_MAX_CHARS + 1) },
				EXPECTED
			)
		).toEqual({ ok: false, reason: 'malformed' });
		expect(
			await verifyRegistration({ attestationObject: '', clientDataJSON: '' }, EXPECTED)
		).toEqual({
			ok: false,
			reason: 'malformed'
		});
		// A CBOR array instead of a map, and a map without authData.
		expect(
			await verifyRegistration(
				{ ...good, attestationObject: base64urlEncode(encodeCbor([1, 2])) },
				EXPECTED
			)
		).toEqual({ ok: false, reason: 'malformed' });
		expect(
			await verifyRegistration(
				{ ...good, attestationObject: base64urlEncode(encodeCbor(new Map([['fmt', 'none']]))) },
				EXPECTED
			)
		).toEqual({ ok: false, reason: 'malformed' });
	});
});

describe('verifyAssertion', () => {
	it.each([-7, -257] as const)(
		'accepts a %d assertion and returns its counter',
		async (algorithm) => {
			const a = await FakeAuthenticator.create({ algorithm, counter: 5 });
			const result = await verifyAssertion(await a.assert(CHALLENGE), EXPECTED, a.publicKeyB64);
			expect(result).toEqual({ ok: true, counter: 6, userVerified: true });
		}
	);

	it('refuses a wrong origin, rpIdHash, type, altered authData, another key’s signature and a bad key', async () => {
		const a = await FakeAuthenticator.create();
		const other = await FakeAuthenticator.create();
		const reason = async (
			r: Awaited<ReturnType<FakeAuthenticator['assert']>>,
			key = a.publicKeyB64
		) => {
			const v = await verifyAssertion(r, EXPECTED, key);
			return v.ok ? 'ok' : v.reason;
		};
		expect(await reason(await a.assert(CHALLENGE, { origin: 'https://evil.example' }))).toBe(
			'origin'
		);
		expect(await reason(await a.assert(CHALLENGE, { rpId: 'evil.example' }))).toBe('rp_id');
		expect(await reason(await a.assert(CHALLENGE, { type: 'webauthn.create' }))).toBe('type');
		expect(await reason(await a.assert(CHALLENGE, { tamperAuthData: true }))).toBe('signature');
		expect(await reason(await a.assert(CHALLENGE, { signWith: other.privateKey }))).toBe(
			'signature'
		);
		expect(await reason(await a.assert(CHALLENGE), other.publicKeyB64)).toBe('signature');
		expect(await reason(await a.assert(CHALLENGE), 'AAAA')).toBe('public_key');
		expect(await reason(await a.assert(CHALLENGE, { flags: 0x04 }))).toBe('user_presence');
		expect(await reason({ ...(await a.assert(CHALLENGE)), signature: '%%' })).toBe('malformed');
	});
});

/**
 * A real browser-made vector, not one from the test helper: Chromium's CDP virtual authenticator registered a
 * credential and signed one assertion at http://localhost (test/fixtures/webauthn/, recorded 2026-10-12 with the
 * script described there). The same fixture verified on workerd with both this module and
 * `@simplewebauthn/server` 14.0.3 during the FN-50 library spike.
 */
describe('a recorded Chromium registration and assertion', async () => {
	const { default: vector } =
		await import('../../../../test/fixtures/webauthn/chromium-virtual-es256.json');
	const expected = (challenge: string) => ({ challenge, origin: vector.origin, rpId: vector.rpId });

	it('verifies the registration and the assertion signed by its key', async () => {
		const reg = await verifyRegistration(
			vector.registration,
			expected(vector.registration.challenge)
		);
		expect(reg.ok).toBe(true);
		if (!reg.ok) return;
		expect(reg.credential).toMatchObject({
			credentialId: vector.registration.id,
			algorithm: -7,
			counter: 1,
			aaguid: '01020304-0506-0708-0102-030405060708',
			userVerified: true
		});
		const auth = await verifyAssertion(
			vector.assertion,
			expected(vector.assertion.challenge),
			reg.credential.publicKey
		);
		expect(auth).toEqual({ ok: true, counter: 2, userVerified: true });
	});

	it('refuses the same vector against another origin, rpId or challenge', async () => {
		const reg = await verifyRegistration(
			vector.registration,
			expected(vector.registration.challenge)
		);
		if (!reg.ok) throw new Error('registration vector did not verify');
		const key = reg.credential.publicKey;
		const base = expected(vector.assertion.challenge);
		for (const [over, reason] of [
			[{ origin: 'https://evil.example' }, 'origin'],
			[{ rpId: 'evil.example' }, 'rp_id'],
			[{ challenge: vector.registration.challenge }, 'challenge']
		] as const)
			expect(await verifyAssertion(vector.assertion, { ...base, ...over }, key)).toEqual({
				ok: false,
				reason
			});
		expect(
			await verifyRegistration(vector.registration, {
				...expected(vector.registration.challenge),
				origin: 'https://evil.example'
			})
		).toEqual({ ok: false, reason: 'origin' });
	});
});
