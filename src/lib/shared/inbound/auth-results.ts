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

/**
 * The header split into its `;`-separated parts per RFC 8601 / RFC 5322: a `;` separates only outside quoted
 * strings (with backslash escapes) and nested comments. Each part is a list of words (whitespace-separated outside
 * quotes and comments; whitespace around `=` dropped; comments removed; a quoted string kept with its quotes,
 * unescaped inside). `suspicious` is set when a quoted string or a comment carries `;` or text that looks like a
 * result or a property (`dmarc=`, `header.from=` …): a sender-chosen value (an `smtp.mailfrom` local part) trying
 * to pass for a result (red team M2). Null when the quoting or the comment nesting is unbalanced.
 */
function tokenize(value: string): { parts: string[][]; suspicious: boolean } | null {
	const parts: string[][] = [];
	let words: string[] = [];
	let word = '';
	let quoted: string | null = null;
	let comment = '';
	let depth = 0;
	let suspicious = false;
	const looksInjected = (text: string) =>
		/;|\b(?:dkim|dmarc|spf|arc|auth|iprev|dkim-atps)\s*=|\b(?:header|smtp|policy|body)\s*\.\s*[a-z-]+\s*=/i.test(
			text
		);
	const endWord = () => {
		if (word !== '') words.push(word);
		word = '';
	};
	for (let i = 0; i < value.length; i++) {
		const c = value[i] as string;
		if (quoted !== null) {
			if (c === '\\') {
				if (i + 1 >= value.length) return null;
				quoted += value[++i];
			} else if (c === '"') {
				if (looksInjected(quoted)) suspicious = true;
				word += `"${quoted}"`;
				quoted = null;
			} else quoted += c;
			continue;
		}
		if (depth > 0) {
			if (c === '\\') {
				if (i + 1 >= value.length) return null;
				comment += value[++i];
			} else if (c === '(') {
				depth++;
				comment += c;
			} else if (c === ')') {
				depth--;
				if (depth === 0) {
					if (looksInjected(comment)) suspicious = true;
					comment = '';
				} else comment += c;
			} else if (c === '"') {
				// A quote inside a comment is plain text, but one that tries to reach past it is suspicious.
				comment += c;
			} else comment += c;
			continue;
		}
		if (c === '"') quoted = '';
		else if (c === '(') {
			depth = 1;
			endWord();
		} else if (c === ')') return null;
		else if (c === ';') {
			endWord();
			parts.push(words);
			words = [];
		} else if (/\s/.test(c)) {
			// Whitespace around "=" joins: `header.from = x` is one word.
			const rest = /^\s*(.?)/.exec(value.slice(i));
			if (word.endsWith('=') || rest?.[1] === '=') continue;
			endWord();
		} else word += c;
	}
	if (quoted !== null || depth > 0) return null;
	endWord();
	parts.push(words);
	return { parts, suspicious };
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
	return parseStrict(value)?.result ?? null;
}

/** What the strict reading adds: every `dmarc` result seen, and whether anything looked forged or unexpected. */
interface StrictAuth {
	result: AuthResults;
	/** The authserv-id exactly as written (case kept). */
	rawAuthservId: string;
	dmarcResults: string[];
	/**
	 * A quoted string or comment carried result-like text, or a word was neither `method=result` nor
	 * `ptype.property=value` (or the version after the authserv-id), or a property was given twice.
	 */
	unexpected: boolean;
}

/** The domain of a property value: a bare token, or one whole quoted string. */
const propertyDomain = (v: string) =>
	domainOf(v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/** RFC 8601 reading: parts split by the tokenizer, never by a raw `;` (red team M2). */
function parseStrict(value: string): StrictAuth | null {
	if (value.length > MAX_HEADER) return null;
	const tokens = tokenize(value.replace(/\r?\n[ \t]*/g, ' '));
	if (!tokens) return null;
	const [head = [], ...resinfos] = tokens.parts;
	const rawAuthservId = head[0] ?? '';
	const authservId = rawAuthservId.toLowerCase();
	if (!/^[a-z0-9.-]{1,253}$/.test(authservId)) return null;
	let unexpected =
		tokens.suspicious || head.length > 2 || (head.length === 2 && !/^\d+$/.test(head[1] as string));
	const result: AuthResults = { authservId, dmarc: null, dmarcFrom: null, dkimPass: [] };
	const dmarcResults: string[] = [];
	for (const words of resinfos) {
		if (words.length === 0) continue;
		const m = /^([a-z0-9-]+)=([a-z]+)$/i.exec(words[0] as string);
		if (!m) {
			// `none` (no result at all) is a valid resinfo; anything else is not.
			if (!(words.length === 1 && (words[0] as string).toLowerCase() === 'none')) unexpected = true;
			continue;
		}
		const method = (m[1] as string).toLowerCase();
		const outcome = (m[2] as string).toLowerCase();
		const props = new Map<string, string>();
		for (const w of words.slice(1)) {
			const p = /^([a-z0-9-]+(?:\.[a-z0-9-]+)?)=(.+)$/i.exec(w);
			if (!p) {
				unexpected = true;
				continue;
			}
			const key = (p[1] as string).toLowerCase();
			if (props.has(key)) unexpected = true;
			props.set(key, p[2] as string);
		}
		if (method === 'dmarc') {
			dmarcResults.push(outcome);
			if (result.dmarc === null) {
				result.dmarc = outcome;
				const from = props.get('header.from');
				result.dmarcFrom = from ? propertyDomain(from) : null;
			}
		}
		if (method === 'dkim' && outcome === 'pass') {
			const d = props.get('header.d') ?? props.get('header.i');
			const domain = d ? propertyDomain(d) : null;
			if (domain) result.dkimPass.push(domain);
		}
	}
	return { result, rawAuthservId, dmarcResults, unexpected };
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

/** FN-19b: the authserv-id Gmail writes on the `Authentication-Results` header it prepends to received mail. */
export const GMAIL_AUTHSERV_ID = 'mx.google.com';

/**
 * FN-19b (red team M1): whether Gmail itself authenticated a mail as coming from `domain`, for auto-save only. The
 * TOPMOST `Authentication-Results` header must be Gmail's (`mx.google.com`; a sender cannot place a header above
 * the one Gmail prepends), with DMARC pass whose `header.from` is exactly `domain`, and a passing DKIM signature
 * aligned with the From address, whose own domain must be `domain`. Anything else (no header, another authserv-id
 * on top, spf/dmarc fail, a misaligned DKIM) is false: the capture stays a draft. The capture's trust label stays
 * `unverified` regardless (owner decision 2026-10-13).
 */
export function gmailSenderAuthenticated(
	headers: readonly MailHeader[],
	fromAddress: string,
	domain: string | null
): boolean {
	if (!domain) return false;
	const top = headers.find((h) => h.key === 'authentication-results');
	if (!top) return false;
	// Red team M2: fail closed on anything a sender could have shaped inside Gmail's own header: exactly Gmail's
	// authserv-id, nothing unexpected or result-like in quotes or comments, exactly one DMARC result, a pass.
	const strict = parseStrict(top.value);
	if (!strict || strict.unexpected || strict.rawAuthservId !== GMAIL_AUTHSERV_ID) return false;
	if (strict.dmarcResults.length !== 1 || strict.dmarcResults[0] !== 'pass') return false;
	const auth = strict.result;
	if (auth.dmarcFrom !== domain) return false;
	if (domainOf(fromAddress.trim().toLowerCase()) !== domain) return false;
	return authenticatedFrom(auth, fromAddress);
}
