/**
 * Whether the Fitur sheet (APP_PARITY § 3) is open: one sheet in the app layout, opened from the sidebar's
 * "Jelajahi fitur" and Beranda's link to it. Component state only; the flags themselves live in D1 (FN-12).
 */
export const fiturSheet = $state({ open: false });

/** A click on a "Jelajahi fitur" link with JavaScript: opens the sheet instead of /pengaturan/fitur. */
export function openFiturSheet(event: MouseEvent): void {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey
	)
		return;
	event.preventDefault();
	fiturSheet.open = true;
}
