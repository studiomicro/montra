/**
 * FN-58 e-money cards: the hex helpers every card module shares. Commands and answers travel between the page and the
 * Android bridge as upper-case hex strings, one byte per two characters.
 */

const HEX = /^(?:[0-9A-F]{2})+$/;

/** Upper-case hex without spaces, or null when it is not whole bytes of hex (an empty string is not). */
export function normaliseHex(hex: string): string | null {
	const clean = hex.replace(/\s+/g, '').toUpperCase();
	return HEX.test(clean) ? clean : null;
}

/** The bytes of a hex string, or null when it is not whole bytes of hex. */
export function hexBytes(hex: string): number[] | null {
	const clean = normaliseHex(hex);
	if (!clean) return null;
	return (clean.match(/../g) ?? []).map((b) => parseInt(b, 16));
}

/** One byte (0..255) as two upper-case hex digits. */
export function byteHex(n: number): string {
	return n.toString(16).padStart(2, '0').toUpperCase();
}

/** A FeliCa frame: `body` with its length byte first, the length counting itself (as NfcF.transceive takes it). */
export function felicaFrame(body: string): string {
	return byteHex(body.length / 2 + 1) + body;
}
