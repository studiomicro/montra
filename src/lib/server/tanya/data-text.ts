import { cleanText } from '../../shared/text.ts';

/**
 * Stored text as a tool result (FN-22) or the Agen narrative's data (FN-23) carries it: invisible characters
 * stripped, capped, and the figure placeholder syntax broken up so a merchant named `[[f:1]]` can never become a
 * figure. Node-safe imports, so the owner-run compat scripts can load it.
 */
export function dataText(text: string, max: number): string {
	return cleanText(text, max).replace(/\[\[/g, '[ [').replace(/\]\]/g, '] ]');
}
