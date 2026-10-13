function luminance(hex: string): number {
	const h = hex.replace('#', '');
	const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
	const [r, g, b] = channels.map((c) =>
		c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio for two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** Hex custom properties declared in the first block that starts with `selector`. */
export function readTokens(css: string, selector: string): Record<string, string> {
	const start = css.indexOf(selector);
	if (start < 0) throw new Error(`selector not found: ${selector}`);
	const block = css.slice(start, css.indexOf('}', start));
	const tokens: Record<string, string> = {};
	for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
		tokens[m[1] as string] = (m[2] as string).toLowerCase();
	}
	return tokens;
}
