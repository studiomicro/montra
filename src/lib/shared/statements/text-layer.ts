/**
 * Whether a PDF page has a text layer or is a scan (FN-16a), shared by the server's text-PDF reader and the
 * on-device OCR (FN-16g), which reads only pages without one: the same rule on both sides.
 */

/** A page "has text" when it holds at least this many words of 2+ letters or digits (else: scanned). */
const MIN_WORDS_PER_PAGE = 3;

/** True when the page text holds enough real words to be a text layer, not a scan. */
export function hasReadableText(page: string): boolean {
	const words = /[\p{L}\p{Nd}]{2,}/gu;
	for (let n = 0; n < MIN_WORDS_PER_PAGE; n++) if (!words.exec(page)) return false;
	return true;
}
