import { execFileSync } from 'node:child_process';
import { wibTodayString } from '../src/lib/shared/dates.ts';
import { demoSeedStatements } from './demo-seed.ts';
import { demoVoucherStatements } from './demo-vouchers.ts';
import { assertLocalOnly, LOCAL_STATE_DIR } from './local-guard.ts';

assertLocalOnly(process.argv.slice(2));
const persistTo = process.env.FIN_PERSIST_TO ?? LOCAL_STATE_DIR;
// Fictional demo data only: the marker below, plus `is_demo` transactions for every local space that has an
// IDR wallet (badged "Data demo", excluded from every total). Sign up and add a wallet first, then seed.
const sql = [
	"INSERT INTO app_meta (key, value, updated_at) VALUES ('demo_seed', 'v2', 0) " +
		'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
	...demoSeedStatements(wibTodayString()),
	// FN-30: two local voucher codes (COBA-KREDIT-100, COBA-PRO-7-HARI), stored as hashes.
	...demoVoucherStatements()
].join(';\n');
execFileSync(
	'npx',
	['wrangler', 'd1', 'execute', 'montra', '--local', '--persist-to', persistTo, '--command', sql],
	{ stdio: 'inherit', env: { ...process.env, CI: 'true' } }
);
