import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync
} from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDF_PASSWORD_MAX_LENGTH } from '../src/lib/server/statements/pdf-text.ts';
import { readStatement, STATEMENT_MAX_BYTES } from '../src/lib/server/statements/read.ts';
import { STATEMENT_PARSERS } from '../src/lib/shared/statements/parsers.ts';
import type { StatementParser } from '../src/lib/shared/statements/types.ts';
import { maskAccountNumbers } from '../src/lib/shared/text.ts';
import { assertLocalOnly } from './local-guard.ts';
import { patchPdfjs, PDFJS_MODULE } from './pdfjs-bounded.ts';

/**
 * `npm run compat:statements` (FN-16a): runs every file the owner put under the local, git-ignored
 * `.superpowers/ref/samples/statements/` through the same reader the /impor action uses, and prints a matrix of
 * counts only — never a file name, account number, description or any other row content. Receipt photos under
 * `.../receipts/` are only counted here: `npm run compat:receipts` (FN-15) reads them. Touches no database and
 * sends nothing anywhere. Always exits 0: a compatibility report, not a gate (PRD owner decision E).
 *
 * A password-protected sample is opened with the password in a `.pdf-password` file next to it (same git-ignored
 * folder), else `FIN_SAMPLE_PDF_PASSWORD`. The password is used for that read only and never printed.
 */

export const DEFAULT_SAMPLES_DIR = '.superpowers/ref/samples';

export interface StatementLine {
	/** The institution folder the owner filed it under (masked), `(root)` for a file directly in statements/. */
	folder: string;
	format: string;
	institution: string;
	pages: string;
	parsed: string;
	/** `n (reason: count, …)` or a refusal. */
	rejected: string;
	balance: string;
}

/** Every regular file under `dir` (recursive, sorted, dot-files skipped). */
function filesUnder(dir: string): string[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile() && !d.name.startsWith('.'))
		.map((d) => join(d.parentPath, d.name))
		.sort();
}

/** The first folder below `root`, masked; never the file name. */
function folderOf(root: string, file: string): string {
	const parts = relative(root, file).split(sep);
	return parts.length > 1 ? maskAccountNumbers(parts[0]!).slice(0, 24) : '(root)';
}

/** Name of the optional password file next to a sample (the folder is git-ignored; never printed). */
export const SAMPLE_PASSWORD_FILE = '.pdf-password';

/**
 * The password for one sample: its folder's `.pdf-password` (one line; a trailing newline is dropped), else
 * `fallback`. Only a regular file that really sits in the sample's own folder counts: a symlink (red team L1),
 * anything resolving outside that folder, or a file longer than a password can be is ignored.
 */
export function samplePassword(file: string, fallback: string | null): string | null {
	const folder = dirname(file);
	const path = join(folder, SAMPLE_PASSWORD_FILE);
	let fd: number;
	try {
		if (!lstatSync(path).isFile()) return fallback;
		if (realpathSync(path) !== join(realpathSync(folder), SAMPLE_PASSWORD_FILE)) return fallback;
		// O_NOFOLLOW: a symlink swapped in after the checks is refused by the open itself.
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return fallback;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > PDF_PASSWORD_MAX_LENGTH * 4 + 2) return fallback;
		const password = readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
		return password === '' ? fallback : password;
	} finally {
		closeSync(fd);
	}
}

const REFUSAL_LABELS: Readonly<Record<string, string>> = {
	not_readable: 'not PDF/CSV/UTF-8',
	spreadsheet_unsupported: 'XLS/XLSX not supported',
	encrypted: 'password-protected (add .pdf-password or set FIN_SAMPLE_PDF_PASSWORD)',
	wrong_password: 'wrong password',
	corrupt: 'corrupt PDF',
	too_complex: 'too complex (cap/timeout)',
	needs_ai: 'perlu dibaca AI (FN-16)',
	montra_csv: 'FN-18 CSV (use Impor CSV)',
	institution_unknown: 'institution not detected',
	institution_mismatch: 'institution mismatch',
	institution_conflict: "two banks' letterheads",
	inconsistent: 'inconsistent (running balance/totals/rows do not match)',
	section_unsupported: 'not an IDR savings/current account',
	empty: 'empty CSV',
	unterminated_quote: 'CSV unterminated quote',
	too_many_columns: 'CSV > 50 columns',
	card_unsupported: 'card statement with more than one card (not supported yet)'
};

/**
 * One read as /impor would do it: as an account statement, and (FN-55b) as a card statement when the file is one
 * (the harness has no wallet: it reads a card statement as if a card wallet were picked).
 */
async function readAsImport(
	input: { bytes: Uint8Array; password: string | null; section?: number | null },
	parsers: readonly StatementParser[]
) {
	// A fresh buffer per read: PDF.js takes the buffer over (it may be detached afterwards).
	const asBank = await readStatement(
		{ ...input, bytes: input.bytes.slice(), institution: null },
		parsers
	);
	if (asBank.ok || asBank.error !== 'needs_card_wallet') return asBank;
	return readStatement({ ...input, institution: null, walletKind: 'card' }, parsers);
}

