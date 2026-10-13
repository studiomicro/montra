import { z } from 'zod';
import { DRAFT_BATCH_MAX } from '#lib/shared/drafts';

/** One selected draft as the page loaded it: its id and the `updated_at` the write must still find. */
export interface DraftRef {
	id: string;
	updatedAt: number;
}

/** Name of the checkbox field that carries the selection (`<id>:<updated_at>` tokens, `draftToken`). */
export const SELECTION_FIELD = 'd';
/** Most tokens read from one body before any work (the 8 KiB body cap already bounds it). */
const TOKENS_READ_MAX = 200;

const token = z
	.string()
	.regex(/^[A-Za-z0-9-]{1,64}:\d{1,15}$/)
	.transform((value): DraftRef => {
		const at = value.lastIndexOf(':');
		return { id: value.slice(0, at), updatedAt: Number(value.slice(at + 1)) };
	});

/**
 * The selection a bulk action was sent: well-formed tokens only (anything else is ignored, like an id that is not
 * there), de-duplicated by draft id (the first token wins, so one draft is processed at most once), and cut to the
 * first DRAFT_BATCH_MAX. `remaining` counts the distinct drafts left for a further submission.
 */
export function parseSelection(form: FormData): { items: DraftRef[]; remaining: number } {
	const seen = new Map<string, DraftRef>();
	for (const value of form.getAll(SELECTION_FIELD).slice(0, TOKENS_READ_MAX)) {
		const parsed = token.safeParse(value);
		if (parsed.success && !seen.has(parsed.data.id)) seen.set(parsed.data.id, parsed.data);
	}
	const all = [...seen.values()];
	return {
		items: all.slice(0, DRAFT_BATCH_MAX),
		remaining: Math.max(0, all.length - DRAFT_BATCH_MAX)
	};
}
