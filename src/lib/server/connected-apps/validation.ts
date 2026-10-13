import {
	isConnectedAppProvider,
	type ConnectedAppProvider
} from '#lib/shared/connected-apps/providers';
import { cleanText, maskAccountNumbers } from '#lib/shared/text';
import { textField } from '../forms';

/** Longest `external_label` stored (the table's CHECK allows 1–80). */
export const EXTERNAL_LABEL_MAX_LENGTH = 80;

/** The `provider` form field, or null unless it names one of the five apps. */
export function providerField(form: FormData): ConnectedAppProvider | null {
	const value = textField(form, 'provider');
	return isConnectedAppProvider(value) ? value : null;
}

/**
 * A provider's account or workspace label made safe to store and show: an e-mail address keeps only its domain
 * (never the full address), any account-like number is cut to its last 4 digits, invisible characters go and the
 * text is capped. Null when nothing is left.
 */
export function maskExternalLabel(label: string): string | null {
	const clean = cleanText(label, EXTERNAL_LABEL_MAX_LENGTH * 4);
	const at = clean.lastIndexOf('@');
	const shown = at >= 0 ? clean.slice(at + 1) : clean;
	const masked = cleanText(maskAccountNumbers(shown), EXTERNAL_LABEL_MAX_LENGTH);
	return masked === '' ? null : masked;
}
