import { TITLE_MAX_LENGTH, type TileKey } from './transactions.ts';
import {
	FOOD_DELIVERY_WORDS,
	KEYWORD_GROUPS,
	keywordLookup,
	RIDE_HAILING_WORDS
} from './merchants/dictionary.ts';

/**
 * The keyword guesses of voice, Slack drafts and imports, read from the one word table in
 * `merchants/dictionary.ts` (FN-06 fixed map, widened 2026-10-08 by FN-39, made part of FN-20's dictionary).
 * Voice (FN-14) and Slack drafts (FN-29, through `parseVoiceSentence`) use every keyword group;
 * `importCategoryFromTitle` keeps FN-39's ride-hailing and food-delivery groups only. CSV and statement imports
 * (FN-18, FN-16a) now go through FN-20's resolver first, which reads the whole dictionary and every keyword
 * group (FN-20 owner decision 3); this function is their fallback. Matching is whole-word only, on words
 * already lower-cased and stripped of punctuation: `grab` and `grabfood` are two separate entries, and "grab
 * food" written as two words reads as `grab` (ride-hailing) here, a known limit. Service names are matched as
 * typed and never translated.
 */

const IMPORT_GROUPS = [FOOD_DELIVERY_WORDS, RIDE_HAILING_WORDS] as const;

/**
 * The preset tile a spoken or typed item's words name, or undefined. `bareWords`: the item's words lower-cased
 * with the punctuation around them removed (as `parseVoiceSentence` reads them).
 */
export function categoryHintFromWords(bareWords: readonly string[]): TileKey | undefined {
	return keywordLookup(bareWords, KEYWORD_GROUPS);
}

/**
 * The ride-hailing or food-delivery tile an imported row's description names ("GRABFOOD JKT",
 * "GOJEK*JAKARTA"), or undefined. The description is cut to the title length first and split at every
 * character that is not a letter or digit, so one pass over at most TITLE_MAX_LENGTH characters.
 */
export function importCategoryFromTitle(title: string): TileKey | undefined {
	const words = Array.from(title.slice(0, TITLE_MAX_LENGTH * 2))
		.slice(0, TITLE_MAX_LENGTH)
		.join('')
		.replace(/[A-Z]/g, (c) => c.toLowerCase())
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w !== '');
	return keywordLookup(words, IMPORT_GROUPS);
}
