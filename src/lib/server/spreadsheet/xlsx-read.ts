import { Inflate } from 'fflate/browser';
import { CSV_MAX_BYTES, CSV_MAX_COLUMNS } from '#lib/shared/csv';
import {
	SHEET_MAX_ROW,
	type SheetCell,
	type SheetGrid,
	type SheetRow,
	type Workbook
} from '#lib/shared/spreadsheet/types';
import {
	decodeXmlText,
	scanXml,
	UnsafeXmlError,
	XmlBudgetError,
	XmlSyntaxError,
	type XmlBudget
} from './xml';

/**
 * The XLSX reader of the spreadsheet import (FN-17): our own minimal reader over fflate's inflate (MIT,
 * pinned 0.8.3; the `fflate/browser` build: no Node API, no eval). The file stays in memory and is never
 * stored or logged. Only the parts a workbook's cached values need are inflated (`[Content_Types].xml`,
 * `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`, `xl/styles.xml` and the visible
 * worksheets); macros, external links, drawings and everything else are never read. A formula is never
 * evaluated: its cached `<v>` is the value, and without one the cell is empty.
 *
 * Limits (owner decisions 1–3; each boundary is tested):
 * - the file: XLSX_MAX_BYTES (5 MB, as CSV);
 * - the archive: at most XLSX_MAX_ENTRIES entries, no ZIP64, no encrypted entry;
 * - inflation: XLSX_MAX_ENTRY_INFLATED per part, XLSX_MAX_TOTAL_INFLATED in all, and at most XLSX_MAX_RATIO
 *   times a part's compressed size once it passes RATIO_FLOOR (a small part cannot be a bomb). Declared sizes
 *   are checked first; a part inflates, in INFLATE_CHUNK input steps, into one buffer of its declared size, and
 *   output past that size refuses the file before it is written, so memory stays bounded whatever the archive
 *   claims;
 * - XML: no DTD or entity declaration (refused), XML_TAG_BUDGET tags in all parts (the CPU bound), no open tag
 *   longer than XML_TAG_MAX_LENGTH (except a worksheet's SHEET_LONG_TAGS, whose attributes are never read), no
 *   number format code longer than FORMAT_CODE_MAX (each custom format is classified once, in linear time);
 * - the grid: SHEET_MAX_TABS visible sheets, SHEET_MAX_COLUMNS columns (a value further right refuses the
 *   file), READ_MAX_ROWS non-empty rows kept in all (the rest counted as not processed), cells only as they
 *   occur (a huge `<dimension>` or row number allocates nothing).
 */

export const XLSX_MAX_BYTES = CSV_MAX_BYTES;
export const XLSX_MAX_ENTRIES = 1000;
export const XLSX_MAX_ENTRY_INFLATED = 16 * 1024 * 1024;
export const XLSX_MAX_TOTAL_INFLATED = 50 * 1024 * 1024;
export const XLSX_MAX_RATIO = 100;
export const RATIO_FLOOR = 1024 * 1024;
export const INFLATE_CHUNK = 4096;
export const XML_TAG_BUDGET = 4_000_000;
export const SHEET_MAX_TABS = 40;
export const SHEET_MAX_COLUMNS = CSV_MAX_COLUMNS;
export const READ_MAX_ROWS = 6000;
/** Most shared strings kept; longest text kept per cell. */
export const SHARED_STRINGS_MAX = 200_000;
export const CELL_TEXT_MAX = 256;
/** Longest number format code (Excel's own limit is 255) and most custom formats kept; more refuses the file. */
export const FORMAT_CODE_MAX = 512;
export const FORMATS_MAX = 2000;
/** Worksheet tags whose `sqref` can run past XML_TAG_MAX_LENGTH in real files; the reader never uses their attributes. */
const SHEET_LONG_TAGS: ReadonlySet<string> = new Set([
	'dataValidation',
	'conditionalFormatting',
	'ignoredError',
	'selection'
]);

export type XlsxRefusal =
	| 'not_xlsx'
	| 'legacy_xls'
	| 'encrypted'
	| 'macro'
	| 'too_large'
	| 'unsafe_xml'
	| 'corrupt'
	| 'too_many_columns'
	| 'too_complex'
	| 'no_sheets';

export type ReadXlsxResult = { ok: true; workbook: Workbook } | { ok: false; error: XlsxRefusal };

class Refused extends Error {
	constructor(readonly reason: XlsxRefusal) {
		super(reason);
	}
}

