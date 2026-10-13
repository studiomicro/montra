import { msg } from '../../i18n.ts';
import type { ScreenParser } from './common.ts';

/**
 * Mobile-banking mutation lists (FN-16g): BCA, Mandiri (Livin'), BRI (BRImo), BNI and a generic "Mutasi" list
 * of any other bank. Identified only by the app's own words in the screen's header lines; the generic reader
 * claims a mutation-list header when no named app does. Rows are read by the shared list reader in common.ts
 * (date, description, amount with DB/CR, D/K or +/−, running saldo when shown).
 *
 * UNVERIFIED AGAINST REAL SCREENSHOTS: tested with fictional fixtures only, until the owner's redacted samples
 * have been run through `npm run compat:ocr`.
 */

const bank = (id: string, label: string, name: RegExp): ScreenParser => ({
	id,
	label,
	family: 'mobile_banking',
	claims: (header) => name.test(header)
});

const NAMED: readonly ScreenParser[] = [
	bank('m-bca', 'BCA mobile', /\b(?:m-BCA|myBCA|BCA)\b/),
	bank('m-mandiri', "Livin' by Mandiri", /\blivin'?\b|\bmandiri\b/i),
	bank('m-bri', 'BRImo', /\bBRImo\b|\bBRI\b/),
	bank('m-bni', 'BNI Mobile', /\bBNI\b|\bwondr\b/i)
];

const MUTATION_HEADER = /\bmutasi\b/i;

export const MOBILE_BANKING_PARSERS: readonly ScreenParser[] = [
	...NAMED,
	{
		id: 'm-mutasi',
		label: msg('Mutasi rekening bank lain'),
		family: 'mobile_banking',
		claims: (header) => MUTATION_HEADER.test(header) && !NAMED.some((p) => p.claims(header))
	}
];
