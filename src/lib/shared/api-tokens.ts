import { msg } from './i18n.ts';

/**
 * FN-38 public API tokens: the values the settings page, the server and the OpenAPI document share. Owner
 * decisions 2026-10-08 (PRD defaults accepted): scopes `read` / `read_write`, an expiry of 30, 90 (default) or
 * 365 days and never "no expiry", at most 10 live tokens per user, 300 requests per token per 10-minute window.
 */
export const API_TOKEN_SCOPES = ['read', 'read_write'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const API_TOKEN_LIFETIME_DAYS = [30, 90, 365] as const;
export type ApiTokenLifetime = (typeof API_TOKEN_LIFETIME_DAYS)[number];
export const API_TOKEN_DEFAULT_LIFETIME_DAYS: ApiTokenLifetime = 90;

/** Most live (neither revoked nor expired) tokens one user holds. */
export const API_TOKEN_MAX_PER_USER = 10;
/** Longest token name (a label the user gives it). */
export const API_TOKEN_NAME_MAX_LENGTH = 60;
/** Requests one token may make per throttle window (THROTTLE_WINDOW_MS, 10 minutes). */
export const API_REQUESTS_PER_WINDOW = 300;

/**
 * Every raw token starts with this, so secret scanners and people can tell a MONTRA token from other strings.
 * The rest is 32 random bytes, base64url (43 characters).
 */
export const API_TOKEN_PREFIX = 'fin_';
/** A raw token as issued: the prefix plus 43 base64url characters. Anything else cannot be one. */
export const API_TOKEN_PATTERN = /^fin_[A-Za-z0-9_-]{43}$/;

export const API_SCOPE_LABELS: Readonly<Record<ApiTokenScope, string>> = {
	read: msg('Hanya baca'),
	read_write: msg('Baca dan tulis')
};

export function isApiTokenScope(value: string): value is ApiTokenScope {
	return (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

export function isApiTokenLifetime(value: number): value is ApiTokenLifetime {
	return (API_TOKEN_LIFETIME_DAYS as readonly number[]).includes(value);
}
