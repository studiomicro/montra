import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Just enough PNG for the FN-13b image scripts and their tests: read the size, decode an 8-bit RGB/RGBA
 * non-interlaced file (what Chromium's screenshots are), and write a small opaque indexed file. Splash screens are
 * flat colour, so a palette and a good deflate give a few KB each where a screenshot is hundreds. No dependency
 * (`sharp` and friends are not devDependencies), and the same pixels always give the same bytes.
 */

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface Rgba {
	width: number;
	height: number;
	/** 4 bytes per pixel. */
	data: Uint8Array;
}

/** The pixel size from the IHDR chunk; throws when `buf` is not a PNG. */
export function pngSize(buf: Uint8Array): { width: number; height: number } {
	const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	if (
		b.length < 33 ||
		!b.subarray(0, 8).equals(SIGNATURE) ||
		b.toString('latin1', 12, 16) !== 'IHDR'
	)
		throw new Error('not a PNG file');
	return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export function decodePng(buf: Uint8Array): Rgba {
	const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	const { width, height } = pngSize(b);
	const depth = b[24]!;
	const colorType = b[25]!;
	const interlace = b[28]!;
	if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6))
		throw new Error(
			`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`
		);
	const idat: Buffer[] = [];
	for (let offset = 8; offset < b.length;) {
		const length = b.readUInt32BE(offset);
		if (b.toString('latin1', offset + 4, offset + 8) === 'IDAT')
			idat.push(b.subarray(offset + 8, offset + 8 + length));
		offset += 12 + length;
	}
	const bpp = colorType === 6 ? 4 : 3;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * bpp;
	const out = new Uint8Array(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? out[y * stride + i - bpp]! : 0;
			const up = y > 0 ? out[(y - 1) * stride + i]! : 0;
			const c = y > 0 && i >= bpp ? out[(y - 1) * stride + i - bpp]! : 0;
			const p = a + up - c;
			const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - up), Math.abs(p - c)];
			const predictor = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][
				filter
			]!;
			out[y * stride + i] = (line[i]! + predictor) & 0xff;
		}
	}
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data.set(out.subarray(i * bpp, i * bpp + 3), i * 4);
		data[i * 4 + 3] = bpp === 4 ? out[i * bpp + 3]! : 255;
	}
	return { width, height, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), body.length + 4);
	return out;
}

/**
 * An opaque image as an indexed PNG: the palette in order of first appearance (at most 256 colours), the
 * smallest bit depth that fits, and whichever of "no filter" and "up filter" deflates smaller. No metadata chunk.
 */
export function encodeIndexedPng({ width, height, data }: Rgba): Buffer {
	const palette: number[] = [];
	const index = new Map<number, number>();
	const pixels = new Uint8Array(width * height);
	for (let i = 0; i < pixels.length; i++) {
		if (data[i * 4 + 3] !== 255) throw new Error('encodeIndexedPng: only opaque pixels');
		const key = (data[i * 4]! << 16) | (data[i * 4 + 1]! << 8) | data[i * 4 + 2]!;
		let at = index.get(key);
		if (at === undefined) {
			at = palette.length;
			if (at > 255) throw new Error('encodeIndexedPng: more than 256 colours');
			index.set(key, at);
			palette.push(key);
		}
		pixels[i] = at;
	}
	const depth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
	const stride = Math.ceil((width * depth) / 8);
	const packed = new Uint8Array(height * stride);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const shift = 8 - depth - ((x * depth) % 8);
			packed[y * stride + ((x * depth) >> 3)]! |= pixels[y * width + x]! << shift;
		}
	const unfiltered = Buffer.alloc(height * (stride + 1));
	const up = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		up[y * (stride + 1)] = 2;
		for (let i = 0; i < stride; i++) {
			const cur = packed[y * stride + i]!;
			unfiltered[y * (stride + 1) + 1 + i] = cur;
			up[y * (stride + 1) + 1 + i] = (cur - (y > 0 ? packed[(y - 1) * stride + i]! : 0)) & 0xff;
		}
	}
	const compress = (raw: Buffer) => deflateSync(raw, { level: 9, memLevel: 9 });
	const [a, b] = [compress(unfiltered), compress(up)];
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = depth;
	ihdr[9] = 3;
	return Buffer.concat([
		SIGNATURE,
		chunk('IHDR', ihdr),
		chunk('PLTE', Buffer.from(palette.flatMap((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]))),
		chunk('IDAT', a.length <= b.length ? a : b),
		chunk('IEND', Buffer.alloc(0))
	]);
}
