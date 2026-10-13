/**
 * FN-30 voucher codes in Crockford base32 (digits and letters without I, L, O, U): unambiguous to read aloud or
 * type. Generated codes carry 80 random bits (16 symbols, shown as four groups of four). A typed code is
 * normalised before hashing: case, spaces and dashes ignored, and the look-alikes Crockford defines (O → 0,
 * I and L → 1) folded, so "abcd-efgh" and "ABCDEFGH" are one code. Plain module (no aliases): the local seed
 * script imports it under Node.
 */

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Shortest accepted code (symbols, separators not counted). */
export const VOUCHER_CODE_MIN = 10;
export const VOUCHER_CODE_MAX = 32;
const GENERATED_LENGTH = 16;

/** The canonical form of a typed code, or null when it cannot be a code. */
export function normalizeVoucherCode(input: string): string | null {
	if (input.length > 100) return null;
	const folded = input
		.toUpperCase()
		.replace(/[\s-]+/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1');
	if (folded.length < VOUCHER_CODE_MIN || folded.length > VOUCHER_CODE_MAX) return null;
	for (const ch of folded) if (!CROCKFORD.includes(ch)) return null;
	return folded;
}

/** A fresh 16-symbol code (80 bits from the platform CSPRNG), grouped `XXXX-XXXX-XXXX-XXXX` for display. */
export function generateVoucherCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	let bits = 0;
	let value = 0;
	let out = '';
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += CROCKFORD[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		value &= (1 << bits) - 1;
	}
	return (out.slice(0, GENERATED_LENGTH).match(/.{4}/g) ?? []).join('-');
}
