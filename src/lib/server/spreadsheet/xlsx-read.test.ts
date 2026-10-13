import { afterEach, describe, expect, it, vi } from 'vitest';
import { Inflate, strToU8, zipSync } from 'fflate/browser';
import { buildXlsx } from '../../../../test/helpers/xlsx';
import {
	centralDirectory,
	inflateEntry,
	isDateFormat,
	isForeignFormat,
	RATIO_FLOOR,
	READ_MAX_ROWS,
	readXlsx,
	SHEET_MAX_COLUMNS,
	SHEET_MAX_TABS,
	XLSX_MAX_BYTES,
	XLSX_MAX_ENTRIES,
	XLSX_MAX_ENTRY_INFLATED,
	XLSX_MAX_RATIO,
	XLSX_MAX_TOTAL_INFLATED
} from './xlsx-read';

/** `size` bytes of text: `head`, then 'a' with a pseudo-random letter every `every` bytes, then `tail`. */
function noisy(size: number, every: number, head: string, tail: string): Uint8Array {
	const out = new Uint8Array(size).fill(97);
	let seed = 11;
	for (let i = 0; i < size; i += every) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		out[i] = 97 + (seed % 26);
	}
	out.set(strToU8(head), 0);
	out.set(strToU8(tail), size - tail.length);
	return out;
}

const simple = () =>
	buildXlsx([
		{
			name: 'Transaksi',
			rows: [
				['Tanggal', 'Keterangan', 'Jumlah'],
				[{ serial: 46296 }, 'Kopi susu', 28000]
			]
		}
	]);

function ok(bytes: Uint8Array) {
	const r = readXlsx(bytes);
	if (!r.ok) throw new Error(`refused: ${r.error}`);
	return r.workbook;
}

describe('readXlsx: cells', () => {
	it('reads shared, inline, number, date-formatted, boolean and error cells', () => {
		const wb = ok(
			buildXlsx([
				{
					name: 'A',
					rows: [
						['Teks', { inline: 'Sebaris & <b>' }, { num: '28000.50' }, { serial: 46296 }],
						[{ serial: 46296, style: 'custom-date' }, { bool: true }, null, { num: '-1.5E+3' }]
					]
				}
			])
		);
		const [sheet] = wb.sheets;
		expect(sheet?.rows[0]?.cells).toEqual([
			{ kind: 'text', text: 'Teks' },
			{ kind: 'text', text: 'Sebaris & <b>' },
			{ kind: 'number', text: '28000.50', date: false, foreign: false },
			{ kind: 'number', text: '46296', date: true, foreign: false }
		]);
		expect(sheet?.rows[1]?.cells).toEqual([
			{ kind: 'number', text: '46296', date: true, foreign: false },
			{ kind: 'bool', value: true },
			null,
			{ kind: 'number', text: '-1.5E+3', date: false, foreign: false }
		]);
		expect(wb.date1904).toBe(false);
	});

	it('uses a formula cached value only; a formula without one is empty; the formula text never shows', () => {
		const wb = ok(
			buildXlsx([
				{
					name: 'A',
					rows: [
						[
							{ formula: 'SUM(B1:B9)', cached: 125000 },
							{ formula: 'HYPERLINK("http://x")' },
							{ formula: 'A1&"x"', cached: 'teks' }
						]
					]
				}
			])
		);
		expect(wb.sheets[0]?.rows[0]?.cells).toEqual([
			{ kind: 'number', text: '125000', date: false, foreign: false },
			null,
			{ kind: 'text', text: 'teks' }
		]);
		expect(JSON.stringify(wb)).not.toContain('SUM');
	});

	it('reads date1904 and a foreign currency number format', () => {
		const wb = ok(
			buildXlsx([{ name: 'A', rows: [[{ num: '10', style: 'foreign' }]] }], { date1904: true })
		);
		expect(wb.date1904).toBe(true);
		expect(wb.sheets[0]?.rows[0]?.cells[0]).toMatchObject({ foreign: true });
	});

	it('skips hidden and very hidden sheets without reading them', () => {
		const wb = ok(
			buildXlsx([
				{ name: 'Terlihat', rows: [['a']] },
				{ name: 'Rahasia', rows: [['b']], state: 'hidden' },
				{ name: 'Sangat', rows: [['c']], state: 'veryHidden' }
			])
		);
		expect(wb.sheets.map((s) => s.name)).toEqual(['Terlihat']);
		expect(wb.skipped).toEqual([
			{ index: 1, name: 'Rahasia', reason: 'hidden' },
			{ index: 2, name: 'Sangat', reason: 'hidden' }
		]);
	});

	it('ignores external links: the part is never read, the workbook still opens', () => {
		const wb = ok(
			buildXlsx([{ name: 'A', rows: [['a']] }], {
				extra: {
					'xl/externalLinks/externalLink1.xml':
						'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "http://example.invalid/">]><externalLink/>'
				}
			})
		);
		expect(wb.sheets).toHaveLength(1);
	});

	it('a sparse sheet (huge dimension, a row far down) allocates only its real rows', () => {
		const wb = ok(
			buildXlsx([
				{
					name: 'A',
					before: '<dimension ref="A1:XFD1048576"/>',
					rows: [['a'], ['b']],
					rowNumbers: [1, 1_048_576]
				}
			])
		);
		expect(wb.sheets[0]?.rows.map((r) => r.r)).toEqual([1, 1_048_576]);
		expect(wb.sheets[0]?.columns).toBe(1);
	});
});

