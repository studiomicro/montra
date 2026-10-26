import { isSealKeyWellFormed } from '../server-seal.ts';
import type { GmailKeyEnv } from './crypto.ts';

/**
 * FN-19 Gmail configuration (PRD § 1). The feature works only when every required value is present and well
 * formed: the OAuth client id and secret (app and jobs Workers), the sealing key (CONNECTED_APPS_ENCRYPTION_KEY,
 * app and jobs) and, on the app Worker, the redirect origin. Otherwise the settings page is "Belum dikonfigurasi"
 * and names the missing group in words, never a secret's name or value.
 */
export interface GmailClientEnv extends GmailKeyEnv {
	GOOGLE_OAUTH_CLIENT_ID?: string;
	GOOGLE_OAUTH_CLIENT_SECRET?: string;
}

export interface GmailAppEnv extends GmailClientEnv {
	GOOGLE_OAUTH_REDIRECT_ORIGIN?: string;
	/** `0` hides the 7-day Testing notice (only once Google published the app to production). */
	GOOGLE_OAUTH_TESTING?: string;
}

/** The fixed path of the OAuth callback; the redirect URI is the configured origin plus this, nothing else. */
const GMAIL_CALLBACK_PATH = '/pengaturan/aplikasi/gmail/callback';

const CLIENT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const CLIENT_SECRET = /^[\x21-\x7e]{1,200}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The configured redirect origin, or null when unset or not exactly one origin: `https://<host>[:port]`, or
 * `http://` only for `localhost`/`127.0.0.1`; no path, trailing slash, query, fragment, userinfo, wildcard or raw
 * IP address other than 127.0.0.1 (Google refuses those as redirect URIs).
 */
export function redirectOrigin(value: string | undefined): string | null {
	const text = (value ?? '').trim();
	if (text === '' || text.length > 200) return null;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.origin !== text || url.username !== '' || url.password !== '') return null;
	if (!HOST.test(url.hostname)) return null;
	const local = LOCAL_HOSTS.has(url.hostname);
	if (IPV4.test(url.hostname) && !local) return null;
	if (url.protocol === 'https:') return url.origin;
	return url.protocol === 'http:' && local ? url.origin : null;
}

/** What is missing, as words the page shows (never a secret's name or value). */
export type GmailMissing = 'client' | 'redirect' | 'key';

/** The OAuth client of the jobs Worker (refreshing tokens), or null when unset or malformed. */
export function gmailClient(env: GmailClientEnv | undefined): {
	clientId: string;
	clientSecret: string;
} | null {
	const clientId = env?.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? '';
	const clientSecret = env?.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? '';
	return CLIENT_ID.test(clientId) && CLIENT_SECRET.test(clientSecret)
		? { clientId, clientSecret }
		: null;
}

/** Every missing group of the app Worker ([] when Gmail can be connected). */
export function gmailMissing(env: GmailAppEnv | undefined): GmailMissing[] {
	const missing: GmailMissing[] = [];
	if (!gmailClient(env)) missing.push('client');
	if (!redirectOrigin(env?.GOOGLE_OAUTH_REDIRECT_ORIGIN)) missing.push('redirect');
	if (!isSealKeyWellFormed(env?.CONNECTED_APPS_ENCRYPTION_KEY)) missing.push('key');
	return missing;
}

export const isGmailConfigured = (env: GmailAppEnv | undefined) => gmailMissing(env).length === 0;

/** The jobs Worker can check mail: the client and the sealing key are present. */
export const isGmailJobConfigured = (env: GmailClientEnv | undefined) =>
	gmailClient(env) !== null && isSealKeyWellFormed(env?.CONNECTED_APPS_ENCRYPTION_KEY);

export interface GmailOAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectOrigin: string;
	redirectUri: string;
}

/** Everything the connect flow needs, or null when anything is missing. */
export function gmailOAuthConfig(env: GmailAppEnv | undefined): GmailOAuthConfig | null {
	const client = gmailClient(env);
	const origin = redirectOrigin(env?.GOOGLE_OAUTH_REDIRECT_ORIGIN);
	if (!client || !origin || !isSealKeyWellFormed(env?.CONNECTED_APPS_ENCRYPTION_KEY)) return null;
	return { ...client, redirectOrigin: origin, redirectUri: `${origin}${GMAIL_CALLBACK_PATH}` };
}

/** While the Google app is in Testing (the default), connections lapse after 7 days and the page says so. */
export const gmailTesting = (env: GmailAppEnv | undefined) =>
	env?.GOOGLE_OAUTH_TESTING?.trim() !== '0';
