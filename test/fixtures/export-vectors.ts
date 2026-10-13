/**
 * Export vectors shared by FN-18's CSV export test (test/integration/impor.test.ts) and FN-29's Sheets rows test
 * (src/lib/shared/connected-apps/sheets-export.test.ts), so both exports are proven against the same inputs.
 */

/** Text cells a spreadsheet could read as a formula (the first four) or that need CSV quoting (the last two). */
export const FORMULA_VECTORS = [
	'=1+1',
	'+SUM(A1)',
	'-2',
	'@cmd',
	'Toko, Serba Ada',
	'Kata "kutip"'
];

/** Account and card numbers as typed into an import, and what export shows of them. */
export const MASKING_VECTORS = {
	paymentMethod: {
		input: 'Kartu 4111 1111 1111 1234',
		masked: 'Kartu \u2022\u2022\u2022\u20221234'
	},
	walletName: { input: 'BCA 0123456789', masked: 'BCA \u2022\u2022\u2022\u20226789' },
	reference: { input: '1234567890123456', masked: '\u2022\u2022\u2022\u20223456' },
	/** A value stored by any other path is masked on the way out too. */
	storedReference: { input: 'VA 8808123456789012', masked: 'VA \u2022\u2022\u2022\u20229012' }
} as const;
