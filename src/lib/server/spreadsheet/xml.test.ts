import { describe, expect, it } from 'vitest';
import { scanXml, XML_TAG_MAX_LENGTH, XmlBudgetError } from './xml';

/** Every handler call, in order: `<name {attrs}`, `/name` (self-closing marked `<name/`). */
function events(xml: string, longTags?: ReadonlySet<string>): string[] {
	const out: string[] = [];
	scanXml(
		xml,
		{
			open: (name, attrs, selfClosing) =>
				out.push(`<${name}${selfClosing ? '/' : ''} ${JSON.stringify(attrs)}`),
			close: (name) => out.push(`/${name}`)
		},
		{ tags: 1_000_000 },
		longTags
	);
	return out;
}

const LONG = new Set(['dataValidation', 'ignoredError']);
const sqref = (min: number) => {
	const ranges: string[] = [];
	for (let i = 0, n = 0; n <= min; i++) {
		const r = `A${3 * i + 1}:B${3 * i + 2}`;
		ranges.push(r);
		n += r.length + 1;
	}
	return ranges.join(' ');
};

describe('scanXml: open tags past XML_TAG_MAX_LENGTH (FN-17 L5)', () => {
	it('a named long tag opens with no attributes and keeps nesting balanced', () => {
		const xml = `<w><dataValidation type="list" sqref="${sqref(40_000)}"><formula1>1</formula1></dataValidation><x a="1"/></w>`;
		expect(events(xml, LONG)).toEqual([
			'<w {}',
			'<dataValidation {}',
			'<formula1 {}',
			'/formula1',
			'/dataValidation',
			'<x/ {"a":"1"}',
			'/x',
			'/w'
		]);
	});

	it('a self-closing named long tag (with a namespace prefix) opens and closes', () => {
		const xml = `<w><x:ignoredError sqref="${sqref(40_000)}" numberStoredAsText="1"/></w>`;
		expect(events(xml, LONG)).toEqual(['<w {}', '<ignoredError/ {}', '/ignoredError', '/w']);
	});

	it('a long tag that is not named, or with no names given, still refuses', () => {
		const long = `<conditionalFormatting sqref="${sqref(40_000)}"></conditionalFormatting>`;
		expect(() => events(long, LONG)).toThrow(XmlBudgetError);
		expect(() => events(`<dataValidation sqref="${sqref(40_000)}"/>`)).toThrow(XmlBudgetError);
		expect(() => events(`<c r="A1" x="${'a'.repeat(XML_TAG_MAX_LENGTH)}"/>`, LONG)).toThrow(
			XmlBudgetError
		);
		// A name that only starts like a tolerated one is another tag.
		expect(() => events(`<dataValidationX sqref="${sqref(40_000)}"/>`, LONG)).toThrow(
			XmlBudgetError
		);
	});

	it('a named tag under the cap still has its attributes parsed', () => {
		expect(events('<dataValidation sqref="A1:B2" type="list"/>', LONG)).toEqual([
			'<dataValidation/ {"sqref":"A1:B2","type":"list"}',
			'/dataValidation'
		]);
	});

	it('a `>` inside the long quoted value does not end the tag', () => {
		const xml = `<dataValidation prompt="a > b" sqref="${sqref(40_000)}"/>`;
		expect(events(xml, LONG)).toEqual(['<dataValidation/ {}', '/dataValidation']);
	});

	it('one 16 MB named tag scans in linear time', () => {
		const xml = `<w><dataValidation sqref="${sqref(16_000_000)}"/></w>`;
		const start = performance.now();
		expect(events(xml, LONG)).toHaveLength(4);
		expect(performance.now() - start).toBeLessThan(1000);
	});
});
