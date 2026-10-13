import { cleanText, maskAccountNumbers } from '../text.ts';
import type { StatementSection } from './types.ts';

/**
 * Multi-account statements (FN-16e), shared by the text-statement reader (server) and the on-device OCR reading
 * (FN-16g): the picker's view of each account and the choice of the one to import.
 */

/** One account of a multi-account statement as the picker shows it (counts and labels only). */
export interface StatementSectionChoice {
	/** Position in the file: the value the picker sends back. */
	index: number;
	label: string;
	accountLast4: string | null;
	/** Readable transaction rows. */
	rows: number;
	importable: boolean;
}

/** Longest product name shown for an account. */
const SECTION_LABEL_MAX_LENGTH = 60;

export const choiceOf = (section: StatementSection, index: number): StatementSectionChoice => ({
	index,
	// Bank text: invisible characters out, bounded, any digit run masked before it reaches a page.
	label: maskAccountNumbers(cleanText(section.label, SECTION_LABEL_MAX_LENGTH)),
	accountLast4: section.accountLast4,
	rows: section.parse.rows.filter((r) => r.ok).length,
	importable: section.refusal === null && section.parse.rows.some((r) => r.ok)
});

/**
 * The account to import from a statement with sections: the picked one, or the only one. Several accounts and
 * no pick ask the user, never guess; a section that is not an IDR savings/current account or fails its own
 * checks is refused whole.
 */
export function pickSection(
	sections: readonly StatementSection[],
	picked: number | null
):
	| { ok: true; section: StatementSection; index: number }
	| {
			ok: false;
			error: 'section_required' | 'section_unknown' | 'inconsistent' | 'section_unsupported';
	  } {
	const index = picked ?? (sections.length === 1 ? 0 : null);
	if (index === null) return { ok: false, error: 'section_required' };
	const section = sections[index];
	if (!section) return { ok: false, error: 'section_unknown' };
	if (section.refusal === 'inconsistent') return { ok: false, error: 'inconsistent' };
	if (section.refusal !== null) return { ok: false, error: 'section_unsupported' };
	return { ok: true, section, index };
}
