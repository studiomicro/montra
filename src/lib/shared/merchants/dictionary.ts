import { PRESET_CATEGORIES, type CategoryKind, type TileKey } from '../transactions.ts';

/**
 * FN-20: the one deterministic word table of the app. Two layers, read in this order:
 *
 * 1. DICTIONARY: curated, generic merchant and payment words (shop types, chains as plain words, bill and
 *    salary words) to a preset tile. Text only: no logos, no brand marks, no claimed affiliation; the merchant
 *    name shown is always the cleaned descriptor, never something this table invents. Edited in code and
 *    reviewed in a PR (owner decision 2), about 150 patterns.
 * 2. The keyword groups (FN-06 fixed map, widened by FN-39): food delivery, ride-hailing, kopi/makan/parkir/
 *    bensin. Voice and Slack read them through `categoryHintFromWords` (category-keywords.ts).
 *
 * Matching is whole-token only, on lower-cased tokens: `grab` never matches "grabber", and a phrase matches only
 * as consecutive tokens. A word maps to one tile, whose preset kind (expense or income) is the only kind it
 * answers for: an income word never names an expense category and vice versa.
 */

/** Food delivery: checked first, so a sentence naming both a ride and a food service is food. */
export const FOOD_DELIVERY_WORDS: Readonly<Record<string, TileKey>> = {
	gofood: 'pesan-antar-makanan',
	grabfood: 'pesan-antar-makanan',
	shopeefood: 'pesan-antar-makanan'
};
export const RIDE_HAILING_WORDS: Readonly<Record<string, TileKey>> = {
	gojek: 'ojek-online',
	goride: 'ojek-online',
	gocar: 'ojek-online',
	grab: 'ojek-online',
	grabbike: 'ojek-online',
	grabcar: 'ojek-online',
	maxim: 'ojek-online',
	ojol: 'ojek-online'
};
/** The FN-06 fixed keyword map (kopi, makan, parkir, bensin). */
export const FIXED_WORDS: Readonly<Record<string, TileKey>> = {
	kopi: 'kopi',
	makan: 'makan',
	parkir: 'transportasi',
	bensin: 'transportasi'
};

/** Keyword groups in priority order; within a group the first matching word (reading order) wins. */
export const KEYWORD_GROUPS = [FOOD_DELIVERY_WORDS, RIDE_HAILING_WORDS, FIXED_WORDS] as const;

/** The first tile any word of `words` names in `groups` (group order, then reading order). */
export function keywordLookup(
	words: readonly string[],
	groups: readonly Readonly<Record<string, TileKey>>[]
): TileKey | undefined {
	for (const group of groups) {
		const hit = words.find((w) => Object.hasOwn(group, w));
		if (hit !== undefined) return group[hit];
	}
	return undefined;
}

/**
 * The curated dictionary: a pattern (one or more lower-case words) and its tile, in priority order (the first
 * entry whose pattern appears wins). Multi-word patterns come before the single words they contain.
 */
