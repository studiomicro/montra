import type { ScreenParser } from './common.ts';

/**
 * E-wallet history lists (FN-16g): GoPay, OVO, DANA and ShopeePay. The wallet is identified only by its own name
 * in the screen's header lines (nominative use of the app's name; no logo, mascot or copy is used). The rows are
 * read by the shared list reader in common.ts.
 *
 * UNVERIFIED AGAINST REAL SCREENSHOTS: tested with fictional fixtures only, until the owner's redacted samples
 * have been run through `npm run compat:ocr`.
 */

const app = (id: string, label: string, name: RegExp): ScreenParser => ({
	id,
	label,
	family: 'ewallet',
	claims: (header) => name.test(header)
});

export const EWALLET_PARSERS: readonly ScreenParser[] = [
	app('gopay', 'GoPay', /\bgopay\b/i),
	// Upper case only: "dana" and "ovo" are also ordinary words or name parts.
	app('ovo', 'OVO', /\bOVO\b/),
	app('dana', 'DANA', /\bDANA\b/),
	app('shopeepay', 'ShopeePay', /\bshopee\s?pay\b/i)
];
