import { readdirSync, readFileSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';

/** Runs one migration file statement by statement, as `openLocalD1` does for every file. */
export async function applyMigration(db: D1Database, file: string): Promise<void> {
	const statements = readFileSync(`migrations/${file}`, 'utf8')
		.split('--> statement-breakpoint')
		.map((s) => s.trim())
		.filter(Boolean);
	for (const statement of statements) await db.prepare(statement).run();
}

/**
 * Fresh, non-persisted local D1 (workerd) with every migration applied, plus the proxy's other local bindings
 * (`env.FILES` is a local R2 bucket). Never remote. Call `dispose()`. `before`: only the migrations whose file
 * name sorts before it (a migration test then fills the older schema and applies the rest itself).
 */
export async function openLocalD1(options: { before?: string } = {}): Promise<{
	db: D1Database;
	env: { DB: D1Database; FILES: R2Bucket };
	dispose: () => Promise<void>;
}> {
	const proxy = await getPlatformProxy<{ DB: D1Database; FILES: R2Bucket }>({
		configPath: 'wrangler.jsonc',
		persist: false,
		remoteBindings: false
	});
	try {
		const db = proxy.env.DB;
		const before = options.before;
		for (const file of readdirSync('migrations')
			.filter((f) => f.endsWith('.sql') && (before === undefined || f < before))
			.sort())
			await applyMigration(db, file);
		return { db, env: proxy.env, dispose: () => proxy.dispose() };
	} catch (e) {
		await proxy.dispose();
		throw e;
	}
}

/** Fresh, non-persisted local D1 (workerd) with every migration applied. Never remote. */
export async function withLocalD1(fn: (db: D1Database) => Promise<void>): Promise<void> {
	const { db, dispose } = await openLocalD1();
	try {
		await fn(db);
	} finally {
		await dispose();
	}
}

/**
 * A wallet written with the columns every schema before migration 0047 has (FN-55a added three), for migration
 * tests that fill an older schema first: the app's `createWallet` names every current column. Same arguments and
 * answer as `createWallet` (`{ ok: true, id }`).
 */
export async function insertLegacyWallet(
	db: D1Database,
	scope: { spaceId: string; userId?: string },
	input: {
		name: string;
		type: string;
		currency: string;
		openingBalanceMinor: number;
		isFavourite: boolean;
		lastFour: string | null;
	},
	now: number
): Promise<{ ok: true; id: string }> {
	const id = crypto.randomUUID();
	await db
		.prepare(
			`insert into wallets (id, space_id, name, type, currency, opening_balance_minor, is_favourite, last_four,
				created_at, updated_at, deleted_at, seq) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 1)`
		)
		.bind(
			id,
			scope.spaceId,
			input.name,
			input.type,
			input.currency,
			input.openingBalanceMinor,
			input.isFavourite ? 1 : 0,
			input.lastFour,
			now,
			now
		)
		.run();
	return { ok: true, id };
}