const ENTRIES: readonly (readonly [string, TileKey])[] = [
	// Salary, bonus and other income words (income tiles only ever answer income rows).
	['gaji', 'gaji'],
	['payroll', 'gaji'],
	['salary', 'gaji'],
	['upah', 'gaji'],
	['thr', 'bonus'],
	['bonus', 'bonus'],
	['insentif', 'bonus'],
	['komisi', 'bonus'],
	['honor', 'freelance'],
	['honorarium', 'freelance'],
	['fee', 'freelance'],
	['invoice', 'freelance'],
	['hadiah', 'hadiah'],
	['angpao', 'hadiah'],
	['bunga', 'bunga'],
	['interest', 'bunga'],
	['jasa giro', 'bunga'],
	['refund', 'lain'],
	['cashback', 'lain'],
	['pengembalian', 'lain'],
	['dividen', 'lain'],
	// Coffee shops.
	['coffee', 'kopi'],
	['cafe', 'kopi'],
	['kafe', 'kopi'],
	['kopitiam', 'kopi'],
	['starbucks', 'kopi'],
	['janji jiwa', 'kopi'],
	['tomoro', 'kopi'],
	['excelso', 'kopi'],
	['espresso', 'kopi'],
	// Food delivery and ride-hailing words beyond the FN-39 keyword groups.
	['go food', 'pesan-antar-makanan'],
	['grab food', 'pesan-antar-makanan'],
	['shopee food', 'pesan-antar-makanan'],
	['ojek', 'ojek-online'],
	['go ride', 'ojek-online'],
	['go car', 'ojek-online'],
	['indriver', 'ojek-online'],
	// Restaurants and food.
	['rumah makan', 'makan'],
	['restoran', 'makan'],
	['restaurant', 'makan'],
	['resto', 'makan'],
	['warteg', 'makan'],
	['warung', 'makan'],
	['bakso', 'makan'],
	['sate', 'makan'],
	['nasi', 'makan'],
	['mie', 'makan'],
	['bakery', 'makan'],
	['mcdonalds', 'makan'],
	['mcd', 'makan'],
	['kfc', 'makan'],
	['burger king', 'makan'],
	['pizza', 'makan'],
	['hokben', 'makan'],
	['solaria', 'makan'],
	['richeese', 'makan'],
	['chatime', 'makan'],
	['mixue', 'makan'],
	// Minimarkets and supermarkets.
	['indomaret', 'belanja-harian'],
	['alfamart', 'belanja-harian'],
	['alfamidi', 'belanja-harian'],
	['lawson', 'belanja-harian'],
	['familymart', 'belanja-harian'],
	['circle k', 'belanja-harian'],
	['superindo', 'belanja-harian'],
	['super indo', 'belanja-harian'],
	['hypermart', 'belanja-harian'],
	['transmart', 'belanja-harian'],
	['lottemart', 'belanja-harian'],
	['lotte mart', 'belanja-harian'],
	['giant', 'belanja-harian'],
	['ranch market', 'belanja-harian'],
	['farmers market', 'belanja-harian'],
	['supermarket', 'belanja-harian'],
	['minimarket', 'belanja-harian'],
	['swalayan', 'belanja-harian'],
	['pasar', 'belanja-harian'],
	['sayur', 'belanja-harian'],
	['toserba', 'belanja-harian'],
	// E-commerce and shops.
	['tokopedia', 'belanja'],
	['shopee', 'belanja'],
	['lazada', 'belanja'],
	['blibli', 'belanja'],
	['bukalapak', 'belanja'],
	['tiktok shop', 'belanja'],
	['zalora', 'belanja'],
	['ikea', 'belanja'],
	['ace hardware', 'belanja'],
	['uniqlo', 'belanja'],
	['matahari', 'belanja'],
	['erafone', 'belanja'],
	['ibox', 'belanja'],
	['gramedia', 'pendidikan'],
	// Fuel, parking, toll and public transport.
	['pertamina', 'transportasi'],
	['spbu', 'transportasi'],
	['shell', 'transportasi'],
	['vivo', 'transportasi'],
	['bbm', 'transportasi'],
	['tol', 'transportasi'],
	['jasa marga', 'transportasi'],
	['jasamarga', 'transportasi'],
	['etoll', 'transportasi'],
	['e toll', 'transportasi'],
	['parking', 'transportasi'],
	['secure parking', 'transportasi'],
	['krl', 'transportasi'],
	['commuter line', 'transportasi'],
	['kai', 'transportasi'],
	['mrt', 'transportasi'],
	['lrt', 'transportasi'],
	['transjakarta', 'transportasi'],
	['damri', 'transportasi'],
	['bluebird', 'transportasi'],
	['blue bird', 'transportasi'],
	['taksi', 'transportasi'],
	['taxi', 'transportasi'],
	['garuda', 'transportasi'],
	['citilink', 'transportasi'],
	['lion air', 'transportasi'],
	['airasia', 'transportasi'],
	// Streaming and subscriptions.
	['netflix', 'hiburan'],
	['spotify', 'hiburan'],
	['youtube premium', 'hiburan'],
	['disney', 'hiburan'],
	['vidio', 'hiburan'],
	['viu', 'hiburan'],
	['bioskop', 'hiburan'],
	['cinema', 'hiburan'],
	['xxi', 'hiburan'],
	['cgv', 'hiburan'],
	['cinepolis', 'hiburan'],
	['steam', 'hiburan'],
	['playstation', 'hiburan'],
	// Telco, internet and bills.
	['pulsa', 'tagihan'],
	['paket data', 'tagihan'],
	['telkomsel', 'tagihan'],
	['indosat', 'tagihan'],
	['smartfren', 'tagihan'],
	['xl axiata', 'tagihan'],
	['indihome', 'tagihan'],
	['biznet', 'tagihan'],
	['first media', 'tagihan'],
	['pln', 'tagihan'],
	['listrik', 'tagihan'],
	['token listrik', 'tagihan'],
	['pdam', 'tagihan'],
	['air minum', 'tagihan'],
	['pbb', 'tagihan'],
	['asuransi', 'tagihan'],
	['cicilan', 'tagihan'],
	// Health.
	['bpjs', 'kesehatan'],
	['apotek', 'kesehatan'],
	['apotik', 'kesehatan'],
	['kimia farma', 'kesehatan'],
	['guardian', 'kesehatan'],
	['watsons', 'kesehatan'],
	['halodoc', 'kesehatan'],
	['klinik', 'kesehatan'],
	['rumah sakit', 'kesehatan'],
	['dokter', 'kesehatan'],
	['lab', 'kesehatan'],
	// Education.
	['spp', 'pendidikan'],
	['sekolah', 'pendidikan'],
	['kursus', 'pendidikan'],
	['les', 'pendidikan'],
	['universitas', 'pendidikan'],
	['kampus', 'pendidikan'],
	['udemy', 'pendidikan'],
	['coursera', 'pendidikan'],
	// Housing.
	['kos', 'tempat-tinggal'],
	['kost', 'tempat-tinggal'],
	['sewa', 'tempat-tinggal'],
	['apartemen', 'tempat-tinggal'],
	['ipl', 'tempat-tinggal'],
	['kontrakan', 'tempat-tinggal']
];

