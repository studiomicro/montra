import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';

/** The compiled (scoped) CSS of a component. */
export function cssOf(file: string): string {
	return compile(readFileSync(file, 'utf8'), { filename: file, css: 'external' }).css?.code ?? '';
}

export interface Declaration {
	property: string;
	value: string;
	/** The selectors and at-rules it sits in, outermost first. */
	context: string[];
}

/** Every declaration in a stylesheet with its enclosing rules (a small brace scanner; comments removed). */
export function declarations(css: string): Declaration[] {
	const out: Declaration[] = [];
	const stack: string[] = [];
	let text = '';
	const flush = () => {
		const decl = text.trim();
		text = '';
		const colon = decl.indexOf(':');
		if (colon > 0)
			out.push({
				property: decl.slice(0, colon).trim(),
				value: decl.slice(colon + 1).trim(),
				context: [...stack]
			});
	};
	for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
		if (ch === '{') {
			stack.push(text.trim());
			text = '';
		} else if (ch === '}') {
			flush();
			stack.pop();
		} else if (ch === ';') flush();
		else text += ch;
	}
	return out;
}
