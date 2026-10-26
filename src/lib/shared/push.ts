import { cleanText } from './text.ts';

/** What a push message carries (JSON, encrypted): plain title and body, and the in-app path a tap opens. */
export interface PushPayload {
	title: string;
	body: string;
	/** A same-origin path (`/riwayat`); anything else opens `/`. */
	url?: string;
}

const PUSH_TITLE_MAX = 80;
const PUSH_BODY_MAX = 240;

/** A same-origin absolute path: starts with one `/`, no backslash, no scheme-relative `//`. */
const SAME_ORIGIN_PATH = /^\/(?![/\\])[^\\\s]*$/;

/**
 * The notification the service worker shows for a decrypted push message, or null when the text is not a
 * payload of ours. Shared: the sender builds `PushPayload`, the service worker reads it with this.
 */
export function parsePushPayload(text: string): Required<PushPayload> | null {
	let value: unknown;
	try {
		value = JSON.parse(text.slice(0, 4096));
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const { title, body, url } = value as Record<string, unknown>;
	if (typeof title !== 'string' || typeof body !== 'string') return null;
	const cleanTitle = cleanText(title, PUSH_TITLE_MAX);
	if (!cleanTitle) return null;
	return {
		title: cleanTitle,
		body: cleanText(body, PUSH_BODY_MAX),
		url: typeof url === 'string' && SAME_ORIGIN_PATH.test(url) ? url : '/'
	};
}

/** `https://` + authority + the rest (path and query), no fragment, no whitespace. */
const ENDPOINT_PARTS = /^https:\/\/([^/?#\s]+)([^#\s]*)$/i;

/**
 * The one stored and compared form of a push endpoint (FN-13): scheme and host lower-cased, the default port
 * and a trailing host dot dropped; path and query kept byte for byte (they are the push service's capability
 * token). Null for anything that is not a plain https URL on the default port without credentials or fragment.
 * Shared: the server stores this form, the page hashes its own endpoint in it.
 */
export function normalizePushEndpoint(raw: string): string | null {
	const parts = ENDPOINT_PARTS.exec(raw);
	if (!parts) return null;
	const authority = parts[1] as string;
	const rest = parts[2] as string;
	if (authority.includes('@')) return null;
	let url: URL;
	try {
		url = new URL(`https://${authority}/`);
	} catch {
		return null;
	}
	// URL already drops :443 for https; any other port is refused.
	if (url.port !== '') return null;
	const host = url.hostname.replace(/\.$/, '');
	if (!host) return null;
	const path = rest === '' ? '/' : rest.startsWith('?') ? `/${rest}` : rest;
	return `https://${host}${path}`;
}
