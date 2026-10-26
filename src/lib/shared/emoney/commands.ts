/**
 * FN-58 e-money cards: the read-only command rules and the diagnostic probes, shared by the web page and its tests.
 * The Android bridge (native/android-app, MontraNfcPlugin.java `isReadOnlyCommand`) enforces the same rules natively;
 * this copy lets the page refuse a command before it reaches the card. Both are checked against one vector file,
 * `read-only-vectors.txt` (commands.test.ts here, MontraNfcPluginGuardTest.java on Android), and this test also
 * compares the two instruction lists, so a change to one side without the other fails.
 */

import { hexBytes } from './hex';

/** The card's connection as the bridge reports it: an ISO 14443-4 APDU link or a FeliCa frame link. */
export type CardTech = 'isodep' | 'nfcf';

/** ISO 7816-4 instructions that only read: SELECT, READ BINARY, READ RECORD, GET DATA, GET RESPONSE. */
export const READ_ONLY_INS: readonly number[] = [0xa4, 0xb0, 0xb2, 0xca, 0xc0];

/** FeliCa command codes that only read: Polling, Request Service, Request Response, Read Without Encryption, Request System Code. */
export const READ_ONLY_FELICA: readonly number[] = [0x00, 0x02, 0x04, 0x06, 0x0c];

/**
 * An inter-industry class byte (ISO 7816-4 §5.4.1): first inter-industry `000x xxxx` or further `01xx xxxx`. Only
 * under these does an INS keep its standard meaning; under a proprietary class (`1xxx xxxx`, e.g. the 0x80 and 0x90
 * of bank and DESFire commands) the same INS byte may write or debit, and `001x xxxx` is reserved.
 */
function isInterIndustryClass(cla: number): boolean {
	return (cla & 0xe0) === 0x00 || (cla & 0xc0) === 0x40;
}

/**
 * A short APDU whose length matches its header (ISO 7816-3 cases 1–4): `CLA INS P1 P2`, `+ Le`, `+ Lc data`, or
 * `+ Lc data Le`. Extended-length APDUs are refused; no reader needs them.
 */
function isShortApdu(b: readonly number[]): boolean {
	if (b.length === 4 || b.length === 5) return true;
	const lc = b[4]!;
	return lc > 0 && (b.length === 5 + lc || b.length === 6 + lc);
}

/**
 * True when `hex` is a command the bridge lets through: a well-formed short APDU with an inter-industry class and a
 * read-only INS, or a FeliCa frame whose length byte is right and whose command code is a read.
 */
export function isReadOnly(tech: CardTech, hex: string): boolean {
	const b = hexBytes(hex);
	if (!b) return false;
	if (tech === 'nfcf')
		return b.length >= 2 && b[0] === b.length && READ_ONLY_FELICA.includes(b[1]!);
	if (tech === 'isodep')
		return (
			b.length >= 4 &&
			isInterIndustryClass(b[0]!) &&
			READ_ONLY_INS.includes(b[1]!) &&
			isShortApdu(b)
		);
	return false;
}

export type Probe = { name: string; tech: CardTech; hex: string };

/** One command sent to a card and what came back (the response hex, or the error when the send failed). */
export type Exchange = { name: string; command: string; response: string };

/** The message of a failed send as the log shows it (the bridge's reject message, or 'error'). */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : 'error';
}

/**
 * Sends `command` through `transceive` and appends the exchange to `log`. Gives the response hex, or null when the
 * send failed (the failure is in the log, never thrown), so a reader can stop at the first missing answer.
 */
export async function recordExchange(
	log: Exchange[],
	name: string,
	command: string,
	transceive: (hex: string) => Promise<string>
): Promise<string | null> {
	try {
		const response = await transceive(command);
		log.push({ name, command, response });
		return response;
	} catch (error) {
		log.push({ name, command, response: errorText(error) });
		return null;
	}
}

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
