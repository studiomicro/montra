import { sql } from 'drizzle-orm';
import { wibIsoString } from '#lib/shared/dates';
import { maskAccountNumbers } from '#lib/shared/text';
import { zipStore, type ZipEntry } from '#lib/shared/zip';
import type { Db } from '../db';
import { exportTransactionsCsvRanges, type ExportRange } from '../imports/csv-export';
import { isLiveMember } from '../spaces/access';
import { listMembers, listSpaces, type SpaceSummary } from '../spaces/spaces';
import {
	ACCOUNT_JSON_TABLES,
	ACCOUNT_TABLE_DECISIONS,
	countRows,
	exportRow,
	SPACE_JSON_TABLES,
	SPACE_TABLE_DECISIONS,
	tablePages,
	type RowScope,
	type TablePlan
} from './tables';

/**
 * The full-account export (FN-31; ruling R21: a UU PDP copy holds all of the user's data). One store-only
 * ZIP:
 * - `account.json`: profile, the spaces index, whether an account key and a personal AI key exist (FN-41: never
 *   the key), what is not included and why;
 * - `account/<table>.json`: every account-level table with an export decision (tables.ts);
 * - `transactions-NN-<space>.csv`: per live space, FN-18's own exporter (expense and income only), year by
 *   year, newest first;
 * - `spaces/<slug>-<short id>/space.json` (name, kind, role, members as Ruang shows them) and
 *   `spaces/<slug>-<short id>/<table>.json` for every space-scoped table with an export decision, including
 *   `transactions.json` with every live transaction of every type (transfers and balance adjustments, FN-37,
 *   which the CSV format has no rows for), free text masked; `Data demo` rows are in neither file;
 * - `photos/<kind>/<id>.<ext>`: belongings and collectibles photos and kept receipt photos (FN-15, kind
 *   `receipts`, the transaction id), streamed from R2.
 *
 * Bounded, and refused rather than cut: at most ACCOUNT_EXPORT_MAX_ROWS rows over all tables (capped counts
 * first), ACCOUNT_EXPORT_MAX_PHOTOS photos and ACCOUNT_EXPORT_MAX_PHOTO_BYTES of photo bytes (sized with R2
 * HEAD before anything is streamed). Streamed: the ZIP is written as the download pulls, one page or one R2
 * chunk at a time. Deterministic: no export time inside the archive. Every space page, photo GET and member
 * list re-checks the live membership, so a removal while the download runs ends that space's rows, photos
 * and member names.
 */

/**
 * Exports per account in one 10-minute throttle window: two in a row always succeed ("export any time",
 * PRD FN-31 criterion 8); a script hammering the export is stopped.
 */
export const ACCOUNT_EXPORT_MAX_PER_WINDOW = 5;
/** Most rows (transactions and every exported table together) one account export carries. */
export const ACCOUNT_EXPORT_MAX_ROWS = 200_000;
/** Most photos one export carries (each costs an R2 HEAD and a GET). */
export const ACCOUNT_EXPORT_MAX_PHOTOS = 1_000;
/** Most photo bytes one export carries (500 MiB). */
export const ACCOUNT_EXPORT_MAX_PHOTO_BYTES = 500 * 1024 * 1024;
/** Most distinct (space, year) pairs one export reads: each costs at least one query. */
const YEARS_LIMIT = 2_000;
/** R2 HEAD requests in flight at once while sizing the photos. */
const HEAD_CONCURRENCY = 8;

/**
 * What FN-18's export lists: live, non-demo income and expense rows of the space (transfers and balance
 * adjustments, FN-37, are not rows there).
 */
const EXPORTABLE = sql`t.deleted_at is null and t.is_demo = 0 and t.type in ('expense', 'income')`;

/** The user's live spaces (both the membership and the space live), as an SQL subquery of space ids. */
const liveSpaceIds = (userId: string) => sql`(select m.space_id from space_members m
	join spaces s on s.id = m.space_id
	where m.user_id = ${userId} and m.deleted_at is null and s.deleted_at is null)`;

/** Whether the account holds more rows (transactions plus every exported table) than one export carries. */
async function tooLarge(db: Db, userId: string, maxRows: number): Promise<boolean> {
	// Transactions count once, through their JSON file (every type); the CSV repeats a subset of those rows.
	let total = 0;
	for (const p of SPACE_JSON_TABLES) {
		if (total > maxRows) return true;
		total += await countRows(
			db,
			p,
			{ kind: 'space', liveSpaceIds: liveSpaceIds(userId), userId },
			maxRows
		);
	}
	for (const p of ACCOUNT_JSON_TABLES) {
		if (total > maxRows) return true;
		total += await countRows(db, p, { kind: 'account', userId }, maxRows);
	}
	return total > maxRows;
}

