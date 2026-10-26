/**
 * FN-58 e-money cards: the read-only command rules and the diagnostic probes, shared by the web page and its tests.
 * The Android bridge (native/android-app, MontraNfcPlugin.java) enforces the same lists natively; this copy lets the
 * page refuse a command before it reaches the card and keeps both lists under one test.
 */

/** The card's connection as the bridge reports it: an ISO 14443-4 APDU link or a FeliCa frame link. */
export type CardTech = 'isodep' | 'nfcf';

/** ISO 7816-4 instructions that only read: SELECT, READ BINARY, READ RECORD, GET DATA, GET RESPONSE. */
export const READ_ONLY_INS: readonly number[] = [0xa4, 0xb0, 0xb2, 0xca, 0xc0];

/** FeliCa command codes that only read: Polling, Request Service, Request Response, Read Without Encryption, Request System Code. */
export const READ_ONLY_FELICA: readonly number[] = [0x00, 0x02, 0x04, 0x06, 0x0c];

const HEX = /^(?:[0-9A-F]{2})+$/;

/** Upper-case hex without spaces, or null when it is not whole bytes of hex. */
export function normaliseHex(hex: string): string | null {
	const clean = hex.replace(/\s+/g, '').toUpperCase();
	return HEX.test(clean) ? clean : null;
}

/** True when `hex` is a command the bridge lets through: an APDU with a read-only INS, or a read-only FeliCa frame. */
export function isReadOnly(tech: CardTech, hex: string): boolean {
	const clean = normaliseHex(hex);
	if (!clean) return false;
	const byte = (i: number) => parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	const length = clean.length / 2;
	if (tech === 'nfcf')
		return length >= 2 && byte(0) === length && READ_ONLY_FELICA.includes(byte(1));
	return length >= 4 && READ_ONLY_INS.includes(byte(1));
}

/** The status word (last two bytes) of an APDU response, e.g. '9000', or null for a too-short answer. */
export function statusWord(responseHex: string): string | null {
	const clean = normaliseHex(responseHex);
	return clean && clean.length >= 4 ? clean.slice(-4) : null;
}

export type Probe = { name: string; tech: CardTech; hex: string };

/**
 * What "Diagnosa kartu" sends to a tapped card: only standard ISO 7816-4 and FeliCa reads that any reader may send,
 * no issuer's own command. The answers tell which card it is; an issuer's balance reader is written from its public
 * source and checked against these logs (owner decision 2026-10-26).
 */
export const PROBES: readonly Probe[] = [
	{ name: 'SELECT MF (3F00)', tech: 'isodep', hex: '00A40000023F00' },
	{
		name: 'SELECT PPSE (2PAY.SYS.DDF01)',
		tech: 'isodep',
		hex: '00A404000E325041592E5359532E444446303100'
	},
	{
		name: 'SELECT PSE (1PAY.SYS.DDF01)',
		tech: 'isodep',
		hex: '00A404000E315041592E5359532E444446303100'
	},
	{ name: 'FeliCa Polling (any system)', tech: 'nfcf', hex: '0600FFFF0100' }
];

/**
 * Digits in a log that could be a card number: any run of 12 or more decimal digits in a hex string (card numbers are
 * often stored as BCD), kept to its last 4. Applied to every response before the log is shown or copied.
 */
export function maskLongDigitRuns(hex: string): string {
	return hex.replace(/\d{12,}/g, (run) => '•'.repeat(run.length - 4) + run.slice(-4));
}
