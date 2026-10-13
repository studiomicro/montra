import { getContext, setContext } from 'svelte';
import type { Locale, Translator } from '#lib/shared/i18n';

const KEY = Symbol('i18n');

export function setI18n(translator: Translator): void {
	setContext(KEY, translator);
}

export function useI18n(): Translator {
	const t = getContext<Translator | undefined>(KEY);
	if (!t) throw new Error('useI18n() called outside the root layout');
	return t;
}

/**
 * The UI language for number formatting in kit components, which also render standalone (unit tests, previews):
 * Indonesian when no translator is provided.
 */
export function useLocale(): Locale {
	return getContext<Translator | undefined>(KEY)?.locale ?? 'id';
}
