/**
 * Reading rendered markup in tests: comments, scripts and tags removed until the text stops changing, so one pass can
 * never leave a new match behind (`<!-<!---->->`), and `<script>` matched in any case. Test-only; the app never
 * sanitises HTML with regexes.
 */
function untilStable(text: string, pattern: RegExp, by: string): string {
	let previous: string;
	do {
		previous = text;
		text = text.replace(pattern, by);
	} while (text !== previous);
	return text;
}

export const stripComments = (html: string) => untilStable(html, /<!--[\s\S]*?-->/g, '');

export const stripCssComments = (css: string) => untilStable(css, /\/\*[\s\S]*?\*\//g, '');

export const stripScripts = (html: string) =>
	untilStable(html, /<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, '');

export const stripTags = (html: string, by = '') => untilStable(html, /<[^>]+>/g, by);
