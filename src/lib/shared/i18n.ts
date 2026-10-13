import { en } from './i18n-en.ts';

export type Locale = 'id' | 'en';

const LOCALES: readonly Locale[] = ['id', 'en'];

function isLocale(value: string | undefined | null): value is Locale {
	return value === 'id' || value === 'en';
}

/** Marks a phrase in a static table for translation; translate it later with tr(). */
export function msg(phrase: string): string {
	return phrase;
}

/** A translator bound to one locale. Create one per request (server) or per page (client); never share one. */
export function createTranslator(locale: Locale) {
	const table: Record<string, string> = locale === 'en' ? en : {};

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

export type Translator = ReturnType<typeof createTranslator>;

/** Cookie `lang` wins; then the first supported language in Accept-Language; then Indonesian. */
export function resolveLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
	if (isLocale(cookie)) return cookie;
	if (acceptLanguage) {
		for (const part of acceptLanguage.split(',')) {
			const tag = part.split(';')[0]?.trim().toLowerCase().split('-')[0];
			if (isLocale(tag)) return tag;
		}
	}
	return LOCALES[0] as Locale;
}