export interface Entry {
	name: string;
	method: number;
	flags: number;
	compressed: number;
	size: number;
	offset: number;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (bytes: Uint8Array, magic: readonly number[]) =>
	magic.every((b, i) => bytes[i] === b);

/** "EncryptedPackage" in UTF-16LE: the stream an encrypted OOXML file keeps inside its OLE container. */
const ENCRYPTED_PACKAGE = Array.from('EncryptedPackage').flatMap((c) => [c.charCodeAt(0), 0]);

function containsSequence(bytes: Uint8Array, seq: readonly number[]): boolean {
	const first = seq[0] as number;
	outer: for (
		let i = bytes.indexOf(first);
		i >= 0 && i <= bytes.length - seq.length;
		i = bytes.indexOf(first, i + 1)
	) {
		for (let j = 1; j < seq.length; j++) if (bytes[i + j] !== seq[j]) continue outer;
		return true;
	}
	return false;
}

/** The central directory, every offset and size bounds-checked. Exported for tests. */
export function centralDirectory(bytes: Uint8Array): Map<string, Entry> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const min = Math.max(0, bytes.length - 22 - 0xffff);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= min; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Refused('corrupt');
	const count = view.getUint16(eocd + 10, true);
	const offset = view.getUint32(eocd + 16, true);
	if (count === 0xffff || offset === 0xffffffff) throw new Refused('corrupt'); // ZIP64: never needed here
	if (count > XLSX_MAX_ENTRIES) throw new Refused('too_large');
	const entries = new Map<string, Entry>();
	let at = offset;
	const decoder = new TextDecoder();
	for (let i = 0; i < count; i++) {
		if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
			throw new Refused('corrupt');
		const nameLength = view.getUint16(at + 28, true);
		const extra = view.getUint16(at + 30, true);
		const comment = view.getUint16(at + 32, true);
		if (at + 46 + nameLength > bytes.length) throw new Refused('corrupt');
		const entry: Entry = {
			name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
			flags: view.getUint16(at + 8, true),
			method: view.getUint16(at + 10, true),
			compressed: view.getUint32(at + 20, true),
			size: view.getUint32(at + 24, true),
			offset: view.getUint32(at + 42, true)
		};
		if (entry.flags & 1) throw new Refused('encrypted');
		entries.set(entry.name, entry);
		at += 46 + nameLength + extra + comment;
	}
	return entries;
}

export interface Inflation {
	total: number;
}

class LimitHit extends Error {}

/**
 * One entry's bytes, inflated within the per-entry, total and ratio caps (refused `too_large` past them) into
 * a single buffer of the declared size: no chunk list and no joined copy. Exported for tests.
 */
export function inflateEntry(bytes: Uint8Array, entry: Entry, state: Inflation): Uint8Array {
	if (
		entry.size > XLSX_MAX_ENTRY_INFLATED ||
		state.total + entry.size > XLSX_MAX_TOTAL_INFLATED ||
		(entry.size > RATIO_FLOOR && entry.size > entry.compressed * XLSX_MAX_RATIO)
	)
		throw new Refused('too_large');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const local = entry.offset;
	if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50)
		throw new Refused('corrupt');
	const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
	const end = start + entry.compressed;
	if (end > bytes.length) throw new Refused('corrupt');
	const data = bytes.subarray(start, end);
	if (entry.method === 0) {
		if (entry.compressed !== entry.size) throw new Refused('corrupt');
		state.total += entry.size;
		return data;
	}
	if (entry.method !== 8) throw new Refused('corrupt');
	const out = new Uint8Array(entry.size);
	let produced = 0;
	const inflater = new Inflate((chunk) => {
		const next = produced + chunk.length;
		if (
			next > XLSX_MAX_ENTRY_INFLATED ||
			state.total + next > XLSX_MAX_TOTAL_INFLATED ||
			(next > RATIO_FLOOR && next > entry.compressed * XLSX_MAX_RATIO)
		)
			throw new LimitHit();
		// More output than declared: a lying header (refused `corrupt` below), caught before the write.
		if (next > entry.size) throw new Refused('corrupt');
		out.set(chunk, produced);
		produced = next;
	});
	try {
		if (data.length === 0) inflater.push(new Uint8Array(0), true);
		for (let i = 0; i < data.length; i += INFLATE_CHUNK)
			inflater.push(data.subarray(i, i + INFLATE_CHUNK), i + INFLATE_CHUNK >= data.length);
	} catch (e) {
		if (e instanceof LimitHit) throw new Refused('too_large');
		throw new Refused('corrupt');
	}
	// The real size must be the declared one (a lying header is a broken or crafted archive).
	if (produced !== entry.size) throw new Refused('corrupt');
	state.total += produced;
	return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** OOXML's `_xHHHH_` escapes (control characters in strings); the cleaner drops them later. */
