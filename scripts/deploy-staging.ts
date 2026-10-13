/**
 * Guarded staging deploy (docs/RUNBOOK.md › Staging). The repository is public, so the committed `env.staging`
 * blocks carry placeholders for the account id, the D1 and KV ids and the app's custom domain. The real values come
 * from the environment (CI: the GitHub `staging` environment) or, for any unset there, from the gitignored
 * `.staging.env`; they are written into temporary `wrangler.staging.generated.jsonc` files next to each config,
 * which every wrangler call uses and which are removed afterwards.
 * Order: refuse on missing values or leftover placeholders, read the D1 Time Travel bookmark (printed; no bookmark,
 * no migration), apply remote migrations, build, then deploy jobs, inbound and app. The jobs Worker goes first: it
 * owns the queue consumer, the Workflow class and the DLQ, and the app Worker only produces to the queue, so the
 * consumer exists before the first message can be sent. Stops at the first failure.
 * `--dry-run` skips the Time Travel call and the migrations and passes `--dry-run` to every `wrangler deploy`.
 * `--skip-build` leaves out `vite build` and deploys the existing `.svelte-kit/cloudflare` output (CI builds in an
 * earlier step without the Cloudflare token).
 * `--write-config` only writes the generated configs and keeps them (no wrangler call), for hand-run staging commands
 * such as a Time Travel restore, `wrangler secret put` or `wrangler rollback` (`-c <generated> --env staging`).
 * The generated files are also removed on SIGINT/SIGTERM (the running wrangler call gets the same signal) and,
 * when left over from an earlier killed run, at the start of a deploy.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIGS = [
	'wrangler.jsonc',
	'workers/jobs/wrangler.jsonc',
	'workers/inbound/wrangler.jsonc'
] as const;
export const STAGING_ENV_FILE = '.staging.env';

const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Every real value a staging deploy needs, with the shape it must have. */
export const STAGING_VARS = {
	CLOUDFLARE_ACCOUNT_ID: HEX32,
	STAGING_D1_DATABASE_ID: UUID,
	STAGING_KV_CACHE_ID: HEX32,
	STAGING_APP_HOST: HOST
} as const;
/** Optional real values: unset leaves the committed empty value (FN-50 Turnstile stays off). */
export const OPTIONAL_STAGING_VARS = {
	STAGING_TURNSTILE_SITE_KEY: /^[0-9A-Za-z_-]{8,64}$/
} as const;
export type StagingValues = Record<keyof typeof STAGING_VARS, string> &
	Partial<Record<keyof typeof OPTIONAL_STAGING_VARS, string>>;

const PLACEHOLDER_D1 = /0{8}-0{4}-4000-8000-0{12}/;
const PLACEHOLDER_KV = /"id"\s*:\s*"0{32}"/;
const PLACEHOLDER_ACCOUNT = /"account_id"\s*:\s*"0{32}"/;
const PLACEHOLDER_HOST = 'staging.example.invalid';
const REAL_D1 =
	/"database_id"\s*:\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/;

/** The temporary config written next to `config` for the deploy (gitignored). */
export function generatedPath(config: string): string {
	return join(dirname(config), 'wrangler.staging.generated.jsonc');
}

/** `KEY=value` lines; blank lines and `#` comments are ignored. */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		const eq = line.indexOf('=');
		if (line.startsWith('#') || eq < 1) continue;
		out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

/** Each value from the environment, else from the file. Problems name the variable, never its value. */
export function resolveStagingValues(
	env: Record<string, string | undefined>,
	file: Record<string, string>
): { values: StagingValues; problems: string[] } {
	const values = {} as StagingValues;
	const problems: string[] = [];
	const all = [
		...Object.entries(STAGING_VARS).map(([n, s]) => [n, s, true] as const),
		...Object.entries(OPTIONAL_STAGING_VARS).map(([n, s]) => [n, s, false] as const)
	];
	for (const [name, shape, required] of all) {
		const value = env[name] || file[name] || '';
		if (!value) {
			if (required) problems.push(`${name} is not set (environment or ${STAGING_ENV_FILE})`);
			continue;
		}
		if (!shape.test(value) || /^[0-]+$/.test(value) || value === PLACEHOLDER_HOST)
			problems.push(`${name} does not have the expected form`);
		values[name as keyof StagingValues] = value;
	}
	return { values, problems };
}

