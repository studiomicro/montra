import { execFileSync } from 'node:child_process';
import { E2E_PORT } from './helpers';

/** Local D1 state of the e2e server on this port (see playwright.config.ts). */
const PERSIST = `.wrangler/e2e-state-${E2E_PORT}`;

/**
 * Runs SQL against the e2e server's own local D1 with wrangler (never a remote) and returns its `--json` output.
 * A failure throws with wrangler's own output, so the error says why, not only "Command failed".
 */
export function d1(sql: string): string {
	try {
		return execFileSync(
			'npx',
			[
				'wrangler',
				'd1',
				'execute',
				'montra',
				'--local',
				'--persist-to',
				PERSIST,
				'--json',
				'--command',
				sql
			],
			{ encoding: 'utf8', env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] }
		);
	} catch (e) {
		const { stdout, stderr } = e as { stdout?: string; stderr?: string };
		const detail = [stderr, stdout].filter((s) => s?.trim()).join('\n');
		throw new Error(`wrangler d1 execute failed: ${detail || (e as Error).message}\nSQL: ${sql}`, {
			cause: e
		});
	}
}

/** The personal space id of the user with this e-mail (a fresh e2e user has exactly one space). */
export function spaceIdOf(email: string): string {
	const out = JSON.parse(
		d1(
			`select m.space_id as id from space_members m join users u on u.id = m.user_id where u.email = '${email}' limit 1`
		)
	) as { results: { id: string }[] }[];
	return out[0]!.results[0]!.id;
}
