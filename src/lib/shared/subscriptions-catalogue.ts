import { msg } from './i18n.ts';

/**
 * FN-26: our own hand-kept list of common services in Indonesia, to fill a subscription's name and category
 * in one tap. Service names only (proper nouns, never translated): no logos, brand marks, images, links or
 * copy of any service or of the reference product. Each tile is drawn as initials (InitialsTile). "Lainnya"
 * with a typed name covers everything not listed, so this list is a convenience, never a limit; growing it is
 * a content change, not a schema change.
 */

/** A subscription's category; `tileKey` is the FN-06 preset expense category a "mark paid" row goes to. */
export const SUBSCRIPTION_CATEGORIES = {
	streaming: { label: msg('Streaming'), tileKey: 'hiburan' },
	musik: { label: msg('Musik'), tileKey: 'hiburan' },
	game: { label: msg('Game'), tileKey: 'hiburan' },
	telko: { label: msg('Pulsa & internet'), tileKey: 'tagihan' },
	cloud: { label: msg('Penyimpanan cloud'), tileKey: 'tagihan' },
	software: { label: msg('Aplikasi & software'), tileKey: 'tagihan' },
	belajar: { label: msg('Belajar'), tileKey: 'pendidikan' },
	// FN-26b: electricity and water bills.
	utilitas: { label: msg('Utilitas'), tileKey: 'tagihan' },
	lainnya: { label: msg('Lainnya'), tileKey: 'tagihan' }
} as const;
export type SubscriptionCategory = keyof typeof SUBSCRIPTION_CATEGORIES;
export const SUBSCRIPTION_CATEGORY_KEYS = Object.keys(
	SUBSCRIPTION_CATEGORIES
) as SubscriptionCategory[];

export function isSubscriptionCategory(value: string): value is SubscriptionCategory {
	return Object.hasOwn(SUBSCRIPTION_CATEGORIES, value);
}

export interface CatalogueEntry {
	/** Stable id stored in `subscriptions.catalogue_id`; never reused for another service. */
	id: string;
	name: string;
	category: SubscriptionCategory;
}

export const SUBSCRIPTION_CATALOGUE: readonly CatalogueEntry[] = [
	{ id: 'netflix', name: 'Netflix', category: 'streaming' },
	{ id: 'disney-hotstar', name: 'Disney+ Hotstar', category: 'streaming' },
	{ id: 'youtube-premium', name: 'YouTube Premium', category: 'streaming' },
	{ id: 'prime-video', name: 'Prime Video', category: 'streaming' },
	{ id: 'vidio', name: 'Vidio', category: 'streaming' },
	{ id: 'viu', name: 'Viu', category: 'streaming' },
	{ id: 'wetv', name: 'WeTV', category: 'streaming' },
	{ id: 'iqiyi', name: 'iQIYI', category: 'streaming' },
	{ id: 'hbo-go', name: 'HBO GO', category: 'streaming' },
	{ id: 'catchplay', name: 'Catchplay+', category: 'streaming' },
	{ id: 'apple-tv', name: 'Apple TV+', category: 'streaming' },
	{ id: 'spotify', name: 'Spotify', category: 'musik' },
	{ id: 'apple-music', name: 'Apple Music', category: 'musik' },
	{ id: 'youtube-music', name: 'YouTube Music', category: 'musik' },
	{ id: 'joox', name: 'JOOX', category: 'musik' },
	{ id: 'playstation-plus', name: 'PlayStation Plus', category: 'game' },
	{ id: 'xbox-game-pass', name: 'Xbox Game Pass', category: 'game' },
	{ id: 'nintendo-switch-online', name: 'Nintendo Switch Online', category: 'game' },
	{ id: 'telkomsel', name: 'Telkomsel', category: 'telko' },
	{ id: 'indosat', name: 'Indosat', category: 'telko' },
	{ id: 'xl', name: 'XL', category: 'telko' },
	{ id: 'tri', name: 'Tri', category: 'telko' },
	{ id: 'smartfren', name: 'Smartfren', category: 'telko' },
	{ id: 'indihome', name: 'IndiHome', category: 'telko' },
	{ id: 'biznet', name: 'Biznet', category: 'telko' },
	{ id: 'first-media', name: 'First Media', category: 'telko' },
	{ id: 'myrepublic', name: 'MyRepublic', category: 'telko' },
	{ id: 'google-one', name: 'Google One', category: 'cloud' },
	{ id: 'icloud', name: 'iCloud+', category: 'cloud' },
	{ id: 'dropbox', name: 'Dropbox', category: 'cloud' },
	{ id: 'microsoft-365', name: 'Microsoft 365', category: 'software' },
	{ id: 'adobe-creative-cloud', name: 'Adobe Creative Cloud', category: 'software' },
	{ id: 'canva-pro', name: 'Canva Pro', category: 'software' },
	{ id: 'chatgpt-plus', name: 'ChatGPT Plus', category: 'software' },
	{ id: 'claude-pro', name: 'Claude Pro', category: 'software' },
	{ id: 'notion', name: 'Notion', category: 'software' },
	{ id: 'duolingo', name: 'Duolingo', category: 'belajar' },
	{ id: 'ruangguru', name: 'Ruangguru', category: 'belajar' },
	// FN-26b: electricity and water (names only, the amount is always typed).
	{ id: 'pln', name: 'PLN', category: 'utilitas' },
	{ id: 'pdam', name: 'PDAM', category: 'utilitas' },
	// FN-39: ride-hailing and food-delivery memberships. `lainnya` books a payment to the Tagihan tile like a bill;
	// no price is kept (the amount is always typed).
	{ id: 'gopay-plus', name: 'GoPay Plus', category: 'lainnya' },
	{ id: 'gofood-plus', name: 'GoFood Plus', category: 'lainnya' },
	{ id: 'grabunlimited', name: 'GrabUnlimited', category: 'lainnya' }
];

/** The catalogue entry with id `id`, or null (an unknown id is refused by the form, never stored). */
export function catalogueEntry(id: string): CatalogueEntry | null {
	return SUBSCRIPTION_CATALOGUE.find((e) => e.id === id) ?? null;
}
