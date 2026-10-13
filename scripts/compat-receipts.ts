import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { sanitizeImage } from '../src/lib/server/photos/image.ts';
import { readReceiptImage, type ReceiptReadOutcome } from '../src/lib/server/receipts/anthropic.ts';
import { assertLocalOnly } from './local-guard.ts';

/**
 * `npm run compat:receipts` (FN-15): the golden-set accuracy check the owner runs by hand. For every photo under
 * the local, git-ignored `.superpowers/ref/samples/receipts/` with a sibling `<name>.expected.json`
 * (`{ "shop"?: string, "totalRupiah"?: number, "date"?: "YYYY-MM-DD", "itemCount"?: number }`), it reads the photo
 * for real — the same checks and the same `readReceiptImage` the /riwayat/struk action uses — and prints whether
 * each expected field matched: counts and match/miss only, never a file name, merchant, item or amount.
 *
 * The real provider is called only with the owner's own key and gateway from the local `.dev.vars`
 * (`COMPAT_RECEIPTS_ANTHROPIC_KEY`, `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`), never from a command-line argument.
 * Without them it only counts samples. Never part of `npm run gates` or CI; always exits 0 (a report, not a gate).
 */

export const DEFAULT_RECEIPTS_DIR = '.superpowers/ref/samples/receipts';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface ReceiptCredentials {
	apiKey: string;
	env: { AI_GATEWAY_ACCOUNT_ID: string; AI_GATEWAY_ID: string };
}

interface Expected {
	shop?: string;
	totalRupiah?: number;
	date?: string;
	itemCount?: number;
}

/** The variables of a `.dev.vars` file (KEY=value lines; quotes stripped). */
export function parseDevVars(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
	}
	return out;
}

/** The owner's local key and gateway, or null when any of them is missing. */
export function credentialsFrom(vars: Record<string, string>): ReceiptCredentials | null {
	const apiKey = vars.COMPAT_RECEIPTS_ANTHROPIC_KEY ?? '';
	const account = vars.AI_GATEWAY_ACCOUNT_ID ?? '';
	const gateway = vars.AI_GATEWAY_ID ?? '';
	if (!apiKey.startsWith('sk-ant-') || !account || !gateway) return null;
	return { apiKey, env: { AI_GATEWAY_ACCOUNT_ID: account, AI_GATEWAY_ID: gateway } };
}

/** Every receipt photo under `dir` (recursive, sorted, dot-files skipped). */
function photosUnder(dir: string): string[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(
			(d) =>
				d.isFile() && !d.name.startsWith('.') && IMAGE_EXTENSIONS.has(extname(d.name).toLowerCase())
		)
		.map((d) => join(d.parentPath, d.name))
		.sort();
}

function expectedFor(photo: string): Expected | null {
	const file = join(dirname(photo), `${basename(photo, extname(photo))}.expected.json`);
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
		return typeof parsed === 'object' && parsed !== null ? (parsed as Expected) : null;
	} catch {
		return null;
	}
}

const normal = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const verdict = (ok: boolean) => (ok ? 'match' : 'miss');

/** One sample → its line (outcome kinds and match/miss only). */
async function sampleLine(
	index: number,
	photo: string,
	expected: Expected,
	credentials: ReceiptCredentials,
	read: typeof readReceiptImage
): Promise<{ line: string; fields: number; matched: number }> {
	const image = sanitizeImage(new Uint8Array(readFileSync(photo)));
	if (!image.ok)
		return { line: `${index}  refused before reading (${image.reason})`, fields: 0, matched: 0 };
	const outcome: ReceiptReadOutcome = await read(credentials.env, credentials.apiKey, image);
	if (outcome.kind !== 'ok') return { line: `${index}  ${outcome.kind}`, fields: 0, matched: 0 };
	const r = outcome.reading;
	const checks: [string, boolean][] = [];
	if (expected.shop !== undefined) checks.push(['shop', normal(r.shop) === normal(expected.shop)]);
	if (expected.totalRupiah !== undefined)
		checks.push(['total', r.totalMinor === expected.totalRupiah * 100]);
	if (expected.date !== undefined) checks.push(['date', r.occurredOn === expected.date]);
	if (expected.itemCount !== undefined)
		checks.push(['items', r.items.length === expected.itemCount]);
	const matched = checks.filter(([, ok]) => ok).length;
	return {
		line: `${index}  ok  ${checks.map(([name, ok]) => `${name}:${verdict(ok)}`).join('  ')}`.trimEnd(),
		fields: checks.length,
		matched
	};
}

/** The whole report for `dir`. `read` is injected by tests (no test reaches the provider). */
export async function compatReceiptsReport(
	dir: string,
	credentials: ReceiptCredentials | null,
	read: typeof readReceiptImage = readReceiptImage
): Promise<string> {
	const photos = photosUnder(dir);
	if (photos.length === 0) return `Tidak ada sampel struk di ${dir} — nothing to check.`;
	const withExpected = photos.map((p) => ({ photo: p, expected: expectedFor(p) }));
	const ready = withExpected.filter((s) => s.expected !== null);
	const out = [`Receipts: ${photos.length} photos, ${ready.length} with an .expected.json.`];
	if (!credentials) {
		out.push('tidak ada kunci Anthropic lokal — hanya menghitung sampel');
		return out.join('\n');
	}
	let fields = 0;
	let matched = 0;
	let index = 0;
	for (const sample of ready) {
		const result = await sampleLine(++index, sample.photo, sample.expected!, credentials, read);
		out.push(result.line);
		fields += result.fields;
		matched += result.matched;
	}
	out.push(`Fields matched: ${matched}/${fields}.`);
	return out.join('\n');
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	assertLocalOnly(argv);
	const option = (name: string) =>
		argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
	try {
		const vars = existsSync('.dev.vars') ? parseDevVars(readFileSync('.dev.vars', 'utf8')) : {};
		console.log(
			await compatReceiptsReport(
				option('samples') ?? process.env.FIN_RECEIPT_SAMPLES_DIR ?? DEFAULT_RECEIPTS_DIR,
				credentialsFrom(vars)
			)
		);
	} catch (e) {
		// A report, never a gate: an unexpected failure is one fixed line (no file content), still exit 0.
		console.log(`compat:receipts stopped: ${e instanceof Error ? e.name : 'error'}`);
	}
	process.exit(0);
}
