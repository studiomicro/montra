import { deserialize, type ActionResult } from '$app/forms';
import { base64urlDecode, base64urlEncode } from '#lib/shared/base64url';

/**
 * FN-50: the browser side of passkeys. The server speaks JSON with base64url fields (what WebAuthn Level 3 calls
 * the JSON forms); these helpers turn it into the ArrayBuffers `navigator.credentials` wants and back, without
 * relying on `PublicKeyCredential.parseCreationOptionsFromJSON` (absent in older WebKit). Browser only.
 */

export function isPasskeySupported(): boolean {
	return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

/** Whether the browser can offer a passkey in the e-mail field's autofill (conditional mediation). */
export async function isConditionalMediationAvailable(): Promise<boolean> {
	if (!isPasskeySupported()) return false;
	const check = (
		window.PublicKeyCredential as unknown as {
			isConditionalMediationAvailable?: () => Promise<boolean>;
		}
	).isConditionalMediationAvailable;
	if (typeof check !== 'function') return false;
	try {
		return await check();
	} catch {
		return false;
	}
}

const bytes = (text: string): ArrayBuffer => {
	const decoded = base64urlDecode(text);
	if (!decoded) throw new TypeError('not base64url');
	return decoded.buffer;
};

interface CredentialDescriptorJson {
	type: 'public-key';
	id: string;
	transports?: string[];
}

export interface CreationOptionsJson {
	rp: { id: string; name: string };
	user: { id: string; name: string; displayName: string };
	challenge: string;
	pubKeyCredParams: { type: 'public-key'; alg: number }[];
	timeout: number;
	attestation: 'none';
	authenticatorSelection: { residentKey: 'preferred'; userVerification: 'preferred' };
	excludeCredentials: CredentialDescriptorJson[];
}

export interface RequestOptionsJson {
	rpId: string;
	challenge: string;
	timeout: number;
	userVerification: 'preferred';
	allowCredentials: CredentialDescriptorJson[];
}

export function toCreationOptions(json: CreationOptionsJson): PublicKeyCredentialCreationOptions {
	return {
		rp: json.rp,
		user: { id: bytes(json.user.id), name: json.user.name, displayName: json.user.displayName },
		challenge: bytes(json.challenge),
		pubKeyCredParams: json.pubKeyCredParams,
		timeout: json.timeout,
		attestation: json.attestation,
		authenticatorSelection: json.authenticatorSelection,
		excludeCredentials: json.excludeCredentials.map((c) => ({
			type: c.type,
			id: bytes(c.id),
			transports: c.transports as AuthenticatorTransport[] | undefined
		}))
	};
}

export function toRequestOptions(json: RequestOptionsJson): PublicKeyCredentialRequestOptions {
	return {
		rpId: json.rpId,
		challenge: bytes(json.challenge),
		timeout: json.timeout,
		userVerification: json.userVerification,
		allowCredentials: json.allowCredentials.map((c) => ({ type: c.type, id: bytes(c.id) }))
	};
}

/** The fields the `register` action reads, from a created credential. */
export function registrationFields(credential: PublicKeyCredential): Record<string, string> {
	const response = credential.response as AuthenticatorAttestationResponse;
	const transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
	return {
		id: credential.id,
		attestationObject: base64urlEncode(response.attestationObject),
		clientDataJSON: base64urlEncode(response.clientDataJSON),
		transports: JSON.stringify(transports)
	};
}

/** The fields the `passkey` sign-in action reads, from an assertion. */
export function assertionFields(credential: PublicKeyCredential): Record<string, string> {
	const response = credential.response as AuthenticatorAssertionResponse;
	return {
		id: credential.id,
		authenticatorData: base64urlEncode(response.authenticatorData),
		clientDataJSON: base64urlEncode(response.clientDataJSON),
		signature: base64urlEncode(response.signature)
	};
}

/**
 * Posts `fields` to a form action (`/masuk?/passkey`) the way `use:enhance` does and returns the deserialised
 * ActionResult, so the caller sees the same `success` / `failure` / `redirect` shapes as a form submit.
 */
export async function postAction(
	url: string,
	fields: Record<string, string>
): Promise<ActionResult> {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	const response = await fetch(url, {
		method: 'POST',
		body,
		headers: { 'x-sveltekit-action': 'true', accept: 'application/json' }
	});
	return deserialize(await response.text());
}

/** True when the user dismissed or timed out the browser's passkey prompt (nothing to send, nothing to blame). */
export function isCancelled(e: unknown): boolean {
	return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
}