/** Index of the `env.staging` block in a config's text, or -1. */
function stagingStart(text: string): number {
	const envAt = text.search(/"env"\s*:\s*\{/);
	const at = envAt < 0 ? -1 : text.slice(envAt).search(/"staging"\s*:\s*\{/);
	return at < 0 ? -1 : envAt + at;
}

/** The config with the placeholders inside `env.staging` replaced by the real values; the local block is kept. */
export function renderStaging(text: string, values: StagingValues): string {
	const at = stagingStart(text);
	if (at < 0) return text;
	const staging = text
		.slice(at)
		.replace(
			new RegExp(PLACEHOLDER_ACCOUNT, 'g'),
			`"account_id": "${values.CLOUDFLARE_ACCOUNT_ID}"`
		)
		.replace(new RegExp(PLACEHOLDER_D1, 'g'), values.STAGING_D1_DATABASE_ID)
		.replace(new RegExp(PLACEHOLDER_KV, 'g'), `"id": "${values.STAGING_KV_CACHE_ID}"`)
		.replaceAll(PLACEHOLDER_HOST, values.STAGING_APP_HOST)
		.replace(
			/"TURNSTILE_SITE_KEY"\s*:\s*""/g,
			`"TURNSTILE_SITE_KEY": "${values.STAGING_TURNSTILE_SITE_KEY ?? ''}"`
		);
	return text.slice(0, at) + staging;
}

/** Pure guard: one problem per config whose `env.staging` block is missing or still holds a placeholder. */
export function stagingProblems(configs: Record<string, string>, accountId: string): string[] {
	const problems: string[] = [];
	for (const [file, text] of Object.entries(configs)) {
		const at = stagingStart(text);
		if (at < 0) {
			problems.push(`${file}: no env.staging block`);
			continue;
		}
		const staging = text.slice(at);
		if (PLACEHOLDER_D1.test(staging)) problems.push(`${file}: placeholder D1 id in env.staging`);
		if (PLACEHOLDER_KV.test(staging)) problems.push(`${file}: placeholder KV id in env.staging`);
		if (PLACEHOLDER_ACCOUNT.test(staging))
			problems.push(`${file}: placeholder account_id in env.staging`);
		if (staging.includes(PLACEHOLDER_HOST))
			problems.push(`${file}: placeholder host in env.staging`);
		if (!REAL_D1.test(staging)) problems.push(`${file}: env.staging has no D1 database_id`);
		if (!staging.includes(`"account_id": "${accountId}"`))
			problems.push(`${file}: env.staging has no account_id`);
	}
	return problems;
}

/** The bookmark in `wrangler d1 time-travel info --json` output, or null. */
export function parseBookmark(stdout: string): string | null {
	return /"bookmark"\s*:\s*"([0-9a-f-]+)"/.exec(stdout)?.[1] ?? null;
}

type Step = { label: string; cmd: string; args: string[]; bookmark?: true };

export function buildSteps(dryRun: boolean, skipBuild = false): Step[] {
	const deploy = (label: string, config: string): Step => ({
		label,
		cmd: 'npx',
		args: [
			'wrangler',
			'deploy',
			'-c',
			generatedPath(config),
			'--env',
			'staging',
			...(dryRun ? ['--dry-run'] : [])
		]
	});
	const db = ['montra-staging', '-c', generatedPath('wrangler.jsonc'), '--env', 'staging'];
	const remote: Step[] = [
		{
			label: 'D1 Time Travel bookmark (rollback point)',
			cmd: 'npx',
			args: ['wrangler', 'd1', 'time-travel', 'info', ...db, '--json'],
			bookmark: true
		},
		{
			label: 'Apply remote migrations',
			cmd: 'npx',
			args: ['wrangler', 'd1', 'migrations', 'apply', ...db, '--remote']
		}
	];
	return [
		...(dryRun ? [] : remote),
		...(skipBuild ? [] : [{ label: 'Build app', cmd: 'npx', args: ['vite', 'build'] }]),
		deploy('Deploy jobs Worker (queue consumer, Workflow, cron)', 'workers/jobs/wrangler.jsonc'),
		deploy('Deploy inbound Worker', 'workers/inbound/wrangler.jsonc'),
		deploy('Deploy app Worker', 'wrangler.jsonc')
	];
}

const GENERATED = CONFIGS.map(generatedPath);
/** Exit codes after a signal, as a shell reports them (128 + signal number). */
export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;

export function removeGenerated(paths: readonly string[] = GENERATED): void {
	for (const p of paths) rmSync(p, { force: true });
}

type SignalHost = {
	on(signal: keyof typeof SIGNAL_EXIT, handler: () => void): unknown;
	exit(code: number): void;
};

/**
 * On SIGINT/SIGTERM: pass the signal to the running wrangler call, delete the generated configs (they hold the real
 * ids) and exit with 130/143. A killed run never leaves them behind.
 */
export function cleanUpOnSignals(
	host: SignalHost,
	paths: readonly string[],
	running: () => ChildProcess | undefined
): void {
	for (const signal of Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[])
		host.on(signal, () => {
			running()?.kill(signal);
			removeGenerated(paths);
			host.exit(SIGNAL_EXIT[signal]);
		});
}

let child: ChildProcess | undefined;

/** Runs one command; resolves with its exit code and, when `capture`, its stdout. */
function run(
	step: Step,
	env: NodeJS.ProcessEnv,
	capture: boolean
): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const proc = spawn(step.cmd, step.args, {
			env,
			stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit']
		});
		child = proc;
		let out = '';
		const done = (code: number) => {
			child = undefined;
			resolve({ code, out });
		};
		proc.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
		proc.on('error', () => done(1));
		proc.on('close', (code) => done(code ?? 1));
	});
}