const unescapeOoxml = (text: string) =>
	text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** Built-in number formats that show a date (time-only formats 18–21 and 45–47 are not dates). */
const BUILTIN_DATE_FORMATS = new Set([
	14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58
]);

/**
 * Splits a format code in one linear pass: the text outside `[...]` sections (and, when `quoted`, outside
 * `"..."` text and backslash escapes), plus the content of each `[...]` section. An unclosed `[` or `"` stays
 * literal and is looked for once only, so a run of them cannot cost more than the code's length.
 */
function splitFormat(code: string, quoted: boolean): { bare: string; sections: string[] } {
	const sections: string[] = [];
	const bare: string[] = [];
	let noBracket = false;
	let noQuote = false;
	let at = 0;
	while (at < code.length) {
		const c = code[at] as string;
		if (c === '[' && !noBracket) {
			const close = code.indexOf(']', at + 1);
			if (close < 0) noBracket = true;
			else {
				sections.push(code.slice(at + 1, close));
				at = close + 1;
				continue;
			}
		} else if (quoted && c === '"' && !noQuote) {
			const close = code.indexOf('"', at + 1);
			if (close < 0) noQuote = true;
			else {
				at = close + 1;
				continue;
			}
		} else if (quoted && c === '\\' && at + 1 < code.length) {
			at += 2;
			continue;
		}
		bare.push(c);
		at++;
	}
	return { bare: bare.join(''), sections };
}

/** Whether a custom format code shows a date: a d or y outside quoted text, escapes and `[...]` sections. */
export function isDateFormat(code: string): boolean {
	return /[dy]/i.test(splitFormat(code, true).bare);
}

/** Whether a format code shows a currency other than rupiah (`[$$-409]`, `"$"#,##0`, `€`). */
export function isForeignFormat(code: string): boolean {
	const { bare, sections } = splitFormat(code, false);
	for (const section of sections) {
		if (!section.startsWith('$')) continue;
		const dash = section.indexOf('-');
		const symbol = (dash < 0 ? section.slice(1) : section.slice(1, dash)).trim();
		if (symbol !== '' && !/^(?:rp|idr)/i.test(symbol)) return true;
	}
	return /[$€£¥]|"(?:usd|sgd|eur|myr)/i.test(bare);
}

interface Styles {
	date: boolean[];
	foreign: boolean[];
}

function readStyles(xml: string | null, budget: XmlBudget): Styles {
	const styles: Styles = { date: [], foreign: [] };
	if (xml === null) return styles;
	// Each custom format is classified once, when declared: a `<xf>` only looks the result up.
	const formats = new Map<number, { date: boolean; foreign: boolean }>();
	let inCellXfs = false;
	scanXml(
		xml,
		{
			open(name, attrs) {
				if (name === 'numFmt') {
					const code = attrs.formatCode ?? '';
					if (code.length > FORMAT_CODE_MAX || formats.size >= FORMATS_MAX)
						throw new Refused('too_complex');
					formats.set(Number(attrs.numFmtId), {
						date: isDateFormat(code),
						foreign: isForeignFormat(code)
					});
				} else if (name === 'cellXfs') inCellXfs = true;
				else if (name === 'xf' && inCellXfs) {
					const id = Number(attrs.numFmtId ?? 0);
					const format = formats.get(id);
					styles.date.push(format ? format.date : BUILTIN_DATE_FORMATS.has(id));
					styles.foreign.push(format?.foreign === true);
				}
			},
			close(name) {
				if (name === 'cellXfs') inCellXfs = false;
			}
		},
		budget
	);
	return styles;
}

function readSharedStrings(xml: string | null, budget: XmlBudget): string[] {
	const strings: string[] = [];
	if (xml === null) return strings;
	let current: string | null = null;
	let inText = false;
	let phonetic = 0;
	scanXml(
		xml,
		{
			open(name) {
				if (name === 'si') current = '';
				else if (name === 'rPh') phonetic++;
				else if (name === 't' && current !== null && phonetic === 0) inText = true;
			},
			close(name) {
				if (name === 't') inText = false;
				else if (name === 'rPh') phonetic--;
				else if (name === 'si' && current !== null) {
					if (strings.length >= SHARED_STRINGS_MAX) throw new Refused('too_complex');
					strings.push(unescapeOoxml(decodeXmlText(current)).slice(0, CELL_TEXT_MAX));
					current = null;
				}
			},
			text(text) {
				if (inText && current !== null && current.length < CELL_TEXT_MAX * 8) current += text;
			}
		},
		budget
	);
	return strings;
}

