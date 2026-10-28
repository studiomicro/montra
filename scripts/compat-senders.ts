import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import PostalMime from 'postal-mime';
import { join, relative, sep } from 'node:path';
import { parseAuthResults } from '../src/lib/shared/inbound/auth-results.ts';
import { addressDomain, cleanMailText, htmlToText } from '../src/lib/shared/inbound/mail.ts';
import { parsePaymentMail, parserFor } from '../src/lib/shared/inbound/parsers.ts';
import { confirmedSender } from '../src/lib/shared/inbound/sender-domains.ts';
import { maskAccountNumbers } from '../src/lib/shared/text.ts';
import { assertLocalOnly } from './local-guard.ts';

/**
 * `npm run compat:senders` (FN-19b § D, mirrors `compat:statements`): runs every mail sample the owner put under the
 * local, git-ignored `.superpowers/ref/samples/mail/` (raw `.eml`, or `.eml.txt`) through the same mail parser and
 * deterministic payment parsers the capture paths use, and prints per sample: the institution folder (masked), the
 * `From:` domain, the DMARC `header.from` domain of the topmost `Authentication-Results` (what a registry entry's
 * `owner-sample` confirmation rests on), whether a parser reads the mail, and whether the domain is in the confirmed
 * registry. Never a file name, an address's local part, a subject, an amount or any body text. Adding a domain
 * stays a one-line registry change (sender-domains.ts) plus a fictional fixture. Touches no database and sends
 * nothing anywhere. Always exits 0: a compatibility report, not a gate.
 */

export const DEFAULT_MAIL_SAMPLES_DIR = '.superpowers/ref/samples/mail';

/** Every sample file under `dir` (recursive, sorted, dot-files skipped). */
function samplesUnder(dir: string): string[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile() && !d.name.startsWith('.') && /\.eml(\.txt)?$/i.test(d.name))
		.map((d) => join(d.parentPath, d.name))
		.sort();
}

/** The first folder below `root`, masked; never the file name. */
function folderOf(root: string, file: string): string {
	const parts = relative(root, file).split(sep);
	return parts.length > 1 ? maskAccountNumbers(parts[0]!).slice(0, 24) : '(root)';
}

export interface SenderLine {
	folder: string;
	domain: string;
	dmarcFrom: string;
	parser: string;
	reads: 'yes' | 'no' | '-';
	registry: 'confirmed' | 'no';
}

/** The parts of a sample this report reads (the inbound Worker's own parse, without its size limits). */
async function parseSample(raw: Uint8Array) {
	try {
		const email = await PostalMime.parse(raw);
		const from = email.from && 'address' in email.from ? (email.from.address ?? '') : '';
		return {
			fromAddress: from.trim().toLowerCase(),
			subject: email.subject ?? '',
			text: cleanMailText(email.text ?? (email.html ? htmlToText(email.html) : '')),
			headers: email.headers
		};
	} catch {
		return null;
	}
}

/** One sample's line (exported for the test); `raw` is the mail as stored. */
export async function senderLine(folder: string, raw: Uint8Array): Promise<SenderLine> {
	const mail = await parseSample(raw);
	if (!mail)
		return {
			folder,
			domain: '(unreadable)',
			dmarcFrom: '-',
			parser: '-',
			reads: '-',
			registry: 'no'
		};
	const domain = addressDomain(mail.fromAddress);
	const top = mail.headers.find((h) => h.key === 'authentication-results');
	const auth = top ? parseAuthResults(top.value) : null;
	const parser = parserFor(domain);
	const reads = parser ? (parsePaymentMail(parser, mail.subject, mail.text) ? 'yes' : 'no') : '-';
	return {
		folder,
		domain: domain ?? '(none)',
		dmarcFrom: auth?.dmarcFrom ?? '-',
		parser: parser?.id ?? '-',
		reads,
		registry: confirmedSender(domain) ? 'confirmed' : 'no'
	};
}

/** The whole report for `dir`. */
export async function compatSendersReport(dir = DEFAULT_MAIL_SAMPLES_DIR): Promise<string> {
	const files = samplesUnder(dir);
	if (files.length === 0) return `tidak ada sampel e-mail di ${DEFAULT_MAIL_SAMPLES_DIR}`;
	const lines = ['folder  domain  dmarc-from  parser  reads  registry'];
	for (const file of files) {
		const l = await senderLine(folderOf(dir, file), new Uint8Array(readFileSync(file)));
		lines.push(`${l.folder}  ${l.domain}  ${l.dmarcFrom}  ${l.parser}  ${l.reads}  ${l.registry}`);
	}
	return lines.join('\n');
}

if (import.meta.main) {
	assertLocalOnly(process.argv.slice(2));
	try {
		console.log(await compatSendersReport());
	} catch (e) {
		// A report, never a gate: an unexpected failure is one fixed line (no content), still exit 0.
		console.log(`compat:senders stopped: ${e instanceof Error ? e.name : 'error'}`);
	}
	process.exit(0);
}
