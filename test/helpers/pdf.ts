import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/**
 * Builds small, clearly fictional PDFs in test code (FN-16a): text pages, image-only pages, page-count and
 * decompression stress shapes, and RC4 password protection (PDF 1.4 standard security handler, revision 2).
 * Never a real statement: every caller passes invented text.
 */

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
	const s = Array.from({ length: 256 }, (_, i) => i);
	let j = 0;
	for (let i = 0; i < 256; i++) {
		j = (j + s[i]! + key[i % key.length]!) & 0xff;
		[s[i], s[j]] = [s[j]!, s[i]!];
	}
	const out = Buffer.alloc(data.length);
	let i = 0;
	j = 0;
	for (let k = 0; k < data.length; k++) {
		i = (i + 1) & 0xff;
		j = (j + s[i]!) & 0xff;
		[s[i], s[j]] = [s[j]!, s[i]!];
		out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 0xff]!;
	}
	return out;
}

const md5 = (...parts: Uint8Array[]) => {
	const h = createHash('md5');
	for (const p of parts) h.update(p);
	return h.digest();
};
const padded = (password: string) =>
	Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);

/** A literal PDF string: parentheses and backslashes escaped. */
const literal = (text: string) => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** One page's content stream: each line drawn 14 pt below the previous one in Helvetica 10 pt. */
export function textContent(lines: readonly string[]): string {
	return `BT /F1 10 Tf 40 800 Td 14 TL ${lines.map((l) => `${literal(l)} Tj T*`).join(' ')} ET`;
}

/** One page's content stream with each line placed at its own x (`Tm`), 14 pt below the previous one. */
export function positionedContent(lines: readonly { text: string; x: number }[]): string {
	return `BT /F1 10 Tf ${lines
		.map((l, i) => `1 0 0 1 ${l.x} ${800 - 14 * i} Tm ${literal(l.text)} Tj`)
		.join(' ')} ET`;
}

export interface PdfPage {
	/** The page's raw content stream (textContent() for text; '' or image drawing for no text). */
	content: string | Uint8Array;
	/** FlateDecode the content stream. */
	flate?: boolean;
	/** Draw a 1×1 grey image XObject (an image-only "scanned" page). */
	image?: boolean;
	/**
	 * The content stream exactly as written (adversarial shapes): its dictionary entries before `/Length`, the
	 * already-encoded data, and what stands between `>>` and `stream` (default a line break).
	 */
	raw?: { dict: string; data: Uint8Array; gap?: string };
	/** `/Contents` as an array referencing the same content stream this many times. */
	contentsRefs?: number;
}

export interface BuildPdfOptions {
	/** RC4-40 user password (owner password is fixed); the content streams are encrypted. */
	password?: string;
	/**
	 * Pages tree `/Count` override (a declared page count larger than the kids actually present), or
	 * `repeatPages`: the last page object is referenced this many times in total (many pages, one object).
	 */
	repeatPages?: number;
	/** Extra raw stream objects appended (zip-bomb shapes): dictionary entries plus data. */
	extraStreams?: { dict: string; data: Uint8Array }[];
	/** A Form XObject `/X1` (content stream text, Flate-compressed) every page may draw with `/X1 Do`. */
	form?: string;
	/** Make `/Im1` a JPEG (`/DCTDecode`) image, like a bank's logo; its data is never meant to be decoded. */
	jpegImage?: boolean;
}

const ID = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