/** The kind a tile answers for: the kind of its preset (Kopi is expense, Gaji income). */
const TILE_KIND: ReadonlyMap<TileKey, CategoryKind> = new Map(
	PRESET_CATEGORIES.map((p) => [p.tileKey, p.kind])
);
export const tileKind = (tile: TileKey): CategoryKind => TILE_KIND.get(tile) ?? 'expense';

const DICTIONARY: readonly { words: readonly string[]; tile: TileKey; kind: CategoryKind }[] =
	ENTRIES.map(([pattern, tile]) => ({
		words: pattern.split(' '),
		tile,
		kind: tileKind(tile)
	}));

/** How many dictionary patterns there are (the PRD caps the table at about 150). */
export const DICTIONARY_SIZE = DICTIONARY.length;

function containsRun(tokens: readonly string[], words: readonly string[]): boolean {
	outer: for (let i = 0; i + words.length <= tokens.length; i++) {
		for (let j = 0; j < words.length; j++) if (tokens[i + j] !== words[j]) continue outer;
		return true;
	}
	return false;
}

export type WordLayer = 'dictionary' | 'keyword';

/**
 * The tile `tokens` (lower-case words) name for a row of `kind`: the dictionary first, then the keyword groups.
 * A tile of the other kind is never returned.
 */
export function tileFromWords(
	tokens: readonly string[],
	kind: CategoryKind
): { tile: TileKey; layer: WordLayer } | undefined {
	for (const entry of DICTIONARY) {
		if (entry.kind === kind && containsRun(tokens, entry.words))
			return { tile: entry.tile, layer: 'dictionary' };
	}
	const keyword = keywordLookup(tokens, KEYWORD_GROUPS);
	if (keyword !== undefined && tileKind(keyword) === kind)
		return { tile: keyword, layer: 'keyword' };
	return undefined;
}