/**
 * Per live space, the WIB years (`YYYY`) that hold exportable rows, newest first; null past YEARS_LIMIT
 * (refused as too large rather than exported incomplete).
 */
async function yearsBySpace(db: Db, userId: string): Promise<Map<string, string[]> | null> {
	const rows = await db.all<{ spaceId: string; year: string }>(sql`select t.space_id as spaceId,
			substr(t.occurred_on, 1, 4) as year
		from transactions t
		where t.space_id in ${liveSpaceIds(userId)} and ${EXPORTABLE}
		group by t.space_id, substr(t.occurred_on, 1, 4)
		order by t.space_id, year desc
		limit ${YEARS_LIMIT + 1}`);
	if (rows.length > YEARS_LIMIT) return null;
	const map = new Map<string, string[]>();
	for (const r of rows) {
		if (!/^\d{4}$/.test(r.year)) continue;
		map.set(r.spaceId, [...(map.get(r.spaceId) ?? []), r.year]);
	}
	return map;
}

/** FN-18's bounded ranges covering the given years: one calendar year each (within MAX_FILTER_DAYS). */
export function yearRanges(years: readonly string[]): ExportRange[] {
	return years.map((y) => ({ from: `${y}-01-01`, to: `${y}-12-31` }));
}

/** A plain-ASCII form of the space's name (`pribadi` for the personal space), at most 40 characters. */
export function spaceSlug(space: Pick<SpaceSummary, 'kind' | 'name'>): string {
	if (space.kind === 'personal') return 'pribadi';
	return (
		space.name
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40)
			.replace(/-+$/, '') || 'ruang'
	);
}

/** `transactions-01-pribadi.csv`: position (unique) plus the space's slug. */
export function spaceFileName(index: number, space: Pick<SpaceSummary, 'kind' | 'name'>): string {
	return `transactions-${String(index + 1).padStart(2, '0')}-${spaceSlug(space)}.csv`;
}

