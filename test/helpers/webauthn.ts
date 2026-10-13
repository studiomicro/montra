import { base64urlEncode } from '#lib/shared/base64url';

/**
 * A fake WebAuthn authenticator for tests: real ES256 or RS256 keys from WebCrypto, CBOR and DER written by
 * hand, every field tamperable. It produces exactly what a browser hands the page (base64url strings), so the
 * server modules are tested on the wire shape. Test-only; never shipped.
 */

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/** CBOR encoder for ints, text, bytes, arrays and maps (what attestation objects and COSE keys use). */
export function encodeCbor(value: unknown): Uint8Array {
	const out: number[] = [];
	const head = (major: number, n: number) => {
		if (n < 24) out.push((major << 5) | n);
		else if (n < 256) out.push((major << 5) | 24, n);
		else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
		else out.push((major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
	};
	const put = (x: unknown) => {
		if (typeof x === 'number') {
			if (x >= 0) head(0, x);
			else head(1, -1 - x);
		} else if (typeof x === 'string') {
			const b = enc.encode(x);
			head(3, b.length);
			out.push(...b);
		} else if (x instanceof Uint8Array) {
			head(2, x.length);
			out.push(...x);
		} else if (Array.isArray(x)) {
			head(4, x.length);
			for (const item of x) put(item);
		} else if (x instanceof Map) {
			head(5, x.size);
			for (const [k, v] of x) {
				put(k);
				put(v);
			}
		} else if (x === true) out.push(0xf5);
		else if (x === false) out.push(0xf4);
		else if (x === null) out.push(0xf6);
		else throw new Error('unsupported');
	};
	put(value);
	return new Uint8Array(out);
}

const b64uToBytes = (text: string) =>
	Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** A raw r||s ECDSA signature as DER, the form an authenticator sends. */
export function rawToDerEcdsa(raw: Uint8Array): Uint8Array {
	const int = (b: Uint8Array) => {
		let i = 0;
		while (i < b.length - 1 && b[i] === 0) i++;
		let v = b.subarray(i);
		if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
		return concat(new Uint8Array([0x02, v.length]), v);
	};
	const r = int(raw.subarray(0, 32));
	const s = int(raw.subarray(32));
	return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

const sha256 = async (b: Uint8Array) =>
	new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));

export interface FakeAuthenticatorOptions {
	algorithm?: -7 | -257;
	rpId?: string;
	origin?: string;
	aaguid?: Uint8Array;
	/** Starting signature counter (0 for an authenticator that never counts). */
	counter?: number;
	backedUp?: boolean;
}

export interface RegistrationOverrides {
	origin?: string;
	rpId?: string;
	type?: string;
	flags?: number;
	fmt?: string;
}

export interface AssertionOverrides {
	origin?: string;
	rpId?: string;
	type?: string;
	flags?: number;
	/** Signs with this key instead of the credential's (a signature by another key). */
	signWith?: CryptoKey;
	/** Flips one byte of the authenticator data after signing. */
	tamperAuthData?: boolean;
	/** Overrides the counter put in the authenticator data. */
	counter?: number;
}

export class FakeAuthenticator {
	readonly algorithm: -7 | -257;
	readonly rpId: string;
	readonly origin: string;
	readonly credentialId: Uint8Array;
	readonly aaguid: Uint8Array;
	counter: number;
	backedUp: boolean;
	private keys!: CryptoKeyPair;
	private cose!: Uint8Array;

	private constructor(options: FakeAuthenticatorOptions) {
		this.algorithm = options.algorithm ?? -7;
		this.rpId = options.rpId ?? 'localhost';
		this.origin = options.origin ?? 'http://localhost';
		this.credentialId = crypto.getRandomValues(new Uint8Array(16));
		this.aaguid = options.aaguid ?? new Uint8Array(16);
		this.counter = options.counter ?? 0;
		this.backedUp = options.backedUp ?? false;
	}

	static async create(options: FakeAuthenticatorOptions = {}): Promise<FakeAuthenticator> {
		const a = new FakeAuthenticator(options);
		if (a.algorithm === -7) {
			a.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
				'sign',
				'verify'
			]);
			const jwk = await crypto.subtle.exportKey('jwk', a.keys.publicKey);
			a.cose = encodeCbor(
				new Map<number, unknown>([
					[1, 2],
					[3, -7],
					[-1, 1],
					[-2, b64uToBytes(jwk.x!)],
					[-3, b64uToBytes(jwk.y!)]
				])
			);
		} else {
			a.keys = await crypto.subtle.generateKey(
				{
					name: 'RSASSA-PKCS1-v1_5',
					modulusLength: 2048,
					publicExponent: new Uint8Array([1, 0, 1]),
					hash: 'SHA-256'
				},
				true,
				['sign', 'verify']
			);
			const jwk = await crypto.subtle.exportKey('jwk', a.keys.publicKey);
			a.cose = encodeCbor(
				new Map<number, unknown>([
					[1, 3],
					[3, -257],
					[-1, b64uToBytes(jwk.n!)],
					[-2, b64uToBytes(jwk.e!)]
				])
			);
		}
		return a;
	}

	get credentialIdB64(): string {
		return base64urlEncode(this.credentialId);
	}

	get publicKeyB64(): string {
		return base64urlEncode(this.cose);
	}

	get privateKey(): CryptoKey {
		return this.keys.privateKey;
	}

	private flags(overrides: { flags?: number }, attested: boolean): number {
		if (overrides.flags !== undefined) return overrides.flags;
		return 0x01 | 0x04 | (this.backedUp ? 0x08 | 0x10 : 0) | (attested ? 0x40 : 0);
	}

	private counterBytes(counter: number): Uint8Array {
		return new Uint8Array([
			(counter >>> 24) & 255,
			(counter >>> 16) & 255,
			(counter >>> 8) & 255,
			counter & 255
		]);
	}

	/** A registration response (what `navigator.credentials.create` gives, as the page serialises it). */
	async register(challenge: string, overrides: RegistrationOverrides = {}) {
		const rpIdHash = await sha256(enc.encode(overrides.rpId ?? this.rpId));
		const authData = concat(
			rpIdHash,
			new Uint8Array([this.flags(overrides, true)]),
			this.counterBytes(this.counter),
			this.aaguid,
			new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 255]),
			this.credentialId,
			this.cose
		);
		const attestationObject = encodeCbor(
			new Map<string, unknown>([
				['fmt', overrides.fmt ?? 'none'],
				['attStmt', new Map()],
				['authData', authData]
			])
		);
		const clientDataJSON = enc.encode(
			JSON.stringify({
				type: overrides.type ?? 'webauthn.create',
				challenge,
				origin: overrides.origin ?? this.origin,
				crossOrigin: false
			})
		);
		return {
			id: this.credentialIdB64,
			rawId: this.credentialIdB64,
			attestationObject: base64urlEncode(attestationObject),
			clientDataJSON: base64urlEncode(clientDataJSON),
			transports: JSON.stringify(['internal'])
		};
	}

	/** An assertion (what `navigator.credentials.get` gives); the counter advances by one unless it is 0. */
	async assert(challenge: string, overrides: AssertionOverrides = {}) {
		if (overrides.counter === undefined && this.counter > 0) this.counter += 1;
		const counter = overrides.counter ?? this.counter;
		const rpIdHash = await sha256(enc.encode(overrides.rpId ?? this.rpId));
		const authenticatorData = concat(
			rpIdHash,
			new Uint8Array([this.flags(overrides, false)]),
			this.counterBytes(counter)
		);
		const clientDataJSON = enc.encode(
			JSON.stringify({
				type: overrides.type ?? 'webauthn.get',
				challenge,
				origin: overrides.origin ?? this.origin,
				crossOrigin: false
			})
		);
		const signed = concat(authenticatorData, await sha256(clientDataJSON));
		const key = overrides.signWith ?? this.keys.privateKey;
		const raw = new Uint8Array(
			await crypto.subtle.sign(
				this.algorithm === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5',
				key,
				signed as BufferSource
			)
		);
		const signature = this.algorithm === -7 ? rawToDerEcdsa(raw) : raw;
		if (overrides.tamperAuthData) authenticatorData[33]! ^= 0x10;
		return {
			id: this.credentialIdB64,
			rawId: this.credentialIdB64,
			authenticatorData: base64urlEncode(authenticatorData),
			clientDataJSON: base64urlEncode(clientDataJSON),
			signature: base64urlEncode(signature)
		};
	}
}
