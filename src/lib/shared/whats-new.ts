import { compareVersionsDesc, isVersion } from './versions';

/**
 * The one-time "Baru di Montra" notice (FN-42b). The last version this device has seen lives in localStorage
 * under LAST_SEEN_VERSION_KEY (per device, never on the server). Pure, so the rules are unit-tested.
 */

export const LAST_SEEN_VERSION_KEY = 'montra-last-seen-version';

/**
 * - Nothing (or something unreadable) stored: a first install, cleared storage or a corrupt value. Remember the
 *   running version and show nothing: the notice is never shown on a first install.
 * - The same version: nothing to do.
 * - A newer version: show its note (when it has one) and remember it, so it shows exactly once.
 * - An older version (a rollback): show nothing, remember the running version.
 */
export function decideWhatsNew(input: {
	stored: string | null;
	current: string;
	hasNote: boolean;
}): { show: boolean; store: string | null } {
	const { stored, current, hasNote } = input;
	if (!isVersion(current)) return { show: false, store: null };
	if (!isVersion(stored)) return { show: false, store: current };
	const order = compareVersionsDesc(current, stored);
	if (order === 0) return { show: false, store: null };
	return { show: order < 0 && hasNote, store: current };
}

/** The two pages that already list the notes: landing there counts as seen, and the notice never shows there. */
export function isReleaseNotesPath(pathname: string): boolean {
	const path = pathname.replace(/\/+$/, '');
	return path === '/pengaturan/tentang' || path === '/pengaturan/tentang/catatan-rilis';
}
