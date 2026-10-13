import { crc32 } from 'node:zlib';
import { expect } from 'vitest';

/**
 * A small ZIP reader independent of src/lib/shared/zip.ts (Node's own CRC-32): entries from the central
 * directory, data from the local records, every CRC and data descriptor checked. Store method only.
 */
export function readZip(zip: Uint8Array): Map<string, Uint8Array> {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const eocd = zip.length - 22;
	expect(view.getUint32(eocd, true)).toBe(0x06054b50);
	const count = view.getUint16(eocd + 10, true);
	let at = view.getUint32(eocd + 16, true);
	const out = new Map<string, Uint8Array>();
	for (let i = 0; i < count; i++) {
		expect(view.getUint32(at, true)).toBe(0x02014b50);
		expect(view.getUint16(at + 10, true)).toBe(0); // stored
		const crc = view.getUint32(at + 16, true);
		const size = view.getUint32(at + 24, true);
		const nameLen = view.getUint16(at + 28, true);
		const local = view.getUint32(at + 42, true);
		const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
		expect(view.getUint32(local, true)).toBe(0x04034b50);
		const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const data = zip.subarray(dataAt, dataAt + size);
		expect(crc32(data)).toBe(crc);
		// The data descriptor right after the data repeats CRC and sizes.
		expect(view.getUint32(dataAt + size, true)).toBe(0x08074b50);
		expect(view.getUint32(dataAt + size + 4, true)).toBe(crc);
		expect(view.getUint32(dataAt + size + 12, true)).toBe(size);
		out.set(name, data);
		at += 46 + nameLen;
	}
	return out;
}

/** UTF-8 text with a leading BOM kept (the default decoder drops it). */
export const textOf = (bytes: Uint8Array | undefined) =>
	new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
