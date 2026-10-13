/**
 * Browser-side install state (FN-13). The root layout starts listening on mount, because Chrome fires
 * `beforeinstallprompt` once, early, on whatever page was opened; the install guide reads it later.
 */

/** Chrome/Edge's install prompt event (not in the DOM typings). */
interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** The captured prompt (null until the browser offers one, and again once it has been used). */
export const installPrompt = $state<{ event: BeforeInstallPromptEvent | null; installed: boolean }>(
	{
		event: null,
		installed: false
	}
);

/** Starts capturing `beforeinstallprompt` and `appinstalled`; returns the cleanup. Browser only. */
export function captureInstallPrompt(): () => void {
	const onPrompt = (event: Event) => {
		// Keep the browser's own mini-infobar from showing; the guide offers the button instead.
		event.preventDefault();
		installPrompt.event = event as BeforeInstallPromptEvent;
	};
	const onInstalled = () => {
		installPrompt.event = null;
		installPrompt.installed = true;
	};
	addEventListener('beforeinstallprompt', onPrompt);
	addEventListener('appinstalled', onInstalled);
	return () => {
		removeEventListener('beforeinstallprompt', onPrompt);
		removeEventListener('appinstalled', onInstalled);
	};
}

/**
 * Shows the browser's install dialog and waits for the person's answer; the captured event is cleared only
 * after that (a prompt can be used once), so the button stays until the browser's own dialog has resolved.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
	const event = installPrompt.event;
	if (!event) return null;
	await event.prompt();
	const { outcome } = await event.userChoice;
	installPrompt.event = null;
	if (outcome === 'accepted') installPrompt.installed = true;
	return outcome;
}

/** True when the app runs from the home screen / as an installed app. Browser only. */
export function isStandalone(): boolean {
	return (
		matchMedia('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

/** localStorage key (FN-13b): `1` once the iOS install hint was closed or its steps were opened. */
export const INSTALL_HINT_DISMISSED = 'montra-install-hint-dismissed';
