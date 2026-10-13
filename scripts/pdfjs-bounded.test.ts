import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { patchPdfjs, PDFJS_MODULE, pdfjsBounded } from './pdfjs-bounded';

const source = readFileSync(
	new URL('../node_modules/unpdf/dist/pdfjs.mjs', import.meta.url),
	'utf8'
);

describe('pdfjs-bounded', () => {
	it('patches the pinned PDF.js build at every decode point', () => {
		const patched = patchPdfjs(source);
		expect(patched).toContain('__finCharge(n-t.byteLength);let r=new Uint8Array(n)');
		expect(patched).toContain('{__finCharge(e.byteLength);a.push(e)');
		expect(patched.split('get isAsync(){return!__finBudget&&this.#e}')).toHaveLength(3);
		expect(patched).toContain('makeFilter(e,t,n,r,i=null){if(__finBudget&&!__finFilterOk(t,e))');
		expect(patched).toContain('e.length>__finBudget.maxContentRefs');
		expect(patched.match(/decodeImage\([a-z,]*\)\{__finNoImage\(\);/g)).toHaveLength(4);
		expect(patched).toContain('export function montraDecodeBudget(budget)');
	});

	it('fails the build when an anchor no longer matches (a PDF.js upgrade must be re-checked)', () => {
		for (const [from, to, what] of [
			['let n=this.minBufferLength;', 'let n=1;', /ensureBuffer/],
			['a.push(e),o+=e.byteLength', 'a.push(e)', /DecompressionStream/],
			['get isAsync(){return this.#e}', 'get isAsync(){return!1}', /isAsync/],
			['makeFilter(e,t,n,r,i=null){', 'makeFilter(e,t,n,r){', /makeFilter/],
			['StreamsSequenceStream=class', 'SSS=class', /StreamsSequenceStream/]
		] as const)
			expect(() => patchPdfjs(source.replace(from, to))).toThrow(what);
		expect(() => patchPdfjs('export {}')).toThrow();
	});

	it('the plugin transforms only the unpdf PDF.js module', () => {
		const plugin = pdfjsBounded();
		expect(PDFJS_MODULE.test('/x/node_modules/unpdf/dist/pdfjs.mjs')).toBe(true);
		expect(plugin.transform('const a = 1', '/x/node_modules/unpdf/dist/index.mjs')).toBeNull();
	});

	it('N3: the build fails when unpdf/pdfjs no longer resolves to the patched path', async () => {
		const plugin = pdfjsBounded();
		const context = (id: string | null) => ({
			resolve: async () => (id ? { id } : null),
			error: (message: string): never => {
				throw new Error(message);
			}
		});
		await expect(
			plugin.buildStart.call(context('/x/node_modules/unpdf/dist/pdfjs.mjs'))
		).resolves.toBeUndefined();
		await expect(
			plugin.buildStart.call(context('/x/node_modules/unpdf/lib/pdf.js'))
		).rejects.toThrow(/decode budget would not apply/);
		await expect(plugin.buildStart.call(context(null))).rejects.toThrow(/resolves to nothing/);
	});
});
