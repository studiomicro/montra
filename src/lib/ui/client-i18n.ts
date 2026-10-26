import type { Locale, Translator } from '#lib/shared/i18n';

/**
 * The browser's translator. `createTranslator` in shared/i18n.ts imports the whole English table (about 70 kB
 * gzipped), which would ship to every Indonesian visitor who never reads it. The browser takes it from here
 * instead: the root universal load awaits `loadEnglish()` for an English user before anything renders, so the
 * table is in place for the server render and for hydration, and nobody else downloads it.
 * client-i18n.test.ts pins this to the shared translator.
 */
let english: Record<string, string> | undefined;

/** Fetches the English table once; a no-op for Indonesian. */
export async function loadEnglish(locale: Locale): Promise<void> {
	if (locale !== 'en' || english) return;
	english = (await import('#lib/shared/i18n-en')).en;
}

/** Same behaviour as the shared `createTranslator`; English phrases need `loadEnglish('en')` to have resolved. */
export function createClientTranslator(locale: Locale): Translator {
	const table: Record<string, string> = locale === 'en' ? (english ?? {}) : {};

	function tr(phrase: string): string {
		return Object.hasOwn(table, phrase) ? (table[phrase] as string) : phrase;
	}

	function trf(template: string, values: Record<string, string | number>): string {
		return tr(template).replace(/\{(\w+)\}/g, (whole, name: string) =>
			Object.hasOwn(values, name) ? String(values[name]) : whole
		);
	}

	return { locale, tr, trf };
}