async function runSteps(steps: Step[], dryRun: boolean, env: NodeJS.ProcessEnv): Promise<number> {
	for (const [i, step] of steps.entries()) {
		console.log(
			`\n[${i + 1}/${steps.length}] ${step.label}${dryRun ? ' (dry run)' : ''}\n$ ${step.cmd} ${step.args.join(' ')}`
		);
		const { code, out } = await run(step, env, step.bookmark === true);
		if (code !== 0) {
			console.error(`deploy:staging: step ${i + 1} failed (${step.label}); stopping.`);
			return 1;
		}
		if (!step.bookmark) continue;
		const bookmark = parseBookmark(out);
		if (!bookmark) {
			console.error(
				'deploy:staging: no Time Travel bookmark in the output; stopping before migrations.'
			);
			return 1;
		}
		// The CI workflow copies this exact line into the job summary.
		console.log(`deploy:staging: Time Travel bookmark ${bookmark}`);
	}
	return 0;
}

async function main(argv: string[]): Promise<number> {
	const dryRun = argv.includes('--dry-run');
	const skipBuild = argv.includes('--skip-build');
	const file = existsSync(STAGING_ENV_FILE)
		? parseEnvFile(readFileSync(STAGING_ENV_FILE, 'utf8'))
		: {};
	const { values, problems: missing } = resolveStagingValues(process.env, file);
	const rendered = Object.fromEntries(
		CONFIGS.map((f) => [f, renderStaging(readFileSync(f, 'utf8'), values)])
	);
	const problems =
		missing.length > 0 ? missing : stagingProblems(rendered, values.CLOUDFLARE_ACCOUNT_ID);
	// --skip-build trusts output built earlier in the same CI job; locally it could ship a stale or e2e build.
	if (skipBuild && process.env.CI !== 'true')
		problems.push(
			'--skip-build: only allowed in CI (CI=true), where the build runs in the same job'
		);
	else if (skipBuild && !existsSync('.svelte-kit/cloudflare/_worker.js'))
		problems.push(
			'--skip-build: no build output in .svelte-kit/cloudflare (run npm run build first)'
		);
	if (problems.length > 0) {
		console.error(
			'deploy:staging: refusing to run.\n' + problems.map((p) => `  - ${p}`).join('\n')
		);
		console.error('See docs/RUNBOOK.md › Staging.');
		return 1;
	}
	if (!values.STAGING_TURNSTILE_SITE_KEY)
		console.warn(
			'deploy:staging: STAGING_TURNSTILE_SITE_KEY is unset, so the Turnstile bot check stays off on staging.'
		);
	if (argv.includes('--write-config')) {
		for (const [f, text] of Object.entries(rendered)) writeFileSync(generatedPath(f), text);
		console.log(
			`deploy:staging: wrote ${GENERATED.join(', ')} (real ids; gitignored, delete when done).`
		);
		return 0;
	}
	const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID };
	cleanUpOnSignals(process, GENERATED, () => child);
	removeGenerated();
	let status: number;
	try {
		for (const [f, text] of Object.entries(rendered)) writeFileSync(generatedPath(f), text);
		status = await runSteps(buildSteps(dryRun, skipBuild), dryRun, env);
	} finally {
		removeGenerated();
	}
	if (status === 0)
		console.log(
			dryRun
				? '\ndeploy:staging: dry run finished; nothing was uploaded.'
				: '\ndeploy:staging: done.'
		);
	return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	process.exit(await main(process.argv.slice(2)));