/** `B12` → column 1; null for anything else. */
function columnOf(ref: string): number | null {
	const m = /^([A-Z]{1,3})\d*$/.exec(ref);
	if (!m) return null;
	let n = 0;
	for (const ch of m[1] as string) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

interface SheetReadState {
	rowsLeft: number;
}

function readSheet(
	xml: string,
	meta: { index: number; name: string },
	strings: readonly string[],
	styles: Styles,
	budget: XmlBudget,
	state: SheetReadState
): SheetGrid {
	const grid: SheetGrid = {
		index: meta.index,
		name: meta.name,
		rows: [],
		columns: 0,
		droppedRows: 0
	};
	let rowNumber = 0;
	let row: (SheetCell | null)[] | null = null;
	let col = -1;
	let cellType = '';
	let cellStyle = 0;
	let value: string | null = null;
	let inline: string | null = null;
	let capture: 'v' | 't' | null = null;
	let inInline = false;
	let phonetic = 0;

	const finishCell = () => {
		let cell: SheetCell | null;
		const v = value === null ? null : decodeXmlText(value);
		switch (cellType) {
			case 's': {
				const i = v === null ? -1 : Number(v);
				const text = Number.isInteger(i) && i >= 0 ? (strings[i] ?? '') : '';
				cell = text.trim() === '' ? null : { kind: 'text', text };
				break;
			}
			case 'inlineStr': {
				const text = unescapeOoxml(decodeXmlText(inline ?? '')).slice(0, CELL_TEXT_MAX);
				cell = text.trim() === '' ? null : { kind: 'text', text };
				break;
			}
			case 'str':
			case 'd': {
				const text = unescapeOoxml(v ?? '').slice(0, CELL_TEXT_MAX);
				cell = text.trim() === '' ? null : { kind: 'text', text };
				break;
			}
			case 'b':
				cell = v === null ? null : { kind: 'bool', value: v.trim() === '1' };
				break;
			case 'e':
				cell = v === null ? null : { kind: 'error' };
				break;
			default: {
				const text = (v ?? '').trim();
				cell =
					text === ''
						? null
						: {
								kind: 'number',
								text: text.slice(0, 64),
								date: styles.date[cellStyle] === true,
								foreign: styles.foreign[cellStyle] === true
							};
			}
		}
		if (!cell || !row) return;
		if (col >= SHEET_MAX_COLUMNS) throw new Refused('too_many_columns');
		row[col] = cell;
	};

	scanXml(
		xml,
		{
			open(name, attrs) {
				if (name === 'row') {
					const r = Number(attrs.r);
					rowNumber = Number.isInteger(r) && r > rowNumber ? r : rowNumber + 1;
					// Past Excel's last row the dedupe key (tab * TAB_KEY_STRIDE + row) could name another tab's row.
					if (rowNumber > SHEET_MAX_ROW) throw new Refused('corrupt');
					row = [];
					col = -1;
				} else if (name === 'c' && row) {
					const ref = attrs.r ? columnOf(attrs.r) : null;
					col = ref ?? col + 1;
					cellType = attrs.t ?? 'n';
					cellStyle = Number(attrs.s ?? 0) || 0;
					value = null;
					inline = null;
				} else if (name === 'v') {
					capture = 'v';
					value = '';
				} else if (name === 'is') {
					inInline = true;
					inline = '';
				} else if (name === 'rPh') phonetic++;
				else if (name === 't' && inInline && phonetic === 0) capture = 't';
			},
			close(name) {
				if (name === 'v' || name === 't') capture = null;
				else if (name === 'rPh') phonetic--;
				else if (name === 'is') inInline = false;
				else if (name === 'c' && row) finishCell();
				else if (name === 'row' && row) {
					const cells: (SheetCell | null)[] = row;
					row = null;
					if (!cells.some((c) => c)) return;
					if (state.rowsLeft <= 0) {
						grid.droppedRows++;
						return;
					}
					state.rowsLeft--;
					const kept: SheetRow = { r: rowNumber, cells: Array.from(cells, (c) => c ?? null) };
					grid.columns = Math.max(grid.columns, kept.cells.length);
					grid.rows.push(kept);
				}
			},
			text(text) {
				if (capture === 'v' && value !== null && value.length < 1024) value += text;
				else if (capture === 't' && inline !== null && inline.length < CELL_TEXT_MAX * 8)
					inline += text;
			}
		},
		budget,
		SHEET_LONG_TAGS
	);
	return grid;
}

/** A relationship target relative to `xl/` → the part name, or null when it leaves the worksheets folder. */
function worksheetPart(target: string): string | null {
	const name = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
	return /^xl\/worksheets\/[A-Za-z0-9_.-]+\.xml$/.test(name) && !name.includes('..') ? name : null;
}

/**
 * Reads an uploaded `.xlsx` in memory: refusals for a legacy `.xls`, an encrypted workbook, macros, a non-
 * workbook archive, unsafe XML and every limit above; else the visible sheets' cached cells.
 */
export function readXlsx(bytes: Uint8Array): ReadXlsxResult {
	try {
		return { ok: true, workbook: readWorkbook(bytes) };
	} catch (e) {
		if (e instanceof Refused) return { ok: false, error: e.reason };
		if (e instanceof UnsafeXmlError) return { ok: false, error: 'unsafe_xml' };
		if (e instanceof XmlBudgetError) return { ok: false, error: 'too_complex' };
		if (e instanceof XmlSyntaxError) return { ok: false, error: 'corrupt' };
		if (e instanceof RangeError || e instanceof TypeError) return { ok: false, error: 'corrupt' };
		throw e;
	}
}

function readWorkbook(bytes: Uint8Array): Workbook {
	if (bytes.length > XLSX_MAX_BYTES) throw new Refused('too_large');
	if (startsWith(bytes, OLE_MAGIC))
		throw new Refused(containsSequence(bytes, ENCRYPTED_PACKAGE) ? 'encrypted' : 'legacy_xls');
	if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) throw new Refused('not_xlsx');
	const entries = centralDirectory(bytes);
	const lowerNames = [...entries.keys()].map((n) => n.toLowerCase());
	if (lowerNames.some((n) => n.endsWith('vbaproject.bin'))) throw new Refused('macro');
	const state: Inflation = { total: 0 };
	const budget: XmlBudget = { tags: XML_TAG_BUDGET };
	const part = (name: string): string | null => {
		const entry = entries.get(name);
		if (!entry) return null;
		try {
			return utf8.decode(inflateEntry(bytes, entry, state));
		} catch (e) {
			if (e instanceof Refused) throw e;
			throw new Refused('corrupt');
		}
	};

	const types = part('[Content_Types].xml');
	if (types === null || !entries.has('xl/workbook.xml')) throw new Refused('not_xlsx');
	if (/macroEnabled/i.test(types)) throw new Refused('macro');
	scanXml(types, {}, budget);

	const sheets: { name: string; state: string; rid: string }[] = [];
	let date1904 = false;
	scanXml(
		part('xl/workbook.xml') as string,
		{
			open(name, attrs) {
				if (name === 'workbookPr') date1904 = attrs.date1904 === '1' || attrs.date1904 === 'true';
				else if (name === 'sheet' && sheets.length < XLSX_MAX_ENTRIES)
					sheets.push({
						name: attrs.name ?? '',
						state: attrs.state ?? 'visible',
						rid: attrs.id ?? ''
					});
			}
		},
		budget
	);
	const targets = new Map<string, string | null>();
	const rels = part('xl/_rels/workbook.xml.rels');
	if (rels === null) throw new Refused('not_xlsx');
	scanXml(
		rels,
		{
			open(name, attrs) {
				if (name !== 'Relationship' || !attrs.Id) return;
				const isSheet =
					(attrs.Type ?? '').endsWith('/worksheet') && attrs.TargetMode !== 'External';
				targets.set(attrs.Id, isSheet ? worksheetPart(attrs.Target ?? '') : null);
			}
		},
		budget
	);

	const strings = readSharedStrings(part('xl/sharedStrings.xml'), budget);
	const styles = readStyles(part('xl/styles.xml'), budget);
	const workbook: Workbook = { date1904, sheets: [], skipped: [] };
	const readState: SheetReadState = { rowsLeft: READ_MAX_ROWS };
	let visible = 0;
	sheets.forEach((s, index) => {
		const name = s.name.slice(0, 100);
		if (s.state === 'hidden' || s.state === 'veryHidden') {
			workbook.skipped.push({ index, name, reason: 'hidden' });
			return;
		}
		const target = targets.get(s.rid);
		if (!target || !entries.has(target)) {
			workbook.skipped.push({ index, name, reason: 'not_worksheet' });
			return;
		}
		// Past the tab cap a sheet is never inflated.
		if (++visible > SHEET_MAX_TABS) {
			workbook.skipped.push({ index, name, reason: 'tab_cap' });
			return;
		}
		const xml = part(target) as string;
		workbook.sheets.push(readSheet(xml, { index, name }, strings, styles, budget, readState));
	});
	if (workbook.sheets.length === 0) throw new Refused('no_sheets');
	return workbook;
}
