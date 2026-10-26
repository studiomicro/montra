import { loadEnglish } from '#lib/ui/client-i18n';
import type { LayoutLoad } from './$types';

// The English phrase table is its own chunk, fetched only for an English user (see client-i18n.ts).
export const load: LayoutLoad = async ({ data }) => {
	await loadEnglish(data.locale);
	return data;
};
