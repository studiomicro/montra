import { describe, expect, it } from 'vitest';
import { isHeifBytes } from './photos';

/** An ISO-BMFF `ftyp` box: size, "ftyp", major brand, minor version 0, then the compatible brands. */
function ftyp(major: string, compatible: string[] = []): Uint8Array {
	const size = 16 + 4 * compatible.length;
	const bytes = new Uint8Array(Math.max(size, 32));
	new DataView(bytes.buffer).setUint32(0, size);
	const put = (at: number, text: string) => {
		for (let i = 0; i < 4; i++) bytes[at + i] = text.charCodeAt(i);
	};
	put(4, 'ftyp');
	put(8, major);
	compatible.forEach((brand, i) => put(16 + 4 * i, brand));
	return bytes;
}

describe('isHeifBytes', () => {
	it('is true for the HEIF major brands', () => {
		for (const brand of ['heic', 'heix', 'mif1', 'msf1', 'hevc']) {
			expect(isHeifBytes(ftyp(brand)), brand).toBe(true);
		}
	});

	it('is true when only a compatible brand is in the HEIF family', () => {
		expect(isHeifBytes(ftyp('isom', ['mp41', 'heic']))).toBe(true);
		expect(isHeifBytes(ftyp('avif', ['mif1', 'miaf']))).toBe(true);
	});

	it('ignores brands past the end of the ftyp box', () => {
		const bytes = ftyp('isom', ['mp41']);
		bytes.set([0x68, 0x65, 0x69, 0x63], 20); // "heic" after the 20-byte box
		expect(isHeifBytes(bytes)).toBe(false);
	});

	it('is false for JPEG, PNG, WebP, MP4, AVIF alone and short input', () => {
		expect(isHeifBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]))).toBe(
			false
		);
		expect(isHeifBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]))).toBe(
			false
		);
		expect(isHeifBytes(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe(false);
		expect(isHeifBytes(ftyp('isom', ['isom', 'iso2', 'mp41']))).toBe(false);
		expect(isHeifBytes(ftyp('avif', ['avif']))).toBe(false);
		expect(isHeifBytes(ftyp('heic').subarray(0, 11))).toBe(false);
		expect(isHeifBytes(new Uint8Array())).toBe(false);
	});
});
