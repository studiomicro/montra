/**
 * A minimal streaming ZIP writer (FN-31 account export): "store" method only (no compression), so every
 * byte of every entry passes straight through. Pure: no D1, Workers or DOM dependency.
 *
 * Each entry is opened only when the writer reaches it and read chunk by chunk; the CRC-32 and size are
 * computed on the way and written in a data descriptor after the entry (general-purpose flag bit 3), so
 * nothing is buffered beyond one chunk plus the small central directory. Readers (Info-ZIP `unzip`, Python
 * `zipfile`, Windows, macOS) take sizes from the central directory. File times are fixed (1980-01-01), so the
 * same entries always give the same bytes.
 *
 * ZIP32 only: at most 65 535 entries and 4 GiB in total; past that the stream errors instead of writing an
 * archive no reader could open (the caller bounds the export long before).
 */

export interface ZipEntry {
	/** Path inside the archive: relative, `/`-separated, no `..` segment, at most 255 UTF-8 bytes. */
	name: string;
	/** Opened when the writer reaches this entry, never earlier. */
	open: () => ReadableStream<Uint8Array>;
}

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** Version 2.0: the lowest that knows data descriptors. */
const VERSION = 20;
/** Made by UNIX (3) so readers apply the file mode in the external attributes. */
const MADE_BY = (3 << 8) | VERSION;
/** Bit 3: sizes and CRC follow in a data descriptor. Bit 11: the name is UTF-8. */
const FLAGS = 0x0008 | 0x0800;
/** 1980-01-01 00:00:00 in MS-DOS date format (day 1, month 1, year 0); time 00:00:00. */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;
/** A regular file, rw-r--r--. */
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;

const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const NAME_MAX_BYTES = 255;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** CRC-32 (IEEE, as ZIP uses it) continued over `bytes`; start with 0. */
export function crc32(bytes: Uint8Array, previous = 0): number {
	let c = (previous ^ UINT32_MAX) >>> 0;
	for (let i = 0; i < bytes.length; i++)
		c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
	return (c ^ UINT32_MAX) >>> 0;
}

/** The UTF-8 bytes of a safe archive path; throws for an absolute, parent-escaping or over-long name. */
export function zipEntryName(name: string): Uint8Array {
	const bytes = new TextEncoder().encode(name);
	const segments = name.split('/');
	if (
		bytes.length === 0 ||
		bytes.length > NAME_MAX_BYTES ||
		name.includes('\\') ||
		name.includes('\0') ||
		segments.some((s) => s === '' || s === '.' || s === '..')
	)
		throw new RangeError('unsafe zip entry name');
	return bytes;
}

class Writer {
	readonly bytes: Uint8Array;
	private readonly view: DataView;
	private at = 0;
	constructor(size: number) {
		this.bytes = new Uint8Array(size);
		this.view = new DataView(this.bytes.buffer);
	}
	u16(v: number) {
		this.view.setUint16(this.at, v, true);
		this.at += 2;
		return this;
	}
	u32(v: number) {
		this.view.setUint32(this.at, v >>> 0, true);
		this.at += 4;
		return this;
	}
	raw(b: Uint8Array) {
		this.bytes.set(b, this.at);
		this.at += b.length;
		return this;
	}
}

function localHeader(name: Uint8Array): Uint8Array {
	return new Writer(30 + name.length)
		.u32(LOCAL_HEADER)
		.u16(VERSION)
		.u16(FLAGS)
		.u16(0) // stored
		.u16(DOS_TIME)
		.u16(DOS_DATE)
		.u32(0) // CRC, sizes: in the data descriptor
		.u32(0)
		.u32(0)
		.u16(name.length)
		.u16(0)
		.raw(name).bytes;
}

function dataDescriptor(crc: number, size: number): Uint8Array {
	return new Writer(16).u32(DATA_DESCRIPTOR).u32(crc).u32(size).u32(size).bytes;
}

interface Written {
	name: Uint8Array;
	crc: number;
	size: number;
	offset: number;
}

function centralHeader(e: Written): Uint8Array {
	return new Writer(46 + e.name.length)
		.u32(CENTRAL_HEADER)
		.u16(MADE_BY)
		.u16(VERSION)
		.u16(FLAGS)
		.u16(0)
		.u16(DOS_TIME)
		.u16(DOS_DATE)
		.u32(e.crc)
		.u32(e.size)
		.u32(e.size)
		.u16(e.name.length)
		.u16(0) // extra
		.u16(0) // comment
		.u16(0) // disk
		.u16(0) // internal attributes
		.u32(EXTERNAL_ATTRS)
		.u32(e.offset)
		.raw(e.name).bytes;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
	return new Writer(22)
		.u32(END_OF_CENTRAL_DIRECTORY)
		.u16(0)
		.u16(0)
		.u16(count)
		.u16(count)
		.u32(size)
		.u32(offset)
		.u16(0).bytes;
}

function checkZip32(total: number) {
	if (total > UINT32_MAX) throw new RangeError('zip too large');
}

async function* zipChunks(entries: readonly ZipEntry[]): AsyncGenerator<Uint8Array> {
	if (entries.length > UINT16_MAX) throw new RangeError('too many zip entries');
	const names = entries.map((e) => zipEntryName(e.name));
	if (new Set(entries.map((e) => e.name)).size !== entries.length)
		throw new RangeError('duplicate zip entry name');
	const written: Written[] = [];
	let offset = 0;
	for (const [i, entry] of entries.entries()) {
		const name = names[i] as Uint8Array;
		const header = localHeader(name);
		yield header;
		let crc = 0;
		let size = 0;
		const reader = entry.open().getReader();
		let finished = false;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value.byteLength === 0) continue;
				crc = crc32(value, crc);
				size += value.byteLength;
				checkZip32(offset + header.length + size);
				yield value;
			}
			finished = true;
		} finally {
			// Cancelled downstream or failed: the entry's own source stops too (its D1 paging ends).
			if (!finished) await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		yield dataDescriptor(crc, size);
		written.push({ name, crc, size, offset });
		offset += header.length + size + 16;
		checkZip32(offset);
	}
	const central = written.map(centralHeader);
	const centralSize = central.reduce((n, c) => n + c.length, 0);
	checkZip32(offset + centralSize);
	for (const c of central) yield c;
	yield endOfCentralDirectory(written.length, centralSize, offset);
}

/**
 * The entries as one store-only ZIP, produced as the reader pulls (`highWaterMark: 0`): a slow download
 * holds back the entry sources instead of filling memory.
 */
export function zipStore(entries: readonly ZipEntry[]): ReadableStream<Uint8Array> {
	const chunks = zipChunks(entries);
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const next = await chunks.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			async cancel() {
				await chunks.return(undefined);
			}
		},
		{ highWaterMark: 0 }
	);
}