/** A complete PDF file with a correct cross-reference table. */
export function buildPdf(pages: readonly PdfPage[], options: BuildPdfOptions = {}): Uint8Array {
	type StreamObj = { dict: string; data: Uint8Array; gap?: string };
	const objects: (string | StreamObj)[] = [];
	/** The new object's number (1-based). */
	const add = (obj: string | StreamObj) => objects.push(obj);
	const catalog = add('');
	const pagesObj = add('');
	const font = add(
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
	);
	const image = add(
		options.jpegImage
			? {
					// A huge declared JPEG: decoding it would allocate gigabytes.
					dict: '/Type /XObject /Subtype /Image /Width 60000 /Height 60000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
					data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
				}
			: {
					dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',
					data: new Uint8Array([0x80])
				}
	);
	const form =
		options.form === undefined
			? 0
			: add({
					dict: `/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Filter /FlateDecode`,
					data: deflateSync(Buffer.from(options.form, 'latin1'))
				});
	const xobjects = `/Im1 ${image} 0 R${form ? ` /X1 ${form} 0 R` : ''}`;
	const kids: number[] = [];
	for (const page of pages) {
		const raw =
			typeof page.content === 'string'
				? Buffer.from(
						page.image ? `q 100 0 0 100 40 600 cm /Im1 Do Q ${page.content}` : page.content,
						'latin1'
					)
				: page.content;
		const data = page.flate ? deflateSync(raw) : raw;
		const content = add(page.raw ?? { dict: page.flate ? '/Filter /FlateDecode' : '', data });
		kids.push(
			add(
				`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> /XObject << ${xobjects} >> >> /Contents ${page.contentsRefs ? `[${Array.from({ length: page.contentsRefs }, () => `${content} 0 R`).join(' ')}]` : `${content} 0 R`} >>`
			)
		);
	}
	for (const extra of options.extraStreams ?? []) add(extra);
	const repeat = options.repeatPages ?? kids.length;
	const allKids = Array.from({ length: repeat }, (_, i) => kids[Math.min(i, kids.length - 1)]!);
	objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
	objects[pagesObj - 1] =
		`<< /Type /Pages /Kids [${allKids.map((k) => `${k} 0 R`).join(' ')}] /Count ${repeat} >>`;

	let key: Buffer | null = null;
	let encrypt = 0;
	if (options.password !== undefined) {
		const P = -4;
		const o = rc4(md5(padded('pemilik-fiktif')).subarray(0, 5), padded(options.password));
		const p = Buffer.alloc(4);
		p.writeInt32LE(P);
		key = md5(padded(options.password), o, p, ID).subarray(0, 5);
		const u = rc4(key, PAD);
		encrypt = add(
			`<< /Filter /Standard /V 1 /R 2 /O <${o.toString('hex')}> /U <${u.toString('hex')}> /P ${P} >>`
		);
	}

	const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
	let offset = chunks[0]!.length;
	const offsets: number[] = [];
	objects.forEach((obj, i) => {
		const num = i + 1;
		offsets.push(offset);
		let body: Buffer;
		if (typeof obj === 'string') body = Buffer.from(`${num} 0 obj\n${obj}\nendobj\n`, 'latin1');
		else {
			let data: Buffer = Buffer.from(obj.data);
			if (key && num !== encrypt) {
				const objKey = md5(
					key,
					Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0])
				).subarray(0, 10);
				data = rc4(objKey, data);
			}
			body = Buffer.concat([
				Buffer.from(
					`${num} 0 obj\n<< ${obj.dict} /Length ${data.length} >>${obj.gap ?? '\n'}stream\n`,
					'latin1'
				),
				data,
				Buffer.from('\nendstream\nendobj\n', 'latin1')
			]);
		}
		chunks.push(body);
		offset += body.length;
	});
	const xref = [
		'xref',
		`0 ${objects.length + 1}`,
		'0000000000 65535 f ',
		...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
		'trailer',
		`<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encrypt ? ` /Encrypt ${encrypt} 0 R` : ''} /ID [<${ID.toString('hex')}> <${ID.toString('hex')}>] >>`,
		'startxref',
		String(offset),
		'%%EOF',
		''
	].join('\n');
	chunks.push(Buffer.from(xref, 'latin1'));
	return new Uint8Array(Buffer.concat(chunks));
}

/**
 * A zlib stream of `inflatedBytes` spaces after `prefix`, deflated in 1 MiB steps so building a 300 MB bomb
 * never holds 300 MB (keeps the test's own memory out of the peak measurements).
 */
export async function deflateStream(inflatedBytes: number, prefix = ''): Promise<Uint8Array> {
	const { createDeflate } = process.getBuiltinModule('node:zlib');
	const deflate = createDeflate({ level: 9 });
	const parts: Buffer[] = [];
	deflate.on('data', (b: Buffer) => parts.push(b));
	const ended = new Promise((resolve, reject) => deflate.on('end', resolve).on('error', reject));
	const write = (b: Buffer) =>
		new Promise<void>((resolve) => (deflate.write(b) ? resolve() : deflate.once('drain', resolve)));
	await write(Buffer.from(prefix, 'latin1'));
	const block = Buffer.alloc(1024 * 1024, 0x20);
	for (let left = inflatedBytes; left > 0; left -= block.length)
		await write(left >= block.length ? block : block.subarray(0, left));
	deflate.end();
	await ended;
	return new Uint8Array(Buffer.concat(parts));
}

/** A zlib stream that inflates to `inflatedBytes` spaces (spaces compress about 1000:1). */
export function deflateBomb(inflatedBytes: number): Uint8Array {
	return new Uint8Array(deflateSync(Buffer.alloc(inflatedBytes, 0x20), { level: 9 }));
}
