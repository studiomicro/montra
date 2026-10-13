/** One run of a filled template: `strong` for a substituted value (shown bold in a context line). */
export interface RichPart {
	text: string;
	strong: boolean;
}

/**
 * A translated template ("rata-rata {jumlah}/hari") split into plain runs and bold values, so a context line can
 * bold its figures (APP_PARITY § 2) without splitting the phrase for translators. Unknown placeholders stay
 * as written, like trf().
 */
export function richParts(template: string, values: Record<string, string | number>): RichPart[] {
	const parts: RichPart[] = [];
	let last = 0;
	for (const m of template.matchAll(/\{(\w+)\}/g)) {
		const name = m[1] as string;
		if (!Object.hasOwn(values, name)) continue;
		if (m.index > last) parts.push({ text: template.slice(last, m.index), strong: false });
		parts.push({ text: String(values[name]), strong: true });
		last = m.index + m[0].length;
	}
	if (last < template.length) parts.push({ text: template.slice(last), strong: false });
	return parts;
}
