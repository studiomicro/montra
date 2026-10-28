import type { InboundParser } from './address.ts';

/**
 * FN-19b: the registry of REAL sender domains of bank and e-wallet notification mail (docs/features/
 * fn-19b-gmail-followups/PRD.md § D). A domain enters this list only when the owner confirmed it: from a redacted
 * real sample in `.superpowers/ref/samples/` whose `From:` and `Authentication-Results` show it (`owner-sample`),
 * or a domain the owner stated in writing (`owner-statement`). No domain is invented or guessed here. Until the
 * owner's samples arrive the list is EMPTY, so Gmail auto-save (which requires a confirmed domain) never fires.
 *
 * The fictional `*.example` domains of the test fixtures live on the parsers (`MAIL_PARSERS[].domains`) and are
 * listed below as `fixture: true`: a parser still reads them (tests, local review), but they never count as
 * confirmed, in any build.
 */

export interface SenderDomain {
	/** Lower-case registrable host, matched exactly against the sender address's domain (no subdomain match). */
	domain: string;
	/** Display name of the institution (shown nowhere in mail-derived text; for the compat report). */
	institution: string;
	parserId: Exclude<InboundParser, 'ai'>;
	confirmedBy: 'owner-sample' | 'owner-statement';
	/** WIB date `YYYY-MM-DD` the owner confirmed it. */
	confirmedOn: string;
}

/** Confirmed real sender domains. Empty until the owner's samples arrive (owner answers 2026-10-28). */
export const SENDER_DOMAINS: readonly SenderDomain[] = [];

/** Most entries the registry may hold, and the longest domain one may name (the Gmail query must stay short). */
export const SENDER_DOMAINS_MAX = 30;
export const SENDER_DOMAIN_MAX_LENGTH = 40;

/** Endings that can never be a real sender (RFC 2606/6761 reserved names). */
export const RESERVED_SUFFIXES = ['.example', '.test', '.invalid', '.localhost'] as const;

/** A lower-case host of at least two labels, letters, digits and hyphens only, no leading/trailing hyphen. */
const HOST = /^(?=.{4,40}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Whether `domain` is a well-formed, non-reserved, lower-case host of at most SENDER_DOMAIN_MAX_LENGTH characters
 * a registry entry may carry.
 */
export function isRegistrableHost(domain: string): boolean {
	return HOST.test(domain) && !RESERVED_SUFFIXES.some((s) => domain.endsWith(s));
}

/**
 * The confirmed entry for `domain` (exact match), or null. `registry` defaults to SENDER_DOMAINS; the jobs
 * Worker passes it through its deps so a test can name a confirmed domain without the shipped list carrying one.
 */
export function confirmedSender(
	domain: string | null,
	registry: readonly SenderDomain[] = SENDER_DOMAINS
): SenderDomain | null {
	if (!domain) return null;
	const d = domain.toLowerCase();
	return registry.find((e) => e.domain === d) ?? null;
}