/** One statement file (one account of it, when `section` is given) → its matrix line (counts and reasons only). */
export async function statementLine(
	root: string,
	file: string,
	password: string | null,
	section: number | null = null,
	parsers: readonly StatementParser[] = STATEMENT_PARSERS
): Promise<StatementLine> {
	const folder = folderOf(root, file) + (section === null ? '' : `#${section + 1}`);
	const dash = { pages: '—', parsed: '—', balance: '—' };
	if (statSync(file).size > STATEMENT_MAX_BYTES)
		return { folder, format: '—', institution: '—', ...dash, rejected: '— (larger than 15 MB)' };
	const result = await readAsImport(
		{ bytes: new Uint8Array(readFileSync(file)), password, section },
		parsers
	);
	if (!result.ok) {
		const format =
			result.error === 'needs_ai' ? 'pdf_scanned' : (result.hints?.format ?? 'unknown');
		const pages = result.hints?.pages;
		return {
			folder,
			format,
			institution: result.error === 'institution_unknown' ? 'unknown' : '—',
			...dash,
			pages: pages === null || pages === undefined ? '—' : String(pages),
			rejected: `— (${REFUSAL_LABELS[result.error] ?? result.error})`
		};
	}
	const { reading } = result;
	const reasons = new Map<string, number>();
	let parsed = 0;
	for (const row of reading.parse.rows) {
		if (row.ok) parsed++;
		else reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
	}
	const rejectedCount = reading.parse.rows.length - parsed;
	const reasonText = [...reasons].map(([r, n]) => `${r}: ${n}`).join(', ');
	const b = reading.balance;
	return {
		folder,
		format: reading.format,
		institution: reading.institution.id,
		pages:
			reading.pages === null
				? '—'
				: `${reading.pages}${reading.pagesNotProcessed > 0 ? ` (+${reading.pagesNotProcessed} not read)` : ''}`,
		parsed: String(parsed),
		rejected: rejectedCount > 0 ? `${rejectedCount} (${reasonText})` : '0',
		balance:
			b.status === 'pass'
				? 'pass (Rp0 gap)'
				: b.status === 'gap'
					? `fail (gap ${b.gapMinor} minor units)`
					: 'no opening/closing balance printed'
	};
}

/**
 * A file's matrix lines: one, or one per account for a statement holding several (FN-16e), each read the way
 * the /impor picker would read it.
 */
export async function statementLines(
	root: string,
	file: string,
	password: string | null,
	parsers: readonly StatementParser[] = STATEMENT_PARSERS
): Promise<StatementLine[]> {
	if (statSync(file).size > STATEMENT_MAX_BYTES)
		return [await statementLine(root, file, password, null, parsers)];
	const whole = await readAsImport(
		{ bytes: new Uint8Array(readFileSync(file)), password },
		parsers
	);
	const sections = !whole.ok && whole.error === 'section_required' ? (whole.sections ?? []) : [];
	if (sections.length === 0) return [await statementLine(root, file, password, null, parsers)];
	const lines: StatementLine[] = [];
	for (const s of sections) lines.push(await statementLine(root, file, password, s.index, parsers));
	return lines;
}

const COLUMNS: [keyof StatementLine, string][] = [
	['folder', 'folder'],
	['format', 'format'],
	['institution', 'institution'],
	['pages', 'pages'],
	['parsed', 'rows parsed'],
	['rejected', 'rows rejected (reasons)'],
	['balance', 'balance check']
];

/** The matrix as text: a header, one numbered line per file, aligned columns. */
export function formatMatrix(lines: readonly StatementLine[]): string {
	const rows = [
		['#', ...COLUMNS.map(([, h]) => h)],
		...lines.map((l, i) => [String(i + 1), ...COLUMNS.map(([k]) => l[k])])
	];
	const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
	return rows
		.map((r) =>
			r
				.map((cell, c) => cell.padEnd(widths[c]!))
				.join('  ')
				.trimEnd()
		)
		.join('\n');
}

/** The whole report for `samplesDir` (statements matrix plus one line per receipt). */
export async function compatReport(
	samplesDir: string,
	password: string | null,
	parsers: readonly StatementParser[] = STATEMENT_PARSERS
): Promise<string> {
	const statementsDir = join(samplesDir, 'statements');
	const receiptsDir = join(samplesDir, 'receipts');
	const statements = filesUnder(statementsDir);
	const receipts = filesUnder(receiptsDir);
	const out: string[] = [];
	if (statements.length === 0)
		out.push(`No statement samples in ${statementsDir} — nothing to check (tidak ada sampel).`);
	else {
		const lines: StatementLine[] = [];
		for (const file of statements)
			lines.push(
				...(await statementLines(statementsDir, file, samplePassword(file, password), parsers))
			);
		out.push(`Statements (${lines.length} files):`, formatMatrix(lines));
	}
	if (receipts.length === 0) out.push(`No receipt samples in ${receiptsDir}.`);
	else {
		out.push(`Receipts (${receipts.length} files):`);
		receipts.forEach((file, i) =>
			out.push(`${i + 1}  ${folderOf(receiptsDir, file)}  read with npm run compat:receipts`)
		);
	}
	return out.join('\n');
}

/** Plain Node has no Vite: the same PDF.js decode budget patch is applied as the module loads. */
export function registerPdfjsBudget(): void {
	registerHooks({
		load(url, context, nextLoad) {
			const loaded = nextLoad(url, context);
			if (!url.startsWith('file:') || !PDFJS_MODULE.test(fileURLToPath(url))) return loaded;
			return { ...loaded, source: patchPdfjs(String(loaded.source)) };
		}
	});
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	assertLocalOnly(argv);
	registerPdfjsBudget();
	const option = (name: string) =>
		argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
	try {
		console.log(
			await compatReport(
				option('samples') ?? process.env.FIN_SAMPLES_DIR ?? DEFAULT_SAMPLES_DIR,
				// From the environment, not argv, so it never shows in the process list.
				process.env.FIN_SAMPLE_PDF_PASSWORD || null
			)
		);
	} catch (e) {
		// A report, never a gate: an unexpected failure is one fixed line (no file content), still exit 0.
		console.log(`compat:statements stopped: ${e instanceof Error ? e.name : 'error'}`);
	}
	process.exit(0);
}
