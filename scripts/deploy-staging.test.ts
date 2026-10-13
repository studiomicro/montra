import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	CONFIGS,
	SIGNAL_EXIT,
	buildSteps,
	cleanUpOnSignals,
	generatedPath,
	parseBookmark,
	parseEnvFile,
	removeGenerated,
	renderStaging,
	resolveStagingValues,
	stagingProblems,
	type StagingValues
} from './deploy-staging';

const committed = Object.fromEntries(CONFIGS.map((f) => [f, readFileSync(f, 'utf8')]));
// Fictional values of the right shape; the real ones live only in the environment or .staging.env.
const FAKE: StagingValues = {
	CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
	STAGING_D1_DATABASE_ID: '12345678-9abc-4def-8123-456789abcdef',
	STAGING_KV_CACHE_ID: 'b'.repeat(32),
	STAGING_APP_HOST: 'staging.fiktif.test'
};
const render = (v: StagingValues = FAKE) =>
	Object.fromEntries(Object.entries(committed).map(([f, t]) => [f, renderStaging(t, v)]));

describe('committed configs', () => {
	it('carry placeholders, never real staging values, so the guard refuses them as they are', () => {
		const p = stagingProblems(committed, FAKE.CLOUDFLARE_ACCOUNT_ID);
		for (const f of CONFIGS) expect(p).toContain(`${f}: placeholder D1 id in env.staging`);
		expect(p).toContain('wrangler.jsonc: placeholder KV id in env.staging');
		expect(p).toContain('wrangler.jsonc: placeholder host in env.staging');
		expect(p).toContain('workers/inbound/wrangler.jsonc: placeholder account_id in env.staging');
	});
});

