import { z } from 'zod';
import {
	ACCOUNT_KEY_FIELD_NAMES,
	decodeAccountKey,
	encodeAccountKey,
	type AccountKeyFields
} from '#lib/shared/account-key-fields';
import { KEY_CHECK_BYTES } from '#lib/shared/account-key';
import { base64urlDecode, base64urlEncode } from '#lib/shared/base64url';
import { textField } from '../forms';
import { sha256Hex } from '../util';

/** Longest text a key field may carry before it is decoded (the wrapped key is 86 base64url characters). */
const FIELD_MAX_LENGTH = 200;

const keyFieldsSchema = z
	.object({
		publicKey: z.string().max(FIELD_MAX_LENGTH),
		wrappedPrivateKey: z.string().max(FIELD_MAX_LENGTH),
		wrapNonce: z.string().max(FIELD_MAX_LENGTH),
		kdfSalt: z.string().max(FIELD_MAX_LENGTH),
		kdfParams: z.string().max(FIELD_MAX_LENGTH)
	})
	.strict();

export type AccountKeyForm =
	| { kind: 'absent' }
	| { kind: 'invalid' }
	| { kind: 'present'; fields: AccountKeyFields; keyCheckHash: string };

/**
 * The account key fields a form carries. `absent` when none was sent (JavaScript off or a browser without
 * X25519: no key this request), `invalid` when any is sent but the set is incomplete or not exactly the
 * expected shape (a crafted request trying, say, a weaker scrypt cost is refused, never stored), else the
 * fields as sent, re-encoded canonically, with the SHA-256 (hex) of the key confirmation.
 */
export async function readAccountKeyForm(form: FormData): Promise<AccountKeyForm> {
	const raw = Object.fromEntries(
		ACCOUNT_KEY_FIELD_NAMES.map((name) => [name, textField(form, name)])
	);
	if (
		ACCOUNT_KEY_FIELD_NAMES.every((name) => raw[name] === '') &&
		textField(form, 'keyCheck') === ''
	)
		return { kind: 'absent' };
	const parsed = keyFieldsSchema.safeParse(raw);
	if (!parsed.success) return { kind: 'invalid' };
	// Every byte length and the scrypt cost (never below OWASP's minimum) are checked by the shared decoder.
	const bytes = decodeAccountKey(parsed.data);
	if (!bytes) return { kind: 'invalid' };
	// The key confirmation (shared keyCheck): required with every key write, compared on re-wraps.
	const check = base64urlDecode(textField(form, 'keyCheck').slice(0, FIELD_MAX_LENGTH));
	if (!check || check.length !== KEY_CHECK_BYTES) return { kind: 'invalid' };
	// Only SHA-256 of the canonical key check is kept and compared (red team N2): a leaked row cannot be
	// replayed as a key check.
	return {
		kind: 'present',
		fields: encodeAccountKey(bytes),
		keyCheckHash: await sha256Hex(base64urlEncode(check))
	};
}

/** `updated_at` a re-wrap or password change expects the key row to still have (the stale-form guard). */
export function readKeyVersion(form: FormData): number | null {
	const text = textField(form, 'keyVersion');
	if (!/^\d{1,16}$/.test(text)) return null;
	const n = Number(text);
	return Number.isSafeInteger(n) ? n : null;
}
