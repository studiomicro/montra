/**
 * A minimal pull scanner for the OOXML parts the spreadsheet reader needs (FN-17). No DOM parser and no
 * entity expansion: any `<!DOCTYPE`, `<!ENTITY` or other `<!` declaration refuses the part (billion laughs,
 * XXE), only the five predefined entities and numeric character references are decoded, and nothing is ever
 * fetched. Tag names lose their namespace prefix (`x:c` → `c`). Every tag counts against the caller's budget.
 */

export class UnsafeXmlError extends Error {
	constructor() {
		super('unsafe xml');
	}
}

export class XmlBudgetError extends Error {
	constructor() {
		super('xml budget');
	}
}

export class XmlSyntaxError extends Error {
	constructor() {
		super('xml syntax');
	}
}

/**
 * Longest open tag accepted; a longer one refuses the file (a real tag is a few hundred characters), unless the
 * caller names the tag as one whose attributes it never reads (see `scanXml`'s `longTags`).
 */
export const XML_TAG_MAX_LENGTH = 32 * 1024;

/** Tags one workbook read may scan in all its parts: bounds CPU on a crafted file. */
export interface XmlBudget {
	tags: number;
}

export interface XmlHandler {
	open?: (name: string, attrs: Record<string, string>, selfClosing: boolean) => void;
	close?: (name: string) => void;
	text?: (text: string) => void;
}

const PREDEFINED: Readonly<Record<string, string>> = {
	lt: '<',
	gt: '>',
	amp: '&',
	quot: '"',
	apos: "'"
};

/** Entity and numeric references decoded; an unknown named entity is kept as written (never expanded). */
export function decodeXmlText(text: string): string {
	if (!text.includes('&')) return text;
	return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,4});/g, (whole, ref: string) => {
		if (ref.startsWith('#')) {
			const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
				? String.fromCodePoint(code)
				: '�';
		}
		return Object.hasOwn(PREDEFINED, ref) ? (PREDEFINED[ref] as string) : whole;
	});
}

const localName = (name: string) => {
	const colon = name.indexOf(':');
	return colon < 0 ? name : name.slice(colon + 1);
};

/** Linear attribute scan: `name = "value"` or `name = 'value'` pairs; anything else is skipped. */
function parseAttrs(source: string): Record<string, string> {
	const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
	const length = source.length;
	const blank = (c: number) => c === 32 || (c >= 9 && c <= 13);
	let at = 0;
	while (at < length) {
		while (at < length && blank(source.charCodeAt(at))) at++;
		const nameStart = at;
		while (at < length && !blank(source.charCodeAt(at)) && source.charCodeAt(at) !== 61) at++;
		if (at === nameStart) {
			at++; // a stray `=`
			continue;
		}
		const nameEnd = at;
		while (at < length && blank(source.charCodeAt(at))) at++;
		if (source.charCodeAt(at) !== 61) continue;
		at++;
		while (at < length && blank(source.charCodeAt(at))) at++;
		const quote = source.charCodeAt(at);
		if (quote !== 34 && quote !== 39) continue;
		const close = source.indexOf(quote === 34 ? '"' : "'", at + 1);
		if (close < 0) return attrs;
		attrs[localName(source.slice(nameStart, nameEnd))] = decodeXmlText(source.slice(at + 1, close));
		at = close + 1;
	}
	return attrs;
}

/** Whether the part declares a DTD or an entity anywhere (checked before scanning). */
export function hasDeclaration(xml: string): boolean {
	return /<!(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i.test(xml);
}

/** The tag name at `from` (after `<`): up to the first blank, `/` or `>`; never past `end`. */
function nameAt(xml: string, from: number, end: number): string {
	let at = from;
	for (; at < end; at++) {
		const c = xml.charCodeAt(at);
		if (c === 32 || (c >= 9 && c <= 13) || c === 47 || c === 62) break;
	}
	return localName(xml.slice(from, at));
}

/**
 * Scans `xml`, calling `handler` per tag and text run; throws UnsafeXmlError, XmlBudgetError or XmlSyntaxError.
 * An open tag past XML_TAG_MAX_LENGTH refuses the part, except a tag named in `longTags`: its attributes are
 * never parsed and it opens (and, when self-closing, closes) with none, so nesting stays balanced. Excel writes
 * `sqref` lists of thousands of ranges on such tags in heavily edited sheets.
 */
export function scanXml(
	xml: string,
	handler: XmlHandler,
	budget: XmlBudget,
	longTags?: ReadonlySet<string>
): void {
	if (hasDeclaration(xml)) throw new UnsafeXmlError();
	let at = 0;
	const length = xml.length;
	while (at < length) {
		const lt = xml.indexOf('<', at);
		if (lt < 0) {
			if (handler.text && at < length) handler.text(xml.slice(at));
			return;
		}
		if (lt > at && handler.text) handler.text(xml.slice(at, lt));
		if (--budget.tags < 0) throw new XmlBudgetError();
		const next = xml.charCodeAt(lt + 1);
		if (next === 63 /* ? */) {
			const end = xml.indexOf('?>', lt + 2);
			if (end < 0) throw new XmlSyntaxError();
			at = end + 2;
			continue;
		}
		if (next === 33 /* ! */) {
			if (xml.startsWith('<!--', lt)) {
				const end = xml.indexOf('-->', lt + 4);
				if (end < 0) throw new XmlSyntaxError();
				at = end + 3;
				continue;
			}
			if (xml.startsWith('<![CDATA[', lt)) {
				const end = xml.indexOf(']]>', lt + 9);
				if (end < 0) throw new XmlSyntaxError();
				// CDATA is raw text: passed through an escape so the handler's decode leaves it as written.
				handler.text?.(xml.slice(lt + 9, end).replace(/&/g, '&amp;'));
				at = end + 3;
				continue;
			}
			throw new UnsafeXmlError();
		}
		if (next === 47 /* / */) {
			const end = xml.indexOf('>', lt + 2);
			if (end < 0) throw new XmlSyntaxError();
			handler.close?.(localName(xml.slice(lt + 2, end).trim()));
			at = end + 1;
			continue;
		}
		// An open tag; a `>` inside a quoted attribute value does not end it.
		let end = lt + 1;
		let quote = 0;
		for (; end < length; end++) {
			const c = xml.charCodeAt(end);
			if (quote) {
				if (c === quote) quote = 0;
			} else if (c === 34 || c === 39) quote = c;
			else if (c === 62 /* > */) break;
		}
		if (end >= length) throw new XmlSyntaxError();
		const selfClosing = xml.charCodeAt(end - 1) === 47;
		if (end - lt > XML_TAG_MAX_LENGTH) {
			const name = nameAt(xml, lt + 1, end);
			if (!longTags?.has(name)) throw new XmlBudgetError();
			handler.open?.(name, {}, selfClosing);
			if (selfClosing) handler.close?.(name);
			at = end + 1;
			continue;
		}
		const inner = xml.slice(lt + 1, selfClosing ? end - 1 : end);
		const space = inner.search(/\s/);
		const name = localName(space < 0 ? inner : inner.slice(0, space));
		const attrs = space < 0 ? {} : parseAttrs(inner.slice(space));
		handler.open?.(name, attrs, selfClosing);
		if (selfClosing) handler.close?.(name);
		at = end + 1;
	}
}
