/// <reference lib="webworker" />
import { deriveWrapKey, type ScryptParams } from '#lib/shared/account-key';

/**
 * Runs scrypt (128 MiB, a fraction of a second) off the main thread so the form keeps its spinner moving.
 * Answers with the non-extractable AES-GCM wrap key (a CryptoKey is structured-cloneable); the password and
 * the key never leave the device. One derivation per worker: the page terminates it afterwards.
 */
interface DeriveRequest {
	password: string;
	salt: Uint8Array;
	params: ScryptParams;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', async (event: MessageEvent<DeriveRequest>) => {
	try {
		const { password, salt, params } = event.data;
		scope.postMessage({ ok: true, key: await deriveWrapKey(password, salt, params) });
	} catch {
		scope.postMessage({ ok: false });
	}
});
