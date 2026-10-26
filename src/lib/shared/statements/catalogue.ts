import { brandById } from '../brands.ts';

/**
 * What the Impor statement picker says about a bank or e-wallet it cannot read yet (FN-16i): the real way in
 * today. `brimo_screenshot`: a BRImo screenshot (Foto) or CSV/Spreadsheet; `app_screenshot`: a screenshot of the
 * app (Foto); `csv_or_sheet`: not read yet, use CSV or Spreadsheet.
 */
export type StatementAlternative =
	| 'brimo_screenshot'
	| 'app_screenshot'
	| 'csv_or_sheet'
	/** FN-55b: a card issuer whose parser waits for the owner's real sample: Spreadsheet/CSV or manual entry. */
	| 'card_waiting';

/** One row of the statement picker: selectable when a parser reads it, else disabled with its alternative. */
export type CatalogueRow =
	| { id: string; label: string; brand: string | null; supported: true }
	| {
			id: string;
			label: string;
			brand: string | null;
			supported: false;
			alternative: StatementAlternative;
	  };

/**
 * Every institution named on the Impor picker (CLAUDE.md FN-04 list), in that order. Which rows are readable is
 * never written here: `statementCatalogue` takes it from the parser list, so the two cannot drift.
 * `other` is "Lainnya" (its label is translated on the page).
 */
interface Institution {
	id: string;
	label: string;
	alternative: StatementAlternative;
}

const INSTITUTIONS: readonly Institution[] = [
	{ id: 'bca', label: 'BCA', alternative: 'csv_or_sheet' },
	{ id: 'mandiri', label: 'Mandiri', alternative: 'csv_or_sheet' },
	{ id: 'bri', label: 'BRI', alternative: 'brimo_screenshot' },
	{ id: 'bni', label: 'BNI', alternative: 'csv_or_sheet' },
	{ id: 'ocbc', label: 'OCBC', alternative: 'csv_or_sheet' },
	{ id: 'jago', label: 'Bank Jago', alternative: 'csv_or_sheet' },
	{ id: 'bsi', label: 'BSI', alternative: 'csv_or_sheet' },
	{ id: 'cimb', label: 'CIMB Niaga', alternative: 'csv_or_sheet' },
	{ id: 'permata', label: 'Permata', alternative: 'csv_or_sheet' },
	{ id: 'jenius', label: 'Jenius', alternative: 'csv_or_sheet' },
	{ id: 'seabank', label: 'SeaBank', alternative: 'csv_or_sheet' },
	{ id: 'gopay', label: 'GoPay', alternative: 'app_screenshot' },
	{ id: 'ovo', label: 'OVO', alternative: 'app_screenshot' },
	{ id: 'dana', label: 'DANA', alternative: 'app_screenshot' },
	{ id: 'shopeepay', label: 'ShopeePay', alternative: 'app_screenshot' },
	{ id: 'other', label: 'Lainnya', alternative: 'csv_or_sheet' }
];

/**
 * FN-55b: the card issuers the owner holds a card from (owner decision 2026-10-13), each with its own card parser
 * id. A card parser is written only from that issuer's real sample (FN-55c); until then the issuer is "waiting for
 * sample" and never selectable. Labels are the issuers' own names, not translated.
 */
export const CARD_INSTITUTIONS: readonly Institution[] = [
	{ id: 'bca-card', label: 'BCA Kartu Kredit', alternative: 'card_waiting' },
	{ id: 'mandiri-card', label: 'Mandiri Kartu Kredit', alternative: 'card_waiting' },
	{ id: 'bri-card', label: 'BRI Kartu Kredit', alternative: 'card_waiting' },
	{ id: 'bni-card', label: 'BNI Kartu Kredit', alternative: 'card_waiting' },
	{ id: 'cimb-card', label: 'CIMB Niaga Kartu Kredit', alternative: 'card_waiting' },
	{ id: 'ocbc-card', label: 'OCBC Kartu Kredit', alternative: 'card_waiting' }
];

/**
 * The statement picker's rows (`institutions`: the bank list, or CARD_INSTITUTIONS for a card wallet): every parser first (selectable, in the catalogue's order, a parser the catalogue
 * does not name yet at the end of them), then every other institution disabled with its alternative.
 */
export function statementCatalogue(
	parsers: readonly { id: string; label: string }[],
	institutions: readonly Institution[] = INSTITUTIONS
): CatalogueRow[] {
	const known = new Set(institutions.map((i) => i.id));
	const readable = new Map(parsers.map((p) => [p.id, p.label]));
	// A card issuer (`bca-card`) shows its bank's mark.
	const brand = (id: string) => brandById(id.replace(/-card$/, ''))?.id ?? null;
	const supported: CatalogueRow[] = [
		...institutions
			.filter((i) => readable.has(i.id))
			.map((i) => ({
				id: i.id,
				label: readable.get(i.id) ?? i.label,
				brand: brand(i.id),
				supported: true as const
			})),
		...parsers
			.filter((p) => !known.has(p.id))
			.map((p) => ({ id: p.id, label: p.label, brand: brand(p.id), supported: true as const }))
	];
	const unsupported: CatalogueRow[] = institutions
		.filter((i) => !readable.has(i.id))
		.map((i) => ({
			id: i.id,
			label: i.label,
			brand: brand(i.id),
			supported: false as const,
			alternative: i.alternative
		}));
	return [...supported, ...unsupported];
}