describe('renderStaging', () => {
	it('fills every staging placeholder, so the guard accepts the result', () => {
		expect(stagingProblems(render(), FAKE.CLOUDFLARE_ACCOUNT_ID)).toEqual([]);
		const app = render()['wrangler.jsonc'] ?? '';
		expect(app).toContain('"pattern": "staging.fiktif.test"');
		expect(app).toContain('"GOOGLE_OAUTH_REDIRECT_ORIGIN": "https://staging.fiktif.test"');
		expect(app).toContain(`"id": "${FAKE.STAGING_KV_CACHE_ID}"`);
	});
	it('keeps the local top-level block on its placeholders', () => {
		const app = render()['wrangler.jsonc'] ?? '';
		const local = app.slice(0, app.search(/"env"\s*:\s*\{/));
		expect(local).toContain('00000000-0000-4000-8000-000000000000');
		expect(local).not.toContain(FAKE.STAGING_D1_DATABASE_ID);
	});
	it('leaves a config without env.staging unchanged, and the guard names it', () => {
		expect(renderStaging('{ "name": "x" }', FAKE)).toBe('{ "name": "x" }');
		expect(stagingProblems({ 'a.jsonc': '{ "name": "x" }' }, FAKE.CLOUDFLARE_ACCOUNT_ID)).toEqual([
			'a.jsonc: no env.staging block'
		]);
	});
	it('the guard rejects an account id other than the one given', () => {
		expect(stagingProblems(render(), 'c'.repeat(32))).toContain(
			'wrangler.jsonc: env.staging has no account_id'
		);
	});
});

describe('Turnstile site key (FN-50)', () => {
	it('stays empty (Turnstile off) when STAGING_TURNSTILE_SITE_KEY is unset', () => {
		expect(render()['wrangler.jsonc']).toMatch(/"env"[\s\S]*"TURNSTILE_SITE_KEY": ""/);
	});
	it('is filled into the staging vars only when set', () => {
		const key = '0x4AAAAAAAfiktifSiteKey';
		const app = render({ ...FAKE, STAGING_TURNSTILE_SITE_KEY: key })['wrangler.jsonc'] ?? '';
		const at = app.search(/"env"\s*:\s*\{/);
		expect(app.slice(at)).toContain(`"TURNSTILE_SITE_KEY": "${key}"`);
		expect(app.slice(0, at)).not.toContain(key);
	});
	it('is optional but must have the expected form when set', () => {
		const env: Record<string, string> = { ...FAKE };
		expect(resolveStagingValues(env, {}).problems).toEqual([]);
		expect(
			resolveStagingValues({ ...env, STAGING_TURNSTILE_SITE_KEY: 'x"; evil' }, {}).problems
		).toEqual(['STAGING_TURNSTILE_SITE_KEY does not have the expected form']);
	});
});

describe('cleanUpOnSignals', () => {
	const setup = () => {
		const dir = mkdtempSync(join(tmpdir(), 'deploy-staging-'));
		const paths = [join(dir, 'a.jsonc'), join(dir, 'b.jsonc')];
		for (const p of paths) writeFileSync(p, '{"account_id": "real"}');
		const host = Object.assign(new EventEmitter(), { exit: vi.fn() });
		const kill = vi.fn();
		cleanUpOnSignals(host, paths, () => ({ kill }) as never);
		return { paths, host, kill };
	};
	for (const signal of ['SIGINT', 'SIGTERM'] as const)
		it(`${signal}: passes the signal on, deletes the generated configs, exits ${SIGNAL_EXIT[signal]}`, () => {
			const { paths, host, kill } = setup();
			host.emit(signal);
			expect(kill).toHaveBeenCalledWith(signal);
			expect(paths.some((p) => existsSync(p))).toBe(false);
			expect(host.exit).toHaveBeenCalledWith(SIGNAL_EXIT[signal]);
		});
	it('without a running command still deletes and exits', () => {
		const dir = mkdtempSync(join(tmpdir(), 'deploy-staging-'));
		const p = join(dir, 'c.jsonc');
		writeFileSync(p, '{}');
		const host = Object.assign(new EventEmitter(), { exit: vi.fn() });
		cleanUpOnSignals(host, [p], () => undefined);
		host.emit('SIGINT');
		expect(existsSync(p)).toBe(false);
		expect(host.exit).toHaveBeenCalledWith(130);
	});
	it('removeGenerated ignores files that are already gone', () => {
		expect(() => removeGenerated([join(tmpdir(), 'nie-ada-deploy-staging.jsonc')])).not.toThrow();
	});
});

describe('resolveStagingValues', () => {
	const env: Record<string, string> = { ...FAKE };
	it('prefers the environment over the file', () => {
		const { values, problems } = resolveStagingValues(env, {
			STAGING_APP_HOST: 'lain.fiktif.test'
		});
		expect(problems).toEqual([]);
		expect(values.STAGING_APP_HOST).toBe('staging.fiktif.test');
	});
	it('falls back to the file per variable', () => {
		const { values, problems } = resolveStagingValues(
			{ ...env, STAGING_KV_CACHE_ID: '' },
			{ STAGING_KV_CACHE_ID: FAKE.STAGING_KV_CACHE_ID }
		);
		expect(problems).toEqual([]);
		expect(values.STAGING_KV_CACHE_ID).toBe(FAKE.STAGING_KV_CACHE_ID);
	});
	it('names a missing or malformed variable without echoing its value', () => {
		const { problems } = resolveStagingValues(
			{
				CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
				STAGING_D1_DATABASE_ID: 'not-a-uuid',
				STAGING_APP_HOST: 'staging.example.invalid'
			},
			{}
		);
		expect(problems).toEqual([
			'CLOUDFLARE_ACCOUNT_ID does not have the expected form',
			'STAGING_D1_DATABASE_ID does not have the expected form',
			'STAGING_KV_CACHE_ID is not set (environment or .staging.env)',
			'STAGING_APP_HOST does not have the expected form'
		]);
		expect(problems.join(' ')).not.toContain('not-a-uuid');
	});
	it('rejects a host with a scheme or path, or without a dot', () => {
		for (const host of ['https://staging.fiktif.test', 'staging.fiktif.test/x', 'localhost'])
			expect(resolveStagingValues({ ...env, STAGING_APP_HOST: host }, {}).problems).toEqual([
				'STAGING_APP_HOST does not have the expected form'
			]);
	});
});

describe('parseEnvFile', () => {
	it('reads KEY=value lines and skips comments, blanks and broken lines', () => {
		expect(parseEnvFile('# c\n\nA=1\n B = two \nbroken\n=x\n')).toEqual({ A: '1', B: 'two' });
	});
});

describe('parseBookmark', () => {
	it('reads the bookmark from wrangler --json output', () => {
		const b = '00000001-00000000-00004e7a-0123456789abcdef0123456789abcdef';
		expect(parseBookmark(`{\n  "bookmark": "${b}"\n}`)).toBe(b);
	});
	it('returns null without one', () => {
		expect(parseBookmark('✘ [ERROR] Authentication error')).toBeNull();
	});
});

describe('buildSteps', () => {
	it('orders bookmark, migrations, build, jobs before app', () => {
		const labels = buildSteps(false).map((s) => s.label);
		expect(labels[0]).toMatch(/Time Travel/);
		expect(labels[1]).toMatch(/migrations/);
		expect(labels[2]).toMatch(/Build/);
		expect(labels.findIndex((l) => l.includes('jobs'))).toBeLessThan(
			labels.findIndex((l) => l.includes('app Worker'))
		);
	});
	it('points every wrangler call at a generated staging config, never a committed one', () => {
		const wrangler = buildSteps(false).filter((s) => s.args[0] === 'wrangler');
		expect(wrangler).toHaveLength(5);
		for (const s of wrangler) {
			expect(s.args[s.args.indexOf('-c') + 1]).toMatch(/wrangler\.staging\.generated\.jsonc$/);
			expect(s.args.slice(s.args.indexOf('--env'), s.args.indexOf('--env') + 2)).toEqual([
				'--env',
				'staging'
			]);
		}
		expect(generatedPath('workers/jobs/wrangler.jsonc')).toBe(
			'workers/jobs/wrangler.staging.generated.jsonc'
		);
	});
	it('asks Time Travel for JSON so the bookmark can be read', () => {
		expect(buildSteps(false)[0]?.args).toContain('--json');
	});
	it('--skip-build leaves out vite build and keeps every remote step and deploy', () => {
		const labels = buildSteps(false, true).map((s) => s.label);
		expect(labels.some((l) => l.includes('Build'))).toBe(false);
		expect(labels).toHaveLength(5);
	});
	it('dry run skips remote steps and passes --dry-run to deploys', () => {
		const steps = buildSteps(true);
		expect(steps.some((s) => s.args.includes('--remote') || s.args.includes('time-travel'))).toBe(
			false
		);
		expect(
			steps.filter((s) => s.args[1] === 'deploy').every((s) => s.args.includes('--dry-run'))
		).toBe(true);
	});
});
