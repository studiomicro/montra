/**
 * FN-44 Part 3: when Koko reacts to a success. Each reads only what the server sent back after the write — an
 * action result or the one-shot notice behind the redirect's `?saved=` (FN-44 L1) — never a pending form, an
 * optimistic row or the offline queue.
 */

type ActionResult = Record<string, unknown> | null | undefined;

const savedOf = (form: ActionResult) =>
	form && typeof form === 'object' && 'saved' in form ? form.saved : undefined;

/** Riwayat after the redirect of a new transaction (`/riwayat?saved=created`): Koko hops. */
export const transactionSavedHop = (saved: string | null | undefined): boolean =>
	saved === 'created';

/** Beranda right after `?/closeDay` answered; a plain load of an already closed day does not celebrate. */
export const dayClosedCelebrates = (form: ActionResult): boolean => savedOf(form) === 'closed';

/**
 * Anggaran right after the monthly budget was saved, and only while the recomputed safe-to-spend is positive:
 * Koko never celebrates a budget that is spent or over.
 */
export const budgetSafeCelebrates = (
	form: ActionResult,
	safe: { kind: 'left' | 'spent' | 'over' } | null | undefined
): boolean => savedOf(form) === 'set' && safe?.kind === 'left';