describe('readXlsx: refusals', () => {
	it('refuses a legacy .xls (OLE) and an encrypted workbook (OLE with EncryptedPackage) distinctly', () => {
		const ole = new Uint8Array(1024);
		ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
		expect(readXlsx(ole)).toEqual({ ok: false, error: 'legacy_xls' });
		const enc = ole.slice();
		enc.set(
			Array.from('EncryptedPackage').flatMap((c) => [c.charCodeAt(0), 0]),
			600
		);
		expect(readXlsx(enc)).toEqual({ ok: false, error: 'encrypted' });
	});

	it('refuses non-zip bytes and a zip that is not a workbook', () => {
		expect(readXlsx(strToU8('tanggal,jumlah\n'))).toEqual({ ok: false, error: 'not_xlsx' });
		expect(readXlsx(zipSync({ 'a.txt': strToU8('halo') }))).toEqual({
			ok: false,
			error: 'not_xlsx'
		});
	});

	it('refuses macros: a vbaProject.bin part or a macro-enabled content type', () => {
		expect(
			readXlsx(
				buildXlsx([{ name: 'A', rows: [['a']] }], {
					extra: { 'xl/vbaProject.bin': new Uint8Array(8) }
				})
			)
		).toEqual({ ok: false, error: 'macro' });
		expect(
			readXlsx(
				buildXlsx([{ name: 'A', rows: [['a']] }], {
					contentTypes:
						'<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>'
				})
			)
		).toEqual({ ok: false, error: 'macro' });
	});

	it('refuses a DOCTYPE or ENTITY (billion laughs, XXE) without expanding anything', () => {
		const laughs =
			'<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>';
		expect(
			readXlsx(buildXlsx([{ name: 'A', rows: [['a']] }], { workbookPrologue: laughs }))
		).toEqual({
			ok: false,
			error: 'unsafe_xml'
		});
		const xxe = '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>';
		expect(readXlsx(buildXlsx([{ name: 'A', rows: [['a']] }], { workbookPrologue: xxe }))).toEqual({
			ok: false,
			error: 'unsafe_xml'
		});
	});

	it(`a value in column ${SHEET_MAX_COLUMNS} is read; one in column ${SHEET_MAX_COLUMNS + 1} refuses the file`, () => {
		const row = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
		expect(ok(buildXlsx([{ name: 'A', rows: [row(SHEET_MAX_COLUMNS)] }])).sheets[0]?.columns).toBe(
			SHEET_MAX_COLUMNS
		);
		expect(readXlsx(buildXlsx([{ name: 'A', rows: [row(SHEET_MAX_COLUMNS + 1)] }]))).toEqual({
			ok: false,
			error: 'too_many_columns'
		});
	});

	it(`reads ${SHEET_MAX_TABS} visible tabs; the ${SHEET_MAX_TABS + 1}st is skipped as past the cap`, () => {
		const tabs = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ name: `T${i}`, rows: [['a']] }));
		expect(ok(buildXlsx(tabs(SHEET_MAX_TABS))).sheets).toHaveLength(SHEET_MAX_TABS);
		const wb = ok(buildXlsx(tabs(SHEET_MAX_TABS + 1)));
		expect(wb.sheets).toHaveLength(SHEET_MAX_TABS);
		expect(wb.skipped).toEqual([
			{ index: SHEET_MAX_TABS, name: `T${SHEET_MAX_TABS}`, reason: 'tab_cap' }
		]);
	});

	it(`keeps ${READ_MAX_ROWS} rows in all and counts the rest as dropped`, () => {
		const rows = Array.from({ length: READ_MAX_ROWS + 3 }, (_, i) => [i]);
		const wb = ok(buildXlsx([{ name: 'A', rows }]));
		expect(wb.sheets[0]?.rows).toHaveLength(READ_MAX_ROWS);
		expect(wb.sheets[0]?.droppedRows).toBe(3);
	});

	it(`the file itself: ${XLSX_MAX_BYTES} bytes are read, one more is refused`, () => {
		const base = simple();
		const padded = new Uint8Array(XLSX_MAX_BYTES);
		padded.set(base);
		// Trailing bytes after the archive: the end record is no longer found within reach, but the size check comes first.
		const over = new Uint8Array(XLSX_MAX_BYTES + 1);
		over.set(base);
		expect(readXlsx(over)).toEqual({ ok: false, error: 'too_large' });
		expect(readXlsx(padded)).not.toEqual({ ok: false, error: 'too_large' });
	});

	it(`entry count: ${XLSX_MAX_ENTRIES} entries open, one more is refused`, () => {
		const extra = (n: number) =>
			Object.fromEntries(Array.from({ length: n }, (_, i) => [`docProps/x${i}.txt`, 'x']));
		// buildXlsx writes 5 parts plus one per sheet.
		expect(
			readXlsx(buildXlsx([{ name: 'A', rows: [['a']] }], { extra: extra(XLSX_MAX_ENTRIES - 6) })).ok
		).toBe(true);
		expect(
			readXlsx(buildXlsx([{ name: 'A', rows: [['a']] }], { extra: extra(XLSX_MAX_ENTRIES - 5) }))
		).toEqual({
			ok: false,
			error: 'too_large'
		});
	});

	it('a zip bomb (a small part inflating far past the ratio) is refused before full inflation', () => {
		// 8 MB of one repeated tag compresses ~1000:1; the declared size is honest, so the ratio cap stops it.
		const filler = '<c/>'.repeat(2 * 1024 * 1024);
		const bomb = zipSync(
			{
				'[Content_Types].xml': strToU8('<Types/>'),
				'xl/workbook.xml': strToU8(
					'<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>'
				),
				'xl/_rels/workbook.xml.rels': strToU8(
					'<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
				),
				'xl/worksheets/sheet1.xml': strToU8(
					`<worksheet><sheetData>${filler}</sheetData></worksheet>`
				)
			},
			{ level: 9 }
		);
		expect(bomb.length).toBeLessThan(64 * 1024);
		expect(readXlsx(bomb)).toEqual({ ok: false, error: 'too_large' });
	});

	it(`ratio: a part just under ${XLSX_MAX_RATIO}:1 opens, a highly compressible one past ${RATIO_FLOOR} bytes is refused`, () => {
		// Pseudo-random text compresses far less than 100:1: a 2 MB sheet of it opens.
		let seed = 7;
		const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
		const cells = Array.from({ length: 40_000 }, () => [rand(), rand()]);
		expect(readXlsx(buildXlsx([{ name: 'A', rows: cells }])).ok).toBe(true);
		// Under the floor a part may compress as well as it likes (a tiny part cannot be a bomb).
		const small = '<c/>'.repeat(Math.floor(RATIO_FLOOR / 8));
		expect(
			readXlsx(
				buildXlsx([{ name: 'A', rows: [['a']] }], {
					extra: { 'xl/styles.xml': `<styleSheet>${small}</styleSheet>` }
				})
			).ok
		).toBe(true);
	});

	it(`per part: ${XLSX_MAX_ENTRY_INFLATED} bytes inflate, one more is refused`, () => {
		const make = (size: number) =>
			buildXlsx([{ name: 'A', rows: [['a']] }], {
				extra: { 'xl/styles.xml': noisy(size, 2, '<styleSheet>', '</styleSheet>') },
				level: 1
			});
		const at = make(XLSX_MAX_ENTRY_INFLATED);
		expect(at.length).toBeLessThan(XLSX_MAX_BYTES);
		expect(readXlsx(at).ok).toBe(true);
		expect(readXlsx(make(XLSX_MAX_ENTRY_INFLATED + 1))).toEqual({ ok: false, error: 'too_large' });
	}, 60_000);

	it(`total: parts adding up past ${XLSX_MAX_TOTAL_INFLATED} bytes are refused`, () => {
		const part = (n: number) =>
			noisy(13 * 1024 * 1024, 200, '<worksheet><sheetData/><x>', `</x><!-- ${n} --></worksheet>`);
		const sheets = Array.from({ length: 4 }, (_, i) => ({ name: `S${i}`, rows: [['a']] }));
		const extra = Object.fromEntries(
			sheets.map((_, i) => [`xl/worksheets/sheet${i + 1}.xml`, part(i)])
		);
		const bytes = buildXlsx(sheets, { extra });
		expect(bytes.length).toBeLessThan(XLSX_MAX_BYTES);
		expect(readXlsx(bytes)).toEqual({ ok: false, error: 'too_large' });
		// Three of them stay under the total.
		const three = buildXlsx(sheets.slice(0, 3), {
			extra: Object.fromEntries(Object.entries(extra).slice(0, 3))
		});
		expect(readXlsx(three).ok).toBe(true);
	}, 60_000);

	it('a lying declared size is refused (the real output is counted)', () => {
		const bytes = simple();
		const view = new DataView(bytes.buffer);
		// Shrink the declared size of the first central-directory entry.
		let eocd = bytes.length - 22;
		while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
		const cd = view.getUint32(eocd + 16, true);
		view.setUint32(cd + 24, 3, true);
		expect(readXlsx(bytes)).toMatchObject({ ok: false });
	});
});

