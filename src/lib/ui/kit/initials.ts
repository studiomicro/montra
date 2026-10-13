import type { CategoryKey } from './category';

/**
 * Generated initials tiles (FN-26): a subscription's tile is drawn from its name only, never a fetched or
 * bundled logo. The colour is one of the design system's category tokens, picked by a stable hash of the name,
 * so the same name always gets the same tile in both themes (AA: tile text is `--ink` on a 16 % tint).
 */
export const INITIALS_PALETTE: readonly CategoryKey[] = [
	'kopi',
	'makan',
	'belanja-harian',
	'belanja',
	'transportasi',
	'tagihan',
	'hiburan',
	'kesehatan',
	'pendidikan',
	'tempat-tinggal',
	'gaji',
	'bonus',
	'freelance',
	'hadiah'
];

/** Letters and digits of a word (any script), so "Disney+" reads as "Disney" and "iCloud+" as "iCloud". */
const wordChars = (word: string) => Array.from(word).filter((c) => /[\p{L}\p{N}]/u.test(c));

/**
 * Up to two upper-case initials: the first character of the first two words ("Disney+ Hotstar" → "DH"),
 * else the first two characters of the one word ("Netflix" → "NE"); "?" when the name has no letter or digit.
 */
export function initials(name: string): string {
	const words = name
		.split(/\s+/)
		.map(wordChars)
		.filter((w) => w.length > 0);
	const picked =
		words.length >= 2 ? [words[0]?.[0] ?? '', words[1]?.[0] ?? ''] : (words[0] ?? []).slice(0, 2);
	return picked.length > 0 ? picked.join('').toLocaleUpperCase('id') : '?';
}

/** The palette slot of `name`: FNV-1a over its lower-cased code points, so it never changes between visits. */
export function initialsColour(name: string): CategoryKey {
	let hash = 0x811c9dc5;
	for (const c of name.trim().toLocaleLowerCase('id')) {
		hash ^= c.codePointAt(0) as number;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return INITIALS_PALETTE[hash % INITIALS_PALETTE.length] as CategoryKey;
}
