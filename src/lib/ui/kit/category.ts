import { msg } from '#lib/shared/i18n';

export const CATEGORIES = {
	kopi: { label: msg('Kopi'), emoji: '☕', cssVar: '--cat-kopi' },
	makan: { label: msg('Makan & Minum'), emoji: '🍜', cssVar: '--cat-makan' },
	'belanja-harian': { label: msg('Belanja Harian'), emoji: '🛒', cssVar: '--cat-belanja-harian' },
	belanja: { label: msg('Belanja'), emoji: '🛍️', cssVar: '--cat-belanja' },
	transportasi: { label: msg('Transportasi'), emoji: '🛵', cssVar: '--cat-transportasi' },
	'ojek-online': { label: msg('Ojek Online'), emoji: '🛺', cssVar: '--cat-ojek-online' },
	'pesan-antar-makanan': {
		label: msg('Pesan Antar Makanan'),
		emoji: '🥡',
		cssVar: '--cat-pesan-antar-makanan'
	},
	tagihan: { label: msg('Tagihan'), emoji: '🧾', cssVar: '--cat-tagihan' },
	hiburan: { label: msg('Hiburan'), emoji: '🎬', cssVar: '--cat-hiburan' },
	kesehatan: { label: msg('Kesehatan'), emoji: '💊', cssVar: '--cat-kesehatan' },
	pendidikan: { label: msg('Pendidikan'), emoji: '📚', cssVar: '--cat-pendidikan' },
	'tempat-tinggal': { label: msg('Tempat Tinggal'), emoji: '🏠', cssVar: '--cat-tempat-tinggal' },
	// FN-48 bank-statement tiles.
	'biaya-bank': { label: msg('Biaya Bank'), emoji: '🏦', cssVar: '--cat-biaya-bank' },
	pajak: { label: msg('Pajak'), emoji: '🧮', cssVar: '--cat-pajak' },
	'tarik-tunai': { label: msg('Tarik Tunai'), emoji: '💵', cssVar: '--cat-tarik-tunai' },
	'kartu-kredit': { label: msg('Kartu Kredit'), emoji: '💳', cssVar: '--cat-kartu-kredit' },
	transfer: { label: msg('Transfer'), emoji: '🔁', cssVar: '--cat-transfer' },
	bunga: { label: msg('Bunga'), emoji: '📈', cssVar: '--cat-bunga' },
	gaji: { label: msg('Gaji'), emoji: '💼', cssVar: '--cat-gaji' },
	bonus: { label: msg('Bonus'), emoji: '🎁', cssVar: '--cat-bonus' },
	freelance: { label: msg('Freelance'), emoji: '💻', cssVar: '--cat-freelance' },
	hadiah: { label: msg('Hadiah'), emoji: '🎀', cssVar: '--cat-hadiah' },
	lain: { label: msg('Lainnya'), emoji: '✨', cssVar: '--cat-lain' }
} as const;

export type CategoryKey = keyof typeof CATEGORIES;

/**
 * Whether a comparison line has anything to say: not when nothing was spent in either period (both zero), where
 * "Hampir sama" would be true but empty. `currentMinor` null (too large to show) still compares.
 */
export function hasComparison(currentMinor: number | null, diffMinor: number): boolean {
	return !(currentMinor === 0 && diffMinor === 0);
}

/** "Hampir sama" when the month-over-month difference is within the threshold (inclusive). */
export function comparisonKind(
	diffMinor: number,
	thresholdMinor: number
): 'more' | 'less' | 'same' {
	if (Math.abs(diffMinor) <= thresholdMinor) return 'same';
	return diffMinor > 0 ? 'more' : 'less';
}
