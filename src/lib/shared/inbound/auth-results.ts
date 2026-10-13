import type { InboundTrust } from './address.ts';

/**
 * Sender authenticity of a forwarded mail (FN-19 PRD § 5), failing closed.
 *
 * Cloudflare Email Routing checks SPF, DKIM and DMARC of the connecting sender before a Worker runs. Its official
 * docs (developers.cloudflare.com › Email Routing › Postmaster, › Email Workers runtime API, read 2026-10-10)
 * say that it checks, but not the exact `Authentication-Results` header it adds or its authserv-id, so the
 * shape is NOT verified against a real mail. Hence:
 * - only the topmost `Authentication-Results` header is read (a receiving server prepends its own; any copy
 *   below it may be the sender's), and only when its authserv-id equals `INBOUND_AUTHSERV_ID`, which the owner
 *   sets after reading a real mail's header (docs/RUNBOOK.md › E-mail forwarding). Unset → every mail is
 *   `unverified`;
 * - the header is parsed per RFC 8601 (`authserv-id [version]; method=result [ptype.property=value …]; …`),
 *   comments dropped; anything that does not parse is treated as absent.
 * Whatever this returns, a mail only ever becomes a draft for review, never a transaction: `verified` only drops
 * the review flag.
 */

/** One parsed header (lower-case name, raw value) in the order it appears in the mail, topmost first. */
export interface MailHeader {
	key: string;
	value: string;
}

export interface AuthResults {
	authservId: string;
	dmarc: string | null;
	/** `header.from` of the DMARC result, lower-cased (when given). */
	dmarcFrom: string | null;
	/** `header.d` of every DKIM signature that passed, lower-cased. */
	dkimPass: string[];
}

/** Longest header value parsed; a real Authentication-Results header is a few hundred bytes. */
const MAX_HEADER = 4096;

/** `value` without RFC 5322 comments (nested parentheses; quoted strings kept). */
function stripComments(value: string): string {
	let out = '';
	let depth = 0;
	let quoted = false;
	for (let i = 0; i < value.length; i++) {
		const c = value[i] as string;
		if (c === '\\' && i + 1 < value.length) {
			if (depth === 0) out += c + value[i + 1];
			i++;
			continue;
		}
		if (depth === 0 && c === '"') quoted = !quoted;
		if (!quoted && c === '(') depth++;
		else if (!quoted && c === ')' && depth > 0) depth--;
		else if (depth === 0) out += c;
	}
	return out;
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** The domain of a `header.d` / `header.from` / `header.i` value (`@sub.example.com` → `sub.example.com`). */
function domainOf(value: string): string | null {
	const v = value.replace(/^"|"$/g, '').trim().toLowerCase();
	const d = v.includes('@') ? v.slice(v.lastIndexOf('@') + 1) : v;
	return DOMAIN.test(d) ? d : null;
}

/** One Authentication-Results value parsed, or null when it is not one. */
export function parseAuthResults(value: string): AuthResults | null {
	if (value.length > MAX_HEADER) return null;
	const parts = stripComments(value.replace(/\r?\n[ \t]*/g, ' '))
		.split(';')
		.map((p) => p.trim());
	const head = (parts[0] ?? '').split(/\s+/)[0]?.toLowerCase() ?? '';
	if (!/^[a-z0-9.-]{1,253}$/.test(head)) return null;
	const result: AuthResults = { authservId: head, dmarc: null, dmarcFrom: null, dkimPass: [] };
	for (const part of parts.slice(1)) {
		const m = /^(dkim|dmarc|spf|arc)\s*=\s*([a-z]+)\b(.*)$/i.exec(part);
		if (!m) continue;
		const method = (m[1] as string).toLowerCase();
		const outcome = (m[2] as string).toLowerCase();
		const props = new Map<string, string>();
		for (const p of (m[3] as string).matchAll(/([a-z]+\.[a-z-]+)\s*=\s*("[^"]*"|[^\s;]+)/gi))
			props.set((p[1] as string).toLowerCase(), p[2] as string);
		if (method === 'dmarc' && result.dmarc === null) {
			result.dmarc = outcome;
			const from = props.get('header.from');
			result.dmarcFrom = from ? domainOf(from) : null;
		}
		if (method === 'dkim' && outcome === 'pass') {
			const d = props.get('header.d') ?? props.get('header.i');
			const domain = d ? domainOf(d) : null;
			if (domain) result.dkimPass.push(domain);
		}
	}
	return result;
}

/** The topmost Authentication-Results header, parsed, when it is the one `authservId` names; else null. */
export function trustedAuthResults(
	headers: readonly MailHeader[],
	authservId: string | undefined | null
): AuthResults | null {
	const wanted = (authservId ?? '').trim().toLowerCase();
	if (!wanted) return null;
	const top = headers.find((h) => h.key === 'authentication-results');
	if (!top) return null;
	const parsed = parseAuthResults(top.value);
	return parsed && parsed.authservId === wanted ? parsed : null;
}

/** `d` is the From domain or a parent of it (DMARC relaxed alignment, without the public-suffix lookup). */
function aligned(d: string, fromDomain: string): boolean {
	return d.includes('.') && (fromDomain === d || fromDomain.endsWith(`.${d}`));
}

/**
 * The From address's own domain authenticated it: DMARC pass for that domain and a passing DKIM signature aligned
 * with it, per the trusted header. Also gates the Gmail forwarding confirmation code (red team L1).
 */
export function authenticatedFrom(auth: AuthResults | null, fromAddress: string): boolean {
	const fromDomain = domainOf(fromAddress.trim().toLowerCase());
	if (!auth || !fromDomain || auth.dmarc !== 'pass') return false;
	if (auth.dmarcFrom !== null && auth.dmarcFrom !== fromDomain) return false;
	return auth.dkimPass.some((d) => aligned(d, fromDomain));
}

/**
 * - `verified`: DMARC pass for the From domain, a passing DKIM signature aligned with it, and the domain on the
 *   sender allowlist (an auto-forward that kept the bank's signature);
 * - `forwarded`: the From address is the owner's own (a manual forward) and DMARC passed for it;
 * - `unverified`: anything else, including every mail when the header cannot be trusted.
 */
export function mailTrust(input: {
	auth: AuthResults | null;
	fromAddress: string;
	ownerEmail: string;
	allowlisted: (domain: string) => boolean;
}): InboundTrust {
	const { auth } = input;
	const from = input.fromAddress.trim().toLowerCase();
	const fromDomain = domainOf(from);
	if (!auth || !fromDomain || auth.dmarc !== 'pass') return 'unverified';
	if (auth.dmarcFrom !== null && auth.dmarcFrom !== fromDomain) return 'unverified';
	if (from === input.ownerEmail.trim().toLowerCase()) return 'forwarded';
	if (authenticatedFrom(auth, from) && input.allowlisted(fromDomain)) return 'verified';
	return 'unverified';
}
