import { execFileSync } from 'node:child_process';
import { assertLocalOnly, LOCAL_STATE_DIR } from './local-guard.ts';

assertLocalOnly(process.argv.slice(2));
const persistTo = process.env.FIN_PERSIST_TO ?? LOCAL_STATE_DIR;
execFileSync(
	'npx',
	['wrangler', 'd1', 'migrations', 'apply', 'montra', '--local', '--persist-to', persistTo],
	{ stdio: 'inherit', env: { ...process.env, CI: 'true' } }
);
