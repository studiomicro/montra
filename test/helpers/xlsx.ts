import { zipSync, strToU8, type Zippable } from 'fflate/browser';

/**
 * Builds small fictional `.xlsx` workbooks for the spreadsheet import tests (FN-17), with the same zip library
 * the reader uses: no binary fixture is committed. Only what the reader looks at is written.
 */

/** A cell: a number, shared text, or a styled / formula / inline / raw cell. */
export type FixtureCell =
	| string
	| number
	| null
	| { serial: number; style?: 'date' | 'custom-date' }
	| { num: string; style?: 'foreign' }
	| { formula: string; cached?: number | string }
	| { inline: string }
	| { bool: boolean }
	| { at: string; value: string | number };

export interface FixtureSheet {
	name: string;
	rows: FixtureCell[][];
	state?: 'hidden' | 'veryHidden';
	/** Row numbers to use instead of 1, 2, 3… (e.g. a row far down the sheet). */
	rowNumbers?: number[];
	/** Raw XML placed before `<sheetData>` (e.g. a huge `<dimension>`). */
	before?: string;
	/** Raw XML placed after `</sheetData>`, where Excel writes `<conditionalFormatting>`, `<dataValidations>`… */
	after?: string;
}

export interface FixtureOptions {
	date1904?: boolean;
	/** Extra archive entries (names → text or bytes). */
	extra?: Record<string, string | Uint8Array>;
	/** Replaces the [Content_Types].xml text. */
	contentTypes?: string;
	/** Compression level (0 = stored). */
	level?: 0 | 1 | 6 | 9;
	/** Text put right after the XML declaration of xl/workbook.xml (e.g. a DOCTYPE). */
	workbookPrologue?: string;
}

const STYLE_INDEX = { date: 1, 'custom-date': 2, foreign: 3 } as const;

const esc = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function columnName(i: number): string {
	let n = i + 1;
	let out = '';
	while (n > 0) {
		const rem = (n - 1) % 26;
		out = String.fromCharCode(65 + rem) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}

export function buildXlsx(sheets: FixtureSheet[], options: FixtureOptions = {}): Uint8Array {
	const strings: string[] = [];
	const stringIndex = new Map<string, number>();
	const shared = (s: string) => {
		let i = stringIndex.get(s);
		if (i === undefined) {
			i = strings.length;
			strings.push(s);
			stringIndex.set(s, i);
		}
		return i;
	};
	const cellXml = (cell: FixtureCell, ref: string): string => {
		if (cell === null) return '';
		if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
		if (typeof cell === 'string') return `<c r="${ref}" t="s"><v>${shared(cell)}</v></c>`;
		if ('serial' in cell)
			return `<c r="${ref}" s="${STYLE_INDEX[cell.style ?? 'date']}"><v>${cell.serial}</v></c>`;
		if ('num' in cell)
			return `<c r="${ref}"${cell.style ? ` s="${STYLE_INDEX[cell.style]}"` : ''}><v>${cell.num}</v></c>`;
		if ('formula' in cell) {
			const cached =
				cell.cached === undefined
					? ''
					: typeof cell.cached === 'number'
						? `<v>${cell.cached}</v>`
						: `<v>${esc(cell.cached)}</v>`;
			const t = typeof cell.cached === 'string' ? ' t="str"' : '';
			return `<c r="${ref}"${t}><f>${esc(cell.formula)}</f>${cached}</c>`;
		}
		if ('inline' in cell)
			return `<c r="${ref}" t="inlineStr"><is><t>${esc(cell.inline)}</t></is></c>`;
		if ('bool' in cell) return `<c r="${ref}" t="b"><v>${cell.bool ? 1 : 0}</v></c>`;
		const at = cell.at;
		return typeof cell.value === 'number'
			? `<c r="${at}"><v>${cell.value}</v></c>`
			: `<c r="${at}" t="s"><v>${shared(cell.value)}</v></c>`;
	};
	const sheetXml = (sheet: FixtureSheet) => {
		const rows = sheet.rows
			.map((cells, i) => {
				const r = sheet.rowNumbers?.[i] ?? i + 1;
				return `<row r="${r}">${cells.map((c, j) => cellXml(c, `${columnName(j)}${r}`)).join('')}</row>`;
			})
			.join('');
		return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${sheet.before ?? ''}<sheetData>${rows}</sheetData>${sheet.after ?? ''}</worksheet>`;
	};

	const files: Zippable = {};
	sheets.forEach((s, i) => {
		files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s));
	});
	const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${options.workbookPrologue ?? ''}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${options.date1904 ? ' date1904="1"' : ''}/><sheets>${sheets
		.map(
			(s, i) =>
				`<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`
		)
		.join('')}</sheets></workbook>`;
	const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
		.map(
			(_, i) =>
				`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
		)
		.join(
			''
		)}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
	const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="[$$-409]#,##0.00"/></numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`;
	const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
		.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
		.join('')}</sst>`;
	const contentTypes =
		options.contentTypes ??
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
	files['[Content_Types].xml'] = strToU8(contentTypes);
	files['xl/workbook.xml'] = strToU8(workbook);
	files['xl/_rels/workbook.xml.rels'] = strToU8(rels);
	files['xl/styles.xml'] = strToU8(styles);
	files['xl/sharedStrings.xml'] = strToU8(sharedXml);
	for (const [name, value] of Object.entries(options.extra ?? {}))
		files[name] = typeof value === 'string' ? strToU8(value) : value;
	return zipSync(files, { level: options.level ?? 6 });
}

/** Excel 1900-system serial of a `YYYY-MM-DD` date (from 1900-03-01 on). */
export function serialOf(date: string): number {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}