describe('inflateEntry: one preallocated buffer (FN-17 L1)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	/** A one-part deflated archive and its entry; the part is big enough to inflate in many chunks. */
	function deflated(size = 300_000) {
		const text = noisy(size, 3, '<a>', '</a>');
		const zip = zipSync({ 'p.xml': text }, { level: 6 });
		const entry = centralDirectory(zip).get('p.xml');
		if (!entry) throw new Error('no entry');
		return { text, zip, entry };
	}

	/** Records every `new Uint8Array(n)` with n >= `min` the reader makes, and every inflate push, in order. */
	function track(min: number) {
		const events: string[] = [];
		const made: Uint8Array[] = [];
		const Real = Uint8Array;
		vi.stubGlobal(
			'Uint8Array',
			new Proxy(Real, {
				construct(target, args: unknown[], newTarget) {
					const array = Reflect.construct(target, args, newTarget) as Uint8Array;
					if (typeof args[0] === 'number' && args[0] >= min) {
						events.push('alloc');
						made.push(array);
					}
					return array;
				}
			})
		);
		const push = Inflate.prototype.push;
		vi.spyOn(Inflate.prototype, 'push').mockImplementation(function (this: Inflate, ...a) {
			events.push('push');
			return push.apply(this, a);
		});
		return { events, made };
	}

	it('allocates exactly one buffer of entry.size, before inflating, and returns it', () => {
		const { text, zip, entry } = deflated();
		expect(entry.compressed).toBeGreaterThan(4 * 4096); // several input steps
		const { events, made } = track(entry.size);
		const out = inflateEntry(zip, entry, { total: 0 });
		expect(made).toHaveLength(1);
		expect(events[0]).toBe('alloc'); // preallocated: no chunk list joined after the last push
		expect(events.filter((e) => e === 'push').length).toBeGreaterThan(1);
		expect(out).toBe(made[0]);
		expect(out.byteLength).toBe(entry.size);
		expect(out.buffer.byteLength).toBe(entry.size);
		vi.unstubAllGlobals();
		expect(Buffer.from(out).equals(Buffer.from(text))).toBe(true);
	});

	it('counts the part against the running total', () => {
		const { zip, entry } = deflated(10_000);
		const state = { total: 5 };
		inflateEntry(zip, entry, state);
		expect(state.total).toBe(5 + entry.size);
	});

	it('real output larger than declared is refused corrupt before it is written past the buffer', () => {
		const { zip, entry } = deflated();
		const { made } = track(1);
		const set = vi.spyOn(Uint8Array.prototype, 'set');
		const declared = entry.size - 1000;
		expect(() => inflateEntry(zip, { ...entry, size: declared }, { total: 0 })).toThrow('corrupt');
		// Every write the reader made stayed inside the declared size.
		const out = made.find((m) => m.byteLength === declared);
		for (const call of set.mock.calls.filter((c) => c.length === 2)) {
			const [chunk, offset] = call as [ArrayLike<number>, number];
			expect(offset + chunk.length).toBeLessThanOrEqual(declared);
		}
		expect(out).toBeDefined();
	});

	it('real output smaller than declared is refused corrupt', () => {
		const { zip, entry } = deflated();
		expect(() => inflateEntry(zip, { ...entry, size: entry.size + 1 }, { total: 0 })).toThrow(
			'corrupt'
		);
	});

	it('the caps still refuse too_large: per entry, total (also when the header lies) and ratio', () => {
		const { zip, entry } = deflated();
		expect(() =>
			inflateEntry(zip, { ...entry, size: XLSX_MAX_ENTRY_INFLATED + 1 }, { total: 0 })
		).toThrow('too_large');
		expect(() =>
			inflateEntry(zip, entry, { total: XLSX_MAX_TOTAL_INFLATED - entry.size + 1 })
		).toThrow('too_large');
		// At the total exactly the part opens; a lying (smaller) header at the total hits the cap first.
		expect(
			inflateEntry(zip, entry, { total: XLSX_MAX_TOTAL_INFLATED - entry.size }).byteLength
		).toBe(entry.size);
		const lying = { ...entry, size: entry.size - 1000 };
		expect(() => inflateEntry(zip, lying, { total: XLSX_MAX_TOTAL_INFLATED - lying.size })).toThrow(
			'too_large'
		);
	});

	it('a declared size past the ratio is refused before its buffer is allocated', () => {
		const { zip, entry } = deflated();
		const size = Math.max(RATIO_FLOOR + 1, entry.compressed * XLSX_MAX_RATIO + 1);
		expect(size).toBeLessThanOrEqual(XLSX_MAX_ENTRY_INFLATED);
		const { made } = track(size);
		expect(() => inflateEntry(zip, { ...entry, size }, { total: 0 })).toThrow('too_large');
		expect(made).toHaveLength(0);
	});
});

describe('number formats', () => {
	it('date formats: d or y outside quotes and brackets', () => {
		expect(isDateFormat('dd/mm/yyyy')).toBe(true);
		expect(isDateFormat('[$-421]d mmmm yyyy')).toBe(true);
		expect(isDateFormat('#,##0')).toBe(false);
		expect(isDateFormat('"Rp" #,##0')).toBe(false);
		expect(isDateFormat('[h]:mm:ss')).toBe(false);
	});
	it('foreign currency formats; rupiah is not foreign', () => {
		expect(isForeignFormat('[$$-409]#,##0.00')).toBe(true);
		expect(isForeignFormat('[$€-2] #,##0')).toBe(true);
		expect(isForeignFormat('"$"#,##0')).toBe(true);
		expect(isForeignFormat('[$Rp-421]#,##0')).toBe(false);
		expect(isForeignFormat('"Rp"#,##0')).toBe(false);
		expect(isForeignFormat('[Red]#,##0')).toBe(false);
	});
});