/** `spaces/keluarga-1a2b3c4d`: the slug plus the start of the space id (unique, stable). */
export function spaceFolder(space: Pick<SpaceSummary, 'id' | 'kind' | 'name'>): string {
	return `spaces/${spaceSlug(space)}-${space.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
}

const iso = (ms: number | null) => (ms === null ? null : wibIsoString(ms));

const EXTENSIONS: Readonly<Record<string, string>> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp'
};

interface Photo {
	key: string;
	spaceId: string;
	kind: 'belongings' | 'collectibles' | 'receipts';
	path: string;
}

/** What the export says about one stored photo key: its path in the ZIP, or why it is not there. */
type PhotoOutcome = { photo: string } | { photo: null; photoNote: string };

const PHOTOS_UNAVAILABLE = 'not included: photo storage was not available for this export';
const PHOTO_MISSING = 'not included: the stored file was not found';

/** The live photos of the user's live spaces (bounded); null past ACCOUNT_EXPORT_MAX_PHOTOS. */
async function listPhotos(db: Db, userId: string): Promise<Photo[] | null> {
	const rows = await db.all<{
		id: string;
		key: string;
		spaceId: string;
		type: string;
		kind: Photo['kind'];
	}>(sql`
		select id, photo_key as key, space_id as spaceId, photo_type as type, 'belongings' as kind
			from belongings
			where space_id in ${liveSpaceIds(userId)} and deleted_at is null and photo_key is not null
		union all
		select id, photo_key, space_id, photo_type, 'collectibles' from collectibles
			where space_id in ${liveSpaceIds(userId)} and deleted_at is null and photo_key is not null
		union all
		select id, photo_key, space_id, photo_type, 'receipts' from transactions
			where space_id in ${liveSpaceIds(userId)} and deleted_at is null and photo_key is not null
				and is_demo = 0
		order by kind, id
		limit ${ACCOUNT_EXPORT_MAX_PHOTOS + 1}`);
	if (rows.length > ACCOUNT_EXPORT_MAX_PHOTOS) return null;
	return rows.map((r) => ({
		key: r.key,
		spaceId: r.spaceId,
		kind: r.kind,
		path: `photos/${r.kind}/${r.id}.${EXTENSIONS[r.type] ?? 'bin'}`
	}));
}

/** Sizes every photo with R2 HEAD (bounded concurrency): the found ones and their total bytes. */
async function sizePhotos(files: R2Bucket, photos: readonly Photo[]) {
	const found = new Set<string>();
	let bytes = 0;
	for (let i = 0; i < photos.length; i += HEAD_CONCURRENCY) {
		const heads = await Promise.all(
			photos.slice(i, i + HEAD_CONCURRENCY).map((p) => files.head(p.key))
		);
		heads.forEach((head, j) => {
			if (!head) return;
			found.add((photos[i + j] as Photo).key);
			bytes += head.size;
		});
	}
	return { found, bytes };
}

/**
 * Whether `userId` is still a live member of `spaceId` right now. The photo list and the spaces index are
 * fixed when the export starts; each photo GET and each member list re-checks, so a removal while the
 * download runs ends that space's photos and member names (FN-31 red team L1).
 */
async function stillMember(db: Db, spaceId: string, userId: string): Promise<boolean> {
	const row = await db.get<{ one: number }>(
		sql`select 1 as one where ${isLiveMember(spaceId, userId)}`
	);
	return row !== undefined && row !== null;
}

/** A pull stream of the chunks an async generator yields (`highWaterMark: 0`); cancel ends the generator. */
function streamOf(chunks: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const next = await chunks.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			async cancel() {
				await chunks.return(undefined);
			}
		},
		{ highWaterMark: 0 }
	);
}

const encoder = new TextEncoder();
const textStream = (text: string) =>
	streamOf(
		(async function* () {
			yield encoder.encode(text);
		})()
	);

/** A table's rows as a JSON array, one row per line, written page by page. */
async function* jsonRows(
	db: Db,
	p: TablePlan,
	scope: RowScope,
	photo?: (key: string | null) => PhotoOutcome | { photo: null }
): AsyncGenerator<Uint8Array> {
	let first = true;
	for await (const page of tablePages(db, p, scope, photo !== undefined)) {
		const lines = page.map((row) =>
			JSON.stringify(
				exportRow(p, row, photo ? (r) => photo((r.photo_key as string | null) ?? null) : undefined)
			)
		);
		yield encoder.encode((first ? '[\n' : ',\n') + lines.join(',\n'));
		first = false;
	}
	yield encoder.encode(first ? '[]\n' : '\n]\n');
}

/** Why the tables without a JSON file are not in it (account.json, so the copy explains itself). */
function notIncluded() {
	const accountJson = (table: string) =>
		(ACCOUNT_TABLE_DECISIONS as Readonly<Record<string, { export: string }>>)[table]?.export ===
		'json';
	// A space table written once per account instead (FN-19 forwarding) is included, not listed here.
	return [...Object.entries(ACCOUNT_TABLE_DECISIONS), ...Object.entries(SPACE_TABLE_DECISIONS)]
		.filter(([table, d]) => d.export !== 'json' && !accountJson(table))
		.map(([table, d]) => ({ table, reason: 'reason' in d ? d.reason : '' }));
}

/** `account.json`: the profile, picked field by field (never a row spread), and the archive's index. */
async function accountJson(
	db: Db,
	userId: string,
	spaces: readonly { file: string; folder: string; space: SpaceSummary }[],
	photos: { included: number; notIncluded: number }
): Promise<string> {
	const user = await db.get<{
		name: string;
		email: string;
		createdAt: number;
		adultConfirmedAt: number;
		lastLoginAt: number | null;
	}>(sql`select name, email, created_at as createdAt, adult_confirmed_at as adultConfirmedAt,
		last_login_at as lastLoginAt from users where id = ${userId}`);
	if (!user) throw new Error('account export: no account');
	const key = await db.get<{ one: number }>(
		sql`select 1 as one from account_keys where user_id = ${userId}`
	);
	// FN-41: whether a personal Anthropic key exists and its dates, picked field by field; never key material.
	const aiKey = await db.get<{ createdAt: number; updatedAt: number; lastTestedAt: number | null }>(
		sql`select created_at as createdAt, updated_at as updatedAt, last_tested_at as lastTestedAt
			from ai_keys where user_id = ${userId} and provider = 'anthropic'`
	);
	const doc = {
		format: 'montra-account-export',
		formatVersion: 3,
		notes: [
			'Each space folder has transactions.json with every transaction (expense, income, transfer, balance adjustment); the transactions-NN CSV files hold expense and income rows only, in the import template format. Demo rows ("Data demo") are in neither.',
			'Money is in integer minor units with its currency (IDR has no minor unit: 25000 = Rp 25.000).',
			'Times are WIB (UTC+07:00); dates (occurredOn, purchasedOn …) are WIB calendar dates.',
			'Account and card numbers are shown with their last 4 digits only.'
		],
		account: {
			name: user.name,
			email: user.email,
			createdAt: iso(user.createdAt),
			adultConfirmedAt: iso(user.adultConfirmedAt),
			lastSignInAt: iso(user.lastLoginAt)
		},
		accountFiles: ACCOUNT_JSON_TABLES.map((p) => `account/${p.table}.json`),
		spaces: spaces.map(({ file, folder, space }) => ({
			kind: space.kind,
			name: maskAccountNumbers(space.name),
			role: space.role,
			memberCount: space.memberCount,
			transactionsFile: file,
			folder
		})),
		photos,
		accountKey: { present: key !== undefined && key !== null },
		aiKeys: {
			hasAnthropicKey: aiKey !== undefined && aiKey !== null,
			anthropicKeyAddedAt: iso(aiKey?.createdAt ?? null),
			anthropicKeyReplacedAt:
				aiKey && aiKey.updatedAt !== aiKey.createdAt ? iso(aiKey.updatedAt) : null,
			anthropicKeyLastTestedAt: iso(aiKey?.lastTestedAt ?? null)
		},
		notIncluded: notIncluded()
	};
	return JSON.stringify(doc, null, 2) + '\n';
}

export type AccountExport =
	| { ok: true; stream: ReadableStream<Uint8Array> }
	| { ok: false; reason: 'too_large' | 'photos_too_large' };

export interface AccountExportOptions {
	/** The R2 bucket of photos; without it photos are listed with a note instead of included. */
	files?: R2Bucket;
	maxRows?: number;
	maxPhotoBytes?: number;
}

/** The account export of `userId` (always `locals.user.id`). */
export async function exportAccount(
	db: Db,
	userId: string,
	opts: AccountExportOptions = {}
): Promise<AccountExport> {
	const maxRows = opts.maxRows ?? ACCOUNT_EXPORT_MAX_ROWS;
	if (await tooLarge(db, userId, maxRows)) return { ok: false, reason: 'too_large' };
	const [spaces, years, photos] = await Promise.all([
		listSpaces(db, userId),
		yearsBySpace(db, userId),
		listPhotos(db, userId)
	]);
	if (!years || !photos) return { ok: false, reason: 'too_large' };

	const outcomes = new Map<string, PhotoOutcome>();
	let included: Photo[] = [];
	if (opts.files) {
		const sized = await sizePhotos(opts.files, photos);
		if (sized.bytes > (opts.maxPhotoBytes ?? ACCOUNT_EXPORT_MAX_PHOTO_BYTES))
			return { ok: false, reason: 'photos_too_large' };
		included = photos.filter((p) => sized.found.has(p.key));
		for (const p of photos)
			outcomes.set(
				p.key,
				sized.found.has(p.key) ? { photo: p.path } : { photo: null, photoNote: PHOTO_MISSING }
			);
	} else
		for (const p of photos) outcomes.set(p.key, { photo: null, photoNote: PHOTOS_UNAVAILABLE });
	const photoOf = (key: string | null) =>
		key === null
			? { photo: null }
			: (outcomes.get(key) ?? { photo: null, photoNote: PHOTO_MISSING });

	const listed = spaces.map((space, i) => ({
		file: spaceFileName(i, space),
		folder: spaceFolder(space),
		space
	}));
	const json = await accountJson(db, userId, listed, {
		included: included.length,
		notIncluded: photos.length - included.length
	});
	const files = opts.files;
	const entries: ZipEntry[] = [
		{ name: 'account.json', open: () => textStream(json) },
		...ACCOUNT_JSON_TABLES.map((p) => ({
			name: `account/${p.table}.json`,
			open: () => streamOf(jsonRows(db, p, { kind: 'account', userId }))
		})),
		...listed.map(({ file, space }) => ({
			name: file,
			open: () =>
				exportTransactionsCsvRanges(
					db,
					{ spaceId: space.id, userId },
					yearRanges(years.get(space.id) ?? [])
				)
		})),
		...listed.flatMap(({ folder, space }) => {
			const scope: RowScope = { kind: 'space', spaceId: space.id, userId };
			return [
				{
					name: `${folder}/space.json`,
					open: () =>
						streamOf(
							(async function* () {
								const members = (await stillMember(db, space.id, userId))
									? await listMembers(db, space.id, userId)
									: [];
								const doc = {
									kind: space.kind,
									name: maskAccountNumbers(space.name),
									role: space.role,
									members: members.map((m) => ({ name: m.name, role: m.role, isYou: m.isYou }))
								};
								yield encoder.encode(JSON.stringify(doc, null, 2) + '\n');
							})()
						)
				},
				...SPACE_JSON_TABLES.map((p) => ({
					name: `${folder}/${p.table}.json`,
					open: () => streamOf(jsonRows(db, p, scope, p.decision.photo ? photoOf : undefined))
				}))
			];
		}),
		...(files
			? included.map((p) => ({
					name: p.path,
					open: () =>
						streamOf(
							(async function* () {
								if (!(await stillMember(db, p.spaceId, userId))) return;
								const object = await files.get(p.key);
								if (!object) return;
								const reader = object.body.getReader();
								let finished = false;
								try {
									for (;;) {
										const { done, value } = await reader.read();
										if (done) break;
										yield value;
									}
									finished = true;
								} finally {
									// A cancelled download stops the R2 read too.
									if (!finished) await reader.cancel().catch(() => {});
									reader.releaseLock();
								}
							})()
						)
				}))
			: [])
	];
	return { ok: true, stream: zipStore(entries) };
}
