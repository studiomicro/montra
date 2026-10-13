# FN-00 Foundation + Component Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An empty Montra app that runs on Cloudflare: SvelteKit 3 app Worker serving the app host and the site
host, jobs and inbound Worker skeletons, D1 + Drizzle, i18n, theme, CSP, app shell with the floating tab bar, the
design-system component kit with a `/dev/ui` preview, and green `npm run gates` + `npm run test:e2e`.

**Architecture:** One npm package. `src/` is the SvelteKit app (config lives in `vite.config.ts` — SvelteKit 3 no
longer reads `svelte.config.js`). `src/lib/shared` is pure TypeScript shared by the browser and all three Workers,
imported through the package.json subpath import `#lib/*` (SvelteKit 3 replaces `$lib` aliases with subpath
imports). `workers/jobs` and `workers/inbound` are separate Workers with their own `wrangler.jsonc` and
`tsconfig.json`. All three Workers share one local state directory, so they see the same local D1 and Queues.

**Tech Stack:** Svelte 5.57, SvelteKit 3.0.1, `@sveltejs/adapter-cloudflare` 8.0.0, Vite 8.3, Tailwind CSS 4.3,
TypeScript 6.0, Vitest 5.0, Playwright 1.63, wrangler 4.148, drizzle-orm 0.45 / drizzle-kit 0.31, zod 4.6, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-07-fn-00-foundation-design.md` (read it before starting any task).

## Global Constraints

- Node ≥ 22 (`.npmrc` has `engine-strict=true`); local Node is 24, so `node script.ts` runs TypeScript directly
  (type stripping). Scripts use only erasable TypeScript syntax (no `enum`, no parameter properties).
- SvelteKit config goes in `sveltekit({...})` inside `vite.config.ts`. Never create `svelte.config.js`.
- Imports of shared code use `#lib/...` (package.json `imports`). Never add a Vite or Kit `alias`.
- `src/lib/shared/**` must not import from `$app/*`, `$env/*`, `cloudflare:*`, `svelte`, or use DOM/Worker globals.
- Every user-facing Indonesian string goes through `tr()` / `trf()` (or `msg()` for static tables); every one needs
  an entry in `src/lib/shared/i18n-en.ts`.
- No `style="..."` attributes and no `style:` directives in `.svelte` files: the CSP has no `'unsafe-inline'`
  for styles. Use classes and scoped `<style>` blocks; set dynamic values with SVG attributes or
  `element.style.setProperty` inside an action.
- Colours only through tokens from `docs/design/tokens.css` (`var(--ink)` or Tailwind `text-ink`, `bg-panel`, …).
  Never a hex literal in a component.
- Money is an integer `amount_minor` with an ISO 4217 currency and the ISO exponent (IDR = 2, so Rp 25.000 is
  `2500000`). Never floats for stored money. Display only through `#lib/shared/money-format`.
- Currency text: `Rp 1.264.000` (NBSP after `Rp`), compact `Rp5,24 jt`, expense `−Rp 25.000` (U+2212), income
  `+Rp 9.500.000`.
- `getPlatformProxy` and the adapter's `platformProxy` always use `remoteBindings: false`. No command in this plan
  touches a remote Cloudflare resource; never pass `--remote`.
- D1 placeholder ids are the same in all three configs:
  `database_name: "montra"`, `database_id: "00000000-0000-4000-8000-000000000000"`.
- `compatibility_date: "2026-10-01"` in all three `wrangler.jsonc` files.
- Prettier: tabs, single quotes, print width 100 (matches the existing repo files).
- Commits: Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.

## Review Focus

1. **Concurrent requests in different languages.** One Worker isolate serves many requests at once; a module-level
   "current locale" would leak English into an Indonesian response. Expected: the locale is per request. Test in
   Task 2 (`two translators do not share state`).
2. **Host edge cases.** `SITE.localhost:8787`, a trailing dot, and `/site/...` requested on the app host. Expected:
   site host matches case-insensitively and ignores the port; `/site/*` on the app host is a 404. Tests in Task 4.
3. **Money given a float or an unsafe integer** (`12.5`, `2 ** 60`, `-0`). Expected: the formatter throws a
   `RangeError` for non-integers and unsafe integers, and `-0` prints like `0` with no sign. Tests in Task 7.
4. **Seed or reset pointed at a remote database** (`--remote`, `--env staging`, `-e=staging`, `--env=production`).
   Expected: the script refuses before running wrangler. Tests in Task 5.
5. **Inline styles silently blocked by CSP in production.** Expected: a test fails when any `.svelte` file has a
   `style=` attribute or a `style:` directive; e2e fails on any CSP console violation. Tests in Task 3 and Task 12.

## Parallelism

Task 1 first. Then Tasks 2, 5, 6, 7 are independent of each other (different directories); Task 3 needs Task 2;
Task 4 needs Task 3; Task 8 needs Tasks 2–4 and 7; Tasks 9 and 10 need Task 8; Task 11 needs Task 6 and 8; Task 12
needs all earlier tasks; Task 13 last.

---

### Task 1: Toolchain scaffold (SvelteKit 3 + Cloudflare + Tailwind + lint + Vitest)

**Files:**
- Modify: `package.json`, `.gitignore`
- Create: `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`,
  `.prettierignore`, `wrangler.jsonc`, `.dev.vars.example`, `src/app.html`, `src/app.css`, `src/app.d.ts`,
  `src/routes/+layout.svelte`, `src/routes/+page.svelte` (temporary), `src/lib/shared/sanity.ts`
- Generated (committed): `src/worker-configuration.d.ts`
- Test: `src/lib/shared/sanity.test.ts`

**Interfaces:**
- Produces: `npm run check|lint|test|build|gates` scripts; `#lib/*` import path; `App.Platform.env: Env` (from the
  generated `src/worker-configuration.d.ts`); bindings `DB`, `FILES`, `CACHE`, `JOBS_QUEUE`, `STATS`, `ASSETS`.

- [ ] **Step 1: Add scripts, subpath imports and the Workers types package**

Edit `package.json`: keep `name`, `private`, `version`, `type`, `engines`, `dependencies`, `devDependencies`; add:

```json
	"imports": {
		"#lib": "./src/lib",
		"#lib/*": "./src/lib/*"
	},
	"scripts": {
		"dev": "vite dev",
		"check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --fail-on-warnings && tsc -p workers/jobs/tsconfig.json && tsc -p workers/inbound/tsconfig.json",
		"lint": "prettier --check . && eslint .",
		"format": "prettier --write .",
		"test": "vitest run",
		"test:e2e": "playwright test",
		"build": "vite build",
		"gates": "npm run check && npm run lint && npm run test && npm run build",
		"types:cf": "wrangler types src/worker-configuration.d.ts && wrangler types -c workers/jobs/wrangler.jsonc workers/jobs/worker-configuration.d.ts && wrangler types -c workers/inbound/wrangler.jsonc workers/inbound/worker-configuration.d.ts",
		"dev:workers": "wrangler dev -c wrangler.jsonc -c workers/jobs/wrangler.jsonc -c workers/inbound/wrangler.jsonc --persist-to .wrangler/state",
		"db:generate": "drizzle-kit generate",
		"db:migrate:local": "node scripts/migrate-local.ts",
		"db:seed:local": "node scripts/seed-local.ts",
		"db:reset:local": "node scripts/reset-local.ts",
		"deploy:staging": "node scripts/deploy-staging.ts"
	},
```

The `check` script references the worker tsconfigs created in Tasks 6 and 11; until then, run
`svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` directly in this task. The `db:*` and
`deploy:staging` scripts are created in Tasks 5 and 13.

Run: `npm install -D @cloudflare/workers-types@5.20261007.1`
Expected: added to `devDependencies` (it is already in `node_modules` as a transitive dependency).

- [ ] **Step 2: Write `vite.config.ts`**

```ts
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			adapter: adapter({
				platformProxy: { remoteBindings: false }
			})
		})
	]
});
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
	"extends": "$app/tsconfig",
	"compilerOptions": {
		"strict": true,
		"allowJs": true,
		"checkJs": true,
		"skipLibCheck": true,
		"noUncheckedIndexedAccess": true,
		"forceConsistentCasingInFileNames": true
	},
	"include": ["src", "test", "e2e", "scripts", "*.ts"],
	"exclude": ["src/service-worker"]
}
```

Run: `npx svelte-kit sync`
Expected: no error. If SvelteKit prints a tsconfig validation message, apply exactly what it asks (it names the
missing `types` or `paths` entry) and rerun.

- [ ] **Step 4: Write `wrangler.jsonc` (app Worker)**

```jsonc
{
	"$schema": "./node_modules/wrangler/config-schema.json",
	"name": "financer-app",
	"main": ".svelte-kit/cloudflare/_worker.js",
	"compatibility_date": "2026-10-01",
	"compatibility_flags": ["nodejs_als"],
	"assets": { "binding": "ASSETS", "directory": ".svelte-kit/cloudflare" },
	"observability": { "enabled": true },
	"vars": { "APP_VERSION": "0.0.1" },
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "montra",
			"database_id": "00000000-0000-4000-8000-000000000000",
			"migrations_dir": "migrations"
		}
	],
	"r2_buckets": [{ "binding": "FILES", "bucket_name": "financer-files" }],
	"kv_namespaces": [{ "binding": "CACHE", "id": "00000000000000000000000000000000" }],
	"queues": { "producers": [{ "binding": "JOBS_QUEUE", "queue": "financer-jobs" }] },
	"analytics_engine_datasets": [{ "binding": "STATS", "dataset": "financer_stats" }]
}
```

`.dev.vars.example`:

```
# Local-only variables for `wrangler dev`. Copy to .dev.vars. Names only; never commit real values.
# DEV_ROUTES=1 enables /dev/ui and /api/v1/dev/* (local development and e2e only; never set in staging or production).
DEV_ROUTES=1
```

Append to `.gitignore`: `.wrangler/e2e-state` is already covered by `.wrangler`; add nothing else.

Run: `npx wrangler types src/worker-configuration.d.ts`
Expected: file written; it declares `interface Env` with `DB: D1Database`, `FILES: R2Bucket`, `CACHE: KVNamespace`,
`JOBS_QUEUE: Queue`, `STATS: AnalyticsEngineDataset`, `ASSETS: Fetcher`, `APP_VERSION: "0.0.1"`.

- [ ] **Step 5: Write `src/app.d.ts`, `src/app.html`, `src/app.css`**

`src/app.d.ts`:

```ts
import type { Locale } from '#lib/shared/i18n';
import type { ThemePref } from '#lib/server/prefs';

declare global {
	namespace App {
		interface Locals {
			locale: Locale;
			theme: ThemePref;
		}
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}
	}
}

export {};
```

The two imported types are created in Tasks 2 and 3. Until then use this temporary version and replace it in Task 3:

```ts
declare global {
	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}
	}
}

export {};
```

`src/app.html`:

```html
<!doctype html>
<html lang="%fin.lang%" data-theme="%fin.theme%">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
		<meta name="color-scheme" content="light dark" />
		<link rel="icon" href="%sveltekit.assets%/favicon.svg" />
		%sveltekit.head%
	</head>
	<body data-sveltekit-preload-data="hover">
		<div class="app-root">%sveltekit.body%</div>
	</body>
</html>
```

Create `static/favicon.svg` (placeholder mark, no brand art):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#171717"/><path d="M10 9h12v3H13.5v3H20v3h-6.5v5H10z" fill="#fff"/></svg>
```

`src/app.css`:

```css
@import 'tailwindcss';
@import '../docs/design/tokens.css';

html {
	background: var(--bg);
	color: var(--ink);
	font-family: var(--font);
	font-size: 17px;
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
	-webkit-text-size-adjust: 100%;
}

body {
	margin: 0;
	min-height: 100dvh;
}

:focus-visible {
	outline: 2px solid var(--brand);
	outline-offset: 2px;
}

.num {
	font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
	*,
	*::before,
	*::after {
		animation-duration: 0.01ms !important;
		transition-duration: 0.01ms !important;
		scroll-behavior: auto !important;
	}
}
```

`src/routes/+layout.svelte` (replaced in Task 3):

```svelte
<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

{@render children()}
```

`src/routes/+page.svelte` (temporary; deleted in Task 8):

```svelte
<h1>Montra</h1>
```

Until Task 3 adds the hook that fills them, `%fin.lang%` and `%fin.theme%` render literally; that is expected.

- [ ] **Step 6: Lint and format config**

`.prettierrc`:

```json
{
	"useTabs": true,
	"singleQuote": true,
	"trailingComma": "none",
	"printWidth": 100,
	"plugins": ["prettier-plugin-svelte", "prettier-plugin-tailwindcss"],
	"overrides": [{ "files": "*.svelte", "options": { "parser": "svelte" } }],
	"tailwindStylesheet": "./src/app.css"
}
```

`.prettierignore`:

```
docs/
.claude/
CLAUDE.md
package-lock.json
.svelte-kit/
.wrangler/
build/
test-results/
playwright-report/
migrations/
**/worker-configuration.d.ts
```

`eslint.config.js`:

```js
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	{
		ignores: [
			'.svelte-kit/',
			'.wrangler/',
			'build/',
			'docs/',
			'migrations/',
			'test-results/',
			'playwright-report/',
			'**/worker-configuration.d.ts'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: { 'no-undef': 'off' }
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: ts.parser } }
	}
);
```

- [ ] **Step 7: Vitest config and a sanity test (TDD loop proves the runner works)**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: [
			'src/**/*.test.ts',
			'workers/**/*.test.ts',
			'scripts/**/*.test.ts',
			'test/**/*.test.ts'
		],
		environment: 'node',
		testTimeout: 30_000
	}
});
```

`src/lib/shared/sanity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { appName } from '#lib/shared/sanity';

describe('toolchain', () => {
	it('resolves #lib subpath imports', () => {
		expect(appName()).toBe('Montra');
	});
});
```

Run: `npx vitest run src/lib/shared/sanity.test.ts`
Expected: FAIL — cannot resolve `#lib/shared/sanity`.

`src/lib/shared/sanity.ts`:

```ts
/** Product name shown in the UI. Owner decision pending (docs/TASKS.md); change it here only. */
export function appName(): string {
	return 'Montra';
}
```

Run: `npx vitest run src/lib/shared/sanity.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the gates that exist so far**

Run: `npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings`
Expected: `0 errors and 0 warnings`.

Run: `npx prettier --write . && npm run lint`
Expected: exit 0.

Run: `npm run build`
Expected: exit 0 and `.svelte-kit/cloudflare/_worker.js` exists.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "build: scaffold SvelteKit 3 on Cloudflare with Tailwind, lint and Vitest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: i18n (`tr`, `trf`, `msg`, locale resolution, coverage test)

**Files:**
- Create: `src/lib/shared/i18n.ts`, `src/lib/shared/i18n-en.ts`, `src/lib/ui/i18n-context.ts`
- Test: `src/lib/shared/i18n.test.ts`, `test/i18n-coverage.test.ts`

**Interfaces:**
- Produces:
  - `type Locale = 'id' | 'en'`
  - `createTranslator(locale: Locale): { locale: Locale; tr(phrase: string): string; trf(template: string, values: Record<string, string | number>): string }`
  - `type Translator = ReturnType<typeof createTranslator>`
  - `msg(phrase: string): string` — identity marker for static tables (scanned by the coverage test)
  - `resolveLocale(cookie: string | undefined, acceptLanguage: string | null): Locale`
  - `en: Record<string, string>` in `i18n-en.ts`
  - `setI18n(t: Translator): void` and `useI18n(): Translator` in `#lib/ui/i18n-context` (Svelte context)

- [ ] **Step 1: Write the failing unit tests**

`src/lib/shared/i18n.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTranslator, msg, resolveLocale } from '#lib/shared/i18n';

describe('createTranslator', () => {
	it('returns the Indonesian phrase for id', () => {
		expect(createTranslator('id').tr('Beranda')).toBe('Beranda');
	});

	it('returns the English entry for en', () => {
		expect(createTranslator('en').tr('Beranda')).toBe('Home');
	});

	it('falls back to the Indonesian phrase when English is missing', () => {
		expect(createTranslator('en').tr('Frasa yang tidak ada')).toBe('Frasa yang tidak ada');
	});

	it('substitutes named placeholders only', () => {
		const t = createTranslator('id');
		expect(t.trf('{n} transaksi', { n: 3 })).toBe('3 transaksi');
		expect(t.trf('{n} transaksi', { n: '<b>' })).toBe('<b> transaksi');
		expect(t.trf('{a} dan {b}', { a: 'x' })).toBe('x dan {b}');
	});

	it('translates the template before substituting', () => {
		expect(createTranslator('en').trf('{n} transaksi', { n: 2 })).toBe('2 transactions');
	});

	it('two translators do not share state', () => {
		const id = createTranslator('id');
		const en = createTranslator('en');
		expect(en.tr('Beranda')).toBe('Home');
		expect(id.tr('Beranda')).toBe('Beranda');
		expect(en.tr('Beranda')).toBe('Home');
	});
});

describe('msg', () => {
	it('is the identity', () => {
		expect(msg('Riwayat')).toBe('Riwayat');
	});
});

describe('resolveLocale', () => {
	it('prefers a valid cookie', () => {
		expect(resolveLocale('en', 'id-ID,id;q=0.9')).toBe('en');
	});
	it('ignores an invalid cookie', () => {
		expect(resolveLocale('fr', null)).toBe('id');
	});
	it('reads Accept-Language when no cookie', () => {
		expect(resolveLocale(undefined, 'en-US,en;q=0.9')).toBe('en');
		expect(resolveLocale(undefined, 'id-ID,en;q=0.5')).toBe('id');
	});
	it('defaults to id', () => {
		expect(resolveLocale(undefined, null)).toBe('id');
		expect(resolveLocale(undefined, 'fr-FR')).toBe('id');
	});
});
```

Run: `npx vitest run src/lib/shared/i18n.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `i18n.ts` and the first English entries**

`src/lib/shared/i18n-en.ts`:

```ts
/** English for every Indonesian phrase passed to tr(), trf() or msg(). Key = the exact Indonesian phrase. */
export const en: Record<string, string> = {
	Beranda: 'Home',
	'{n} transaksi': '{n} transactions'
};
```

`src/lib/shared/i18n.ts`:

```ts
import { en } from './i18n-en';

export type Locale = 'id' | 'en';

const LOCALES: readonly Locale[] = ['id', 'en'];

function isLocale(value: string | undefined | null): value is Locale {
	return value === 'id' || value === 'en';
}

/** Marks a phrase in a static table for translation; translate it later with tr(). */
export function msg(phrase: string): string {
	return phrase;
}

/** A translator bound to one locale. Create one per request (server) or per page (client); never share one. */
export function createTranslator(locale: Locale) {
	const table: Record<string, string> = locale === 'en' ? en : {};

	function tr(phrase: string): string {
		return table[phrase] ?? phrase;
	}

	function trf(template: string, values: Record<string, string | number>): string {
		return tr(template).replace(/\{(\w+)\}/g, (whole, name: string) =>
			Object.hasOwn(values, name) ? String(values[name]) : whole
		);
	}

	return { locale, tr, trf };
}

export type Translator = ReturnType<typeof createTranslator>;

/** Cookie `lang` wins; then the first supported language in Accept-Language; then Indonesian. */
export function resolveLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
	if (isLocale(cookie)) return cookie;
	if (acceptLanguage) {
		for (const part of acceptLanguage.split(',')) {
			const tag = part.split(';')[0]?.trim().toLowerCase().split('-')[0];
			if (isLocale(tag)) return tag;
		}
	}
	return LOCALES[0] as Locale;
}
```

Run: `npx vitest run src/lib/shared/i18n.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the coverage test**

`test/i18n-coverage.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '#lib/shared/i18n-en';

const CALL = /\b(?:tr|trf|msg)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile() && /\.(svelte|ts)$/.test(d.name) && !d.name.endsWith('.test.ts'))
		.map((d) => join(d.parentPath, d.name));
}

export function phrasesIn(text: string): string[] {
	return [...text.matchAll(CALL)].map((m) => (m[2] ?? '').replace(/\\(['"])/g, '$1'));
}

describe('i18n coverage', () => {
	it('extracts phrases from tr, trf and msg calls', () => {
		expect(phrasesIn(`tr('A') trf("B {n}", {n}) msg('C\\'s') str('X')`)).toEqual(['A', 'B {n}', "C's"]);
	});

	it('every Indonesian phrase has an English entry', () => {
		const missing = new Set<string>();
		for (const dir of ['src', 'workers']) {
			for (const file of sourceFiles(dir)) {
				for (const phrase of phrasesIn(readFileSync(file, 'utf8'))) {
					if (!Object.hasOwn(en, phrase)) missing.add(`${phrase}  (${file})`);
				}
			}
		}
		expect([...missing]).toEqual([]);
	});

	it('reports unused English entries without failing', () => {
		const used = new Set<string>();
		for (const dir of ['src', 'workers']) {
			for (const file of sourceFiles(dir)) phrasesIn(readFileSync(file, 'utf8')).forEach((p) => used.add(p));
		}
		const unused = Object.keys(en).filter((k) => !used.has(k));
		if (unused.length > 0) console.warn(`i18n: unused English entries: ${unused.join(' | ')}`);
		expect(true).toBe(true);
	});
});
```

Run: `npx vitest run test/i18n-coverage.test.ts`
Expected: PASS (the only calls so far are in tests, which are excluded); a warning lists `Beranda` and
`{n} transaksi` as unused until Task 8 uses them.

- [ ] **Step 4: Svelte context helper**

`src/lib/ui/i18n-context.ts`:

```ts
import { getContext, setContext } from 'svelte';
import type { Translator } from '#lib/shared/i18n';

const KEY = Symbol('i18n');

export function setI18n(translator: Translator): void {
	setContext(KEY, translator);
}

export function useI18n(): Translator {
	const t = getContext<Translator | undefined>(KEY);
	if (!t) throw new Error('useI18n() called outside the root layout');
	return t;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/i18n.ts src/lib/shared/i18n-en.ts src/lib/shared/i18n.test.ts src/lib/ui/i18n-context.ts test/i18n-coverage.test.ts
git commit -m "feat(i18n): per-request translator with English coverage test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Request hooks — locale, theme, security headers, CSP

**Files:**
- Create: `src/lib/server/prefs.ts`, `src/lib/server/security-headers.ts`, `src/hooks.server.ts`,
  `src/routes/+layout.server.ts`
- Modify: `vite.config.ts` (CSP), `src/app.d.ts` (final version from Task 1 Step 5), `src/routes/+layout.svelte`
- Test: `src/lib/server/prefs.test.ts`, `src/lib/server/security-headers.test.ts`, `test/no-inline-style.test.ts`

**Interfaces:**
- Consumes: `resolveLocale`, `createTranslator`, `Locale` (Task 2); `setI18n` (Task 2).
- Produces:
  - `type ThemePref = 'system' | 'light' | 'dark'`; `resolveTheme(cookie: string | undefined): ThemePref`
  - `securityHeaders(): Record<string, string>`
  - `event.locals.locale`, `event.locals.theme`; root layout data `{ locale: Locale; theme: ThemePref }`
  - Root layout sets the i18n context, so every component can call `useI18n()`.

- [ ] **Step 1: Failing tests**

`src/lib/server/prefs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveTheme } from '#lib/server/prefs';

describe('resolveTheme', () => {
	it('accepts light, dark and system', () => {
		expect(resolveTheme('light')).toBe('light');
		expect(resolveTheme('dark')).toBe('dark');
		expect(resolveTheme('system')).toBe('system');
	});
	it('falls back to system for anything else', () => {
		expect(resolveTheme(undefined)).toBe('system');
		expect(resolveTheme('"><script>')).toBe('system');
	});
});
```

`src/lib/server/security-headers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '#lib/server/security-headers';

describe('securityHeaders', () => {
	it('returns the hardening headers from the spec', () => {
		expect(securityHeaders()).toEqual({
			'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'strict-origin-when-cross-origin',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Permissions-Policy': 'microphone=(self), camera=(self), geolocation=()'
		});
	});
});
```

`test/no-inline-style.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const INLINE_STYLE = /<[a-zA-Z][^>]*\s(style=|style:)/;

describe('CSP: no inline styles in markup', () => {
	it('detects a style attribute and a style directive', () => {
		expect(INLINE_STYLE.test('<div style="color:red">')).toBe(true);
		expect(INLINE_STYLE.test('<div style:color={c}>')).toBe(true);
		expect(INLINE_STYLE.test('<div class="x">')).toBe(false);
	});

	it('no .svelte file uses style= or style:', () => {
		const offenders = readdirSync('src', { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith('.svelte'))
			.map((d) => join(d.parentPath, d.name))
			.filter((f) => {
				const markup = readFileSync(f, 'utf8').replace(/<style[\s\S]*?<\/style>/g, '');
				return INLINE_STYLE.test(markup);
			});
		expect(offenders).toEqual([]);
	});
});
```

Run: `npx vitest run src/lib/server test/no-inline-style.test.ts`
Expected: FAIL — modules `prefs` and `security-headers` not found (the inline-style test passes).

- [ ] **Step 2: Implement**

`src/lib/server/prefs.ts`:

```ts
export type ThemePref = 'system' | 'light' | 'dark';

export function resolveTheme(cookie: string | undefined): ThemePref {
	return cookie === 'light' || cookie === 'dark' ? cookie : 'system';
}
```

`src/lib/server/security-headers.ts`:

```ts
/** Headers set on every response. The CSP itself comes from SvelteKit (`csp` in vite.config.ts). */
export function securityHeaders(): Record<string, string> {
	return {
		'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'strict-origin-when-cross-origin',
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Permissions-Policy': 'microphone=(self), camera=(self), geolocation=()'
	};
}
```

Run: `npx vitest run src/lib/server`
Expected: PASS.

- [ ] **Step 3: Hook, layout data, CSP**

`src/hooks.server.ts`:

```ts
import type { Handle } from '@sveltejs/kit';
import { resolveLocale } from '#lib/shared/i18n';
import { resolveTheme } from '#lib/server/prefs';
import { securityHeaders } from '#lib/server/security-headers';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.locale = resolveLocale(
		event.cookies.get('lang'),
		event.request.headers.get('accept-language')
	);
	event.locals.theme = resolveTheme(event.cookies.get('theme'));

	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('%fin.lang%', event.locals.locale).replace('%fin.theme%', event.locals.theme)
	});

	for (const [name, value] of Object.entries(securityHeaders())) {
		if (!response.headers.has(name)) response.headers.set(name, value);
	}
	return response;
};
```

`src/routes/+layout.server.ts`:

```ts
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({
	locale: locals.locale,
	theme: locals.theme
});
```

`src/routes/+layout.svelte`:

```svelte
<script lang="ts">
	import '../app.css';
	import { createTranslator } from '#lib/shared/i18n';
	import { setI18n } from '#lib/ui/i18n-context';

	let { data, children } = $props();
	// Locale changes need a full reload (cookie + navigation), so reading it once is correct.
	// svelte-ignore state_referenced_locally
	setI18n(createTranslator(data.locale));
</script>

{@render children()}
```

Replace `src/app.d.ts` with the final version from Task 1 Step 5.

In `vite.config.ts`, add `csp` to the `sveltekit({...})` options:

```ts
		sveltekit({
			adapter: adapter({
				platformProxy: { remoteBindings: false }
			}),
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self'],
					'img-src': ['self', 'data:'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['none'],
					'frame-ancestors': ['none'],
					'form-action': ['self']
				}
			}
		})
```

- [ ] **Step 4: Verify in a running server**

Run: `npm run build && npx wrangler dev --port 8787` (background), then
`curl -sI http://localhost:8787/ | grep -iE 'content-security|strict-transport|permissions|x-content'` and
`curl -s -H 'Cookie: lang=en; theme=dark' http://localhost:8787/ | head -3`.
Expected: the CSP header contains `script-src 'self' 'nonce-…'` and `frame-ancestors 'none'`; the four other headers
are present; the HTML starts with `<html lang="en" data-theme="dark">`. Stop the server.

If `style-src 'self'` blocks Vite's injected styles in `npm run dev`, that is dev-only; SvelteKit relaxes style-src
in dev. Production (wrangler) must have no violation — Task 12 asserts that.

- [ ] **Step 5: Gates and commit**

Run: `npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings && npm run lint && npm test`
Expected: all pass.

```bash
git add -A
git commit -m "feat(core): locale and theme hooks, security headers and strict CSP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Two hosts — `reroute` to the site tree

**Files:**
- Create: `src/lib/shared/hosts.ts`, `src/hooks.ts`
- Test: `src/lib/shared/hosts.test.ts`

**Interfaces:**
- Produces:
  - `SITE_HOSTS: readonly string[]` (`['site.localhost']`; production domains added when the owner picks them)
  - `isSiteHost(hostname: string): boolean`
  - `routeFor(url: URL): string` — the internal pathname SvelteKit should resolve
  - `appOriginForSite(hostname: string, port: string, protocol: string): string` — app link target from the site

- [ ] **Step 1: Failing test**

`src/lib/shared/hosts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { appOriginForSite, isSiteHost, routeFor } from '#lib/shared/hosts';

const u = (s: string) => new URL(s);

describe('isSiteHost', () => {
	it('matches site.localhost case-insensitively, ignoring port and a trailing dot', () => {
		expect(isSiteHost(u('http://SITE.localhost:8787/').hostname)).toBe(true);
		expect(isSiteHost('site.localhost.')).toBe(true);
	});
	it('does not match the app host or look-alikes', () => {
		expect(isSiteHost('localhost')).toBe(false);
		expect(isSiteHost('evil-site.localhost')).toBe(false);
		expect(isSiteHost('site.localhost.evil.com')).toBe(false);
	});
});

describe('routeFor', () => {
	it('maps site host paths into /site', () => {
		expect(routeFor(u('http://site.localhost:8787/'))).toBe('/site');
		expect(routeFor(u('http://site.localhost:8787/privasi'))).toBe('/site/privasi');
		expect(routeFor(u('http://site.localhost:8787/blog/a-b'))).toBe('/site/blog/a-b');
	});
	it('leaves app paths alone', () => {
		expect(routeFor(u('http://localhost:8787/'))).toBe('/');
		expect(routeFor(u('http://localhost:8787/riwayat'))).toBe('/riwayat');
	});
	it('hides the site tree on the app host', () => {
		expect(routeFor(u('http://localhost:8787/site'))).toBe('/__not_found');
		expect(routeFor(u('http://localhost:8787/site/privasi'))).toBe('/__not_found');
		expect(routeFor(u('http://localhost:8787/SITE/privasi'))).toBe('/__not_found');
	});
	it('does not hide app paths that merely start with "site"', () => {
		expect(routeFor(u('http://localhost:8787/sitemap.xml'))).toBe('/sitemap.xml');
	});
	it('leaves SvelteKit internals alone on the site host', () => {
		expect(routeFor(u('http://site.localhost:8787/_app/version.json'))).toBe('/_app/version.json');
		expect(routeFor(u('http://site.localhost:8787/api/v1/health'))).toBe('/api/v1/health');
	});
});

describe('appOriginForSite', () => {
	it('drops the site. prefix locally and keeps the port', () => {
		expect(appOriginForSite('site.localhost', '8787', 'http:')).toBe('http://localhost:8787');
	});
});
```

Run: `npx vitest run src/lib/shared/hosts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

`src/lib/shared/hosts.ts`:

```ts
/**
 * Hosts that serve the public site (the rest serve the app). The production domains are an owner decision
 * (docs/TASKS.md); add them here when chosen, together with their app host in APP_HOST_FOR_SITE.
 */
export const SITE_HOSTS: readonly string[] = ['site.localhost'];

const APP_HOST_FOR_SITE: Readonly<Record<string, string>> = { 'site.localhost': 'localhost' };

function normalize(hostname: string): string {
	return hostname.toLowerCase().replace(/\.$/, '');
}

export function isSiteHost(hostname: string): boolean {
	return SITE_HOSTS.includes(normalize(hostname));
}

const PASSTHROUGH = /^\/(_app|api)(\/|$)/;

/** Internal pathname for SvelteKit routing. Unknown internal path → no route → 404. */
export function routeFor(url: URL): string {
	const path = url.pathname;
	if (isSiteHost(url.hostname)) {
		if (PASSTHROUGH.test(path)) return path;
		return path === '/' ? '/site' : `/site${path}`;
	}
	if (/^\/site(\/|$)/i.test(path)) return '/__not_found';
	return path;
}

export function appOriginForSite(hostname: string, port: string, protocol: string): string {
	const appHost = APP_HOST_FOR_SITE[normalize(hostname)] ?? normalize(hostname);
	return `${protocol}//${appHost}${port ? `:${port}` : ''}`;
}
```

`src/hooks.ts`:

```ts
import type { Reroute } from '@sveltejs/kit';
import { routeFor } from '#lib/shared/hosts';

export const reroute: Reroute = ({ url }) => routeFor(url);
```

Run: `npx vitest run src/lib/shared/hosts.test.ts`
Expected: PASS.

- [ ] **Step 3: Check that wrangler dev keeps the Host header**

Run: `npm run build && npx wrangler dev --port 8787` (background), then
`curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: site.localhost:8787' http://localhost:8787/privasi`.
Expected: `404` for now (the site routes arrive in Task 8), and the wrangler log shows the request reached the Worker.
Then add a temporary `console.log(url.hostname)` in `reroute`, rebuild, repeat, and confirm the log prints
`site.localhost`. Remove the log. If it prints `localhost` instead, stop and report: the site-host e2e approach needs
`--local-upstream` (see `npx wrangler dev --help`), and the plan's Task 12 webServer command must add it.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shared/hosts.ts src/lib/shared/hosts.test.ts src/hooks.ts
git commit -m "feat(core): serve the public site on its own host via reroute

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: D1 + Drizzle, health endpoint, local migrate/seed/reset

**Files:**
- Create: `drizzle.config.ts`, `src/lib/server/db/schema.ts`, `src/lib/server/db/index.ts`,
  `src/lib/server/health.ts`, `src/routes/api/v1/health/+server.ts`, `migrations/0000_init.sql` (generated),
  `scripts/local-guard.ts`, `scripts/migrate-local.ts`, `scripts/seed-local.ts`, `scripts/reset-local.ts`,
  `test/helpers/d1.ts`
- Test: `scripts/local-guard.test.ts`, `src/lib/server/health.test.ts`

**Interfaces:**
- Produces:
  - `appMeta` Drizzle table: `key TEXT PK`, `value TEXT NOT NULL`, `updated_at INTEGER NOT NULL` (UTC ms)
  - `getDb(d1: D1Database)` → Drizzle instance with `schema`
  - `checkHealth(db: D1Database, version: string): Promise<{ status: 200 | 503; body: { ok: boolean; db: boolean; version: string } }>`
  - `assertLocalOnly(argv: readonly string[]): void` — throws `Error('Refusing: …')`
  - `LOCAL_STATE_DIR = '.wrangler/state'`
  - Test helper `withLocalD1(fn: (db: D1Database) => Promise<void>): Promise<void>` — fresh in-memory D1 with all
    migrations applied.

- [ ] **Step 1: Schema, config, migration**

`src/lib/server/db/schema.ts`:

```ts
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Small key/value table for app-level markers (demo seed, last queue ping). Not user data. */
export const appMeta = sqliteTable('app_meta', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at').notNull()
});
```

`src/lib/server/db/index.ts`:

```ts
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function getDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export { schema };
```

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	schema: './src/lib/server/db/schema.ts',
	out: './migrations'
});
```

Run: `npx drizzle-kit generate --name init`
Expected: `migrations/0000_init.sql` containing `CREATE TABLE \`app_meta\`` and a `migrations/meta/` folder. Wrangler
applies only `*.sql` files in `migrations/`, in name order; `meta/` is drizzle-kit's bookkeeping and stays committed.

- [ ] **Step 2: Failing guard test**

`scripts/local-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertLocalOnly } from './local-guard';

describe('assertLocalOnly', () => {
	it('allows plain local runs', () => {
		expect(() => assertLocalOnly([])).not.toThrow();
		expect(() => assertLocalOnly(['--verbose'])).not.toThrow();
	});
	it.each([
		['--remote'],
		['--env', 'staging'],
		['--env=production'],
		['-e', 'staging'],
		['-e=staging'],
		['--preview']
	])('refuses %s', (...args) => {
		expect(() => assertLocalOnly(args)).toThrow(/Refusing/);
	});
});
```

Run: `npx vitest run scripts/local-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Guard and scripts**

`scripts/local-guard.ts`:

```ts
export const LOCAL_STATE_DIR = '.wrangler/state';

const FORBIDDEN = /^(--remote|--preview|--env|-e)(=.*)?$/;

/** Seed and reset only ever touch the local D1. Any flag that could point elsewhere stops the script. */
export function assertLocalOnly(argv: readonly string[]): void {
	const bad = argv.find((a) => FORBIDDEN.test(a));
	if (bad) throw new Error(`Refusing: "${bad}" is not allowed; this script only touches the local database.`);
}
```

`scripts/migrate-local.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { assertLocalOnly, LOCAL_STATE_DIR } from './local-guard.ts';

assertLocalOnly(process.argv.slice(2));
const persistTo = process.env.FIN_PERSIST_TO ?? LOCAL_STATE_DIR;
execFileSync(
	'npx',
	['wrangler', 'd1', 'migrations', 'apply', 'montra', '--local', '--persist-to', persistTo],
	{ stdio: 'inherit', env: { ...process.env, CI: 'true' } }
);
```

`scripts/seed-local.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { assertLocalOnly, LOCAL_STATE_DIR } from './local-guard.ts';

assertLocalOnly(process.argv.slice(2));
const persistTo = process.env.FIN_PERSIST_TO ?? LOCAL_STATE_DIR;
// Fictional demo data only; marked so later FNs can badge it "Data demo" and exclude it from real totals.
const sql =
	"INSERT INTO app_meta (key, value, updated_at) VALUES ('demo_seed', 'v1', 0) " +
	'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;';
execFileSync(
	'npx',
	['wrangler', 'd1', 'execute', 'montra', '--local', '--persist-to', persistTo, '--command', sql],
	{ stdio: 'inherit', env: { ...process.env, CI: 'true' } }
);
```

`scripts/reset-local.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { assertLocalOnly, LOCAL_STATE_DIR } from './local-guard.ts';

const args = process.argv.slice(2);
assertLocalOnly(args);
const persistTo = process.env.FIN_PERSIST_TO ?? LOCAL_STATE_DIR;
const root = resolve('.wrangler');
const target = resolve(persistTo, 'v3', 'd1');
if (!target.startsWith(root + sep)) throw new Error(`Refusing: ${target} is outside ${root}`);

rmSync(target, { recursive: true, force: true });
console.log(`Removed local D1 state at ${target}`);
execFileSync('node', ['scripts/migrate-local.ts', ...args], { stdio: 'inherit' });
execFileSync('node', ['scripts/seed-local.ts', ...args], { stdio: 'inherit' });
```

Run: `npx vitest run scripts/local-guard.test.ts`
Expected: PASS.

Run: `npm run db:reset:local`
Expected: "Removed local D1 state…", migration `0000_init.sql` applied, seed `1 command executed successfully`
(exact wording may differ; exit code 0).

Run: `npx wrangler d1 execute montra --local --persist-to .wrangler/state --command "SELECT key, value FROM app_meta"`
Expected: one row `demo_seed | v1`.

Run: `node scripts/seed-local.ts --remote; echo "exit=$?"`
Expected: `Refusing: "--remote" is not allowed…` and `exit=1`.

- [ ] **Step 4: Failing health test with a real local D1**

`test/helpers/d1.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';

/** Fresh, non-persisted local D1 (workerd) with every migration applied. Never remote. */
export async function withLocalD1(fn: (db: D1Database) => Promise<void>): Promise<void> {
	const proxy = await getPlatformProxy<{ DB: D1Database }>({
		configPath: 'wrangler.jsonc',
		persist: false,
		remoteBindings: false
	});
	try {
		const db = proxy.env.DB;
		for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
			const statements = readFileSync(`migrations/${file}`, 'utf8')
				.split('--> statement-breakpoint')
				.map((s) => s.trim())
				.filter(Boolean);
			for (const statement of statements) await db.prepare(statement).run();
		}
		await fn(db);
	} finally {
		await proxy.dispose();
	}
}
```

`src/lib/server/health.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkHealth } from '#lib/server/health';
import { withLocalD1 } from '../../../test/helpers/d1';

describe('checkHealth', () => {
	it('reports db true against local D1', async () => {
		await withLocalD1(async (db) => {
			const result = await checkHealth(db, '0.0.1');
			expect(result).toEqual({ status: 200, body: { ok: true, db: true, version: '0.0.1' } });
		});
	});

	it('reports 503 without details when the database fails', async () => {
		const broken = {
			prepare: () => ({
				first: async () => {
					throw new Error('D1_ERROR: secret detail /path/to/thing');
				}
			})
		} as unknown as D1Database;
		const result = await checkHealth(broken, '0.0.1');
		expect(result).toEqual({ status: 503, body: { ok: false, db: false, version: '0.0.1' } });
		expect(JSON.stringify(result)).not.toContain('secret');
	});
});
```

Run: `npx vitest run src/lib/server/health.test.ts`
Expected: FAIL — `#lib/server/health` not found.

- [ ] **Step 5: Implement health and the route**

`src/lib/server/health.ts`:

```ts
export interface HealthBody {
	ok: boolean;
	db: boolean;
	version: string;
}

/** Liveness plus a D1 round trip. Never includes error text or env values. */
export async function checkHealth(
	db: D1Database,
	version: string
): Promise<{ status: 200 | 503; body: HealthBody }> {
	try {
		await db.prepare('SELECT 1 AS ok').first();
		return { status: 200, body: { ok: true, db: true, version } };
	} catch {
		return { status: 503, body: { ok: false, db: false, version } };
	}
}
```

`src/routes/api/v1/health/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import { checkHealth } from '#lib/server/health';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform }) => {
	if (!platform) return json({ ok: false, db: false, version: 'unknown' }, { status: 503 });
	const { status, body } = await checkHealth(platform.env.DB, platform.env.APP_VERSION);
	return json(body, { status, headers: { 'cache-control': 'no-store' } });
};
```

Run: `npx vitest run src/lib/server/health.test.ts`
Expected: PASS (first run downloads nothing; workerd is already installed).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): D1 + Drizzle with app_meta, health endpoint, guarded local migrate/seed/reset

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: jobs Worker skeleton (cron, queue consumer, Workflow stub)

**Files:**
- Create: `workers/jobs/wrangler.jsonc`, `workers/jobs/tsconfig.json`, `workers/jobs/src/index.ts`,
  `workers/jobs/src/queue.ts`, `workers/jobs/src/cron.ts`, `workers/jobs/src/statement-workflow.ts`,
  `src/lib/shared/jobs.ts`
- Generated (committed): `workers/jobs/worker-configuration.d.ts`
- Test: `workers/jobs/src/queue.test.ts`, `workers/jobs/src/cron.test.ts`

**Interfaces:**
- Produces:
  - `jobMessage` zod schema and `type JobMessage = { type: 'ping'; id: string }` in `#lib/shared/jobs`
  - `handleBatch(batch: { messages: readonly QueueMessageLike[] }, deps: JobDeps): Promise<void>`
  - `interface QueueMessageLike { body: unknown; attempts: number; ack(): void; retry(): void }`
  - `interface JobDeps { recordPing(id: string): Promise<void> }`
  - `cronUtcHours(expr: string): number[]`, `utcToWibHours(hours: number[]): number[]`
  - `JOBS_CRON = '0 23,0-16 * * *'`
  - D1 key `app_meta.last_ping` holds the last ping id (read by Task 11's dev route).

- [ ] **Step 1: Shared message schema**

`src/lib/shared/jobs.ts`:

```ts
import { z } from 'zod';

/** Every message on JOBS_QUEUE. Add new job types here as a new union member. */
export const jobMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ping'), id: z.string().min(1).max(64) })
]);

export type JobMessage = z.infer<typeof jobMessage>;
```

- [ ] **Step 2: Failing tests**

`workers/jobs/src/queue.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { handleBatch, type QueueMessageLike } from './queue';

function message(body: unknown): QueueMessageLike & { acked: boolean; retried: boolean } {
	const m = {
		body,
		attempts: 1,
		acked: false,
		retried: false,
		ack() {
			m.acked = true;
		},
		retry() {
			m.retried = true;
		}
	};
	return m;
}

describe('handleBatch', () => {
	it('records and acks a ping', async () => {
		const recordPing = vi.fn(async () => {});
		const m = message({ type: 'ping', id: 'abc' });
		await handleBatch({ messages: [m] }, { recordPing });
		expect(recordPing).toHaveBeenCalledWith('abc');
		expect(m.acked).toBe(true);
		expect(m.retried).toBe(false);
	});

	it('retries an unknown type without throwing', async () => {
		const m = message({ type: 'mystery' });
		await handleBatch({ messages: [m] }, { recordPing: vi.fn() });
		expect(m.retried).toBe(true);
		expect(m.acked).toBe(false);
	});

	it('retries invalid bodies (null, string, oversized id) without throwing', async () => {
		const bad = [message(null), message('ping'), message({ type: 'ping', id: 'x'.repeat(65) })];
		await handleBatch({ messages: bad }, { recordPing: vi.fn() });
		expect(bad.every((m) => m.retried && !m.acked)).toBe(true);
	});

	it('retries when the dependency fails and still handles the next message', async () => {
		const recordPing = vi
			.fn<(id: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('db down'))
			.mockResolvedValueOnce(undefined);
		const a = message({ type: 'ping', id: 'a' });
		const b = message({ type: 'ping', id: 'b' });
		await handleBatch({ messages: [a, b] }, { recordPing });
		expect(a.retried).toBe(true);
		expect(b.acked).toBe(true);
	});
});
```

`workers/jobs/src/cron.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cronUtcHours, JOBS_CRON, utcToWibHours } from './cron';

describe('jobs cron', () => {
	it('parses the hour field', () => {
		expect(cronUtcHours('0 23,0-16 * * *')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 23]);
	});

	it('runs hourly from 06:00 to 23:00 WIB exactly', () => {
		const wib = utcToWibHours(cronUtcHours(JOBS_CRON));
		expect(wib).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
	});

	it('the wrangler config uses the same expression', async () => {
		const { readFileSync } = await import('node:fs');
		expect(readFileSync('workers/jobs/wrangler.jsonc', 'utf8')).toContain(`"${JOBS_CRON}"`);
	});
});
```

Run: `npx vitest run workers/jobs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement queue, cron, workflow, entry**

`workers/jobs/src/queue.ts`:

```ts
import { jobMessage } from '#lib/shared/jobs';

export interface QueueMessageLike {
	body: unknown;
	attempts: number;
	ack(): void;
	retry(): void;
}

export interface JobDeps {
	recordPing(id: string): Promise<void>;
}

/** Ack what succeeds; retry what fails. After max_retries the queue moves a message to the DLQ. Never logs bodies. */
export async function handleBatch(
	batch: { messages: readonly QueueMessageLike[] },
	deps: JobDeps
): Promise<void> {
	for (const m of batch.messages) {
		const parsed = jobMessage.safeParse(m.body);
		if (!parsed.success) {
			console.warn('jobs: invalid message', { attempts: m.attempts });
			m.retry();
			continue;
		}
		try {
			switch (parsed.data.type) {
				case 'ping':
					await deps.recordPing(parsed.data.id);
					break;
			}
			m.ack();
		} catch {
			console.warn('jobs: handler failed', { type: parsed.data.type, attempts: m.attempts });
			m.retry();
		}
	}
}
```

`workers/jobs/src/cron.ts`:

```ts
/** Hourly 06:00–23:00 WIB (UTC+7). Cron Triggers run in UTC. Keep in sync with workers/jobs/wrangler.jsonc. */
export const JOBS_CRON = '0 23,0-16 * * *';

export function cronUtcHours(expr: string): number[] {
	const field = expr.trim().split(/\s+/)[1] ?? '';
	const hours = new Set<number>();
	for (const part of field.split(',')) {
		const [from, to] = part.split('-').map(Number);
		if (from === undefined || Number.isNaN(from)) continue;
		for (let h = from; h <= (to ?? from); h++) hours.add(h);
	}
	return [...hours].sort((a, b) => a - b);
}

export function utcToWibHours(hours: number[]): number[] {
	return hours.map((h) => (h + 7) % 24).sort((a, b) => a - b);
}
```

`workers/jobs/src/statement-workflow.ts`:

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

/** Placeholder for FN-16 statement reading. One step proves the binding and class export. */
export class StatementWorkflow extends WorkflowEntrypoint<Env, { importId: string }> {
	async run(event: WorkflowEvent<{ importId: string }>, step: WorkflowStep) {
		return step.do('noop', async () => ({ importId: event.payload.importId, ok: true }));
	}
}
```

`workers/jobs/src/index.ts`:

```ts
import { handleBatch } from './queue';

export { StatementWorkflow } from './statement-workflow';

export default {
	async queue(batch, env) {
		await handleBatch(batch, {
			async recordPing(id) {
				await env.DB.prepare(
					"INSERT INTO app_meta (key, value, updated_at) VALUES ('last_ping', ?1, ?2) " +
						'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
				)
					.bind(id, Date.now())
					.run();
			}
		});
	},

	async scheduled(controller) {
		console.log('jobs: heartbeat', { cron: controller.cron, at: controller.scheduledTime });
	}
} satisfies ExportedHandler<Env>;
```

`workers/jobs/wrangler.jsonc`:

```jsonc
{
	"$schema": "../../node_modules/wrangler/config-schema.json",
	"name": "financer-jobs",
	"main": "src/index.ts",
	"compatibility_date": "2026-10-01",
	"observability": { "enabled": true },
	"triggers": { "crons": ["0 23,0-16 * * *"] },
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "montra",
			"database_id": "00000000-0000-4000-8000-000000000000",
			"migrations_dir": "../../migrations"
		}
	],
	"r2_buckets": [{ "binding": "FILES", "bucket_name": "financer-files" }],
	"analytics_engine_datasets": [{ "binding": "STATS", "dataset": "financer_stats" }],
	"queues": {
		"consumers": [
			{
				"queue": "financer-jobs",
				"max_batch_size": 10,
				"max_retries": 3,
				"dead_letter_queue": "financer-jobs-dlq"
			}
		]
	},
	"workflows": [
		{ "name": "financer-statement", "binding": "WORKFLOW_STATEMENT", "class_name": "StatementWorkflow" }
	]
}
```

`workers/jobs/tsconfig.json`:

```json
{
	"compilerOptions": {
		"target": "ES2023",
		"module": "ESNext",
		"moduleResolution": "Bundler",
		"lib": ["ES2023"],
		"types": [],
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"skipLibCheck": true,
		"noEmit": true,
		"isolatedModules": true
	},
	"include": ["worker-configuration.d.ts", "src/**/*.ts", "../../src/lib/shared/**/*.ts"],
	"exclude": ["src/**/*.test.ts", "../../src/lib/shared/**/*.test.ts"]
}
```

Run: `npx wrangler types -c workers/jobs/wrangler.jsonc workers/jobs/worker-configuration.d.ts`
Expected: file written with `DB`, `FILES`, `STATS`, `WORKFLOW_STATEMENT: Workflow<…>` in `Env`.

Run: `npx vitest run workers/jobs && npx tsc -p workers/jobs/tsconfig.json`
Expected: tests PASS; tsc exits 0. If `ExportedHandler<Env>` rejects the `queue` parameter types, annotate
`batch: MessageBatch<unknown>` — `MessageBatch` messages satisfy `QueueMessageLike`.

- [ ] **Step 4: Local smoke**

Run: `npx wrangler dev -c workers/jobs/wrangler.jsonc --persist-to .wrangler/state --test-scheduled --port 8788`
(background), then `curl -s "http://localhost:8788/__scheduled?cron=0+23,0-16+*+*+*"`.
Expected: the wrangler log shows `jobs: heartbeat`. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(jobs): jobs Worker with WIB cron, validated queue consumer and Workflow stub

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Money formatter + contrast-safe tokens

**Files:**
- Create: `src/lib/shared/money-format.ts`, `src/lib/shared/contrast.ts`
- Modify: `docs/design/tokens.css` (three light-theme values), `docs/design/DESIGN_SYSTEM.md` (colour table +
  change log)
- Test: `src/lib/shared/money-format.test.ts`, `test/contrast.test.ts`

**Interfaces:**
- Produces:
  - `currencyExponent(currency: string): number`
  - `formatMoney(minor: number, currency?: string, sign?: 'auto' | 'signed'): string`
  - `formatMoneyCompact(minor: number, currency?: string): string`
  - `contrastRatio(a: string, b: string): number`; `readTokens(css: string, selector: string): Record<string, string>`

- [ ] **Step 1: Failing money tests**

`src/lib/shared/money-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { currencyExponent, formatMoney, formatMoneyCompact } from '#lib/shared/money-format';

const NBSP = ' ';
const MINUS = '−';

describe('currencyExponent', () => {
	it('uses ISO 4217 exponents', () => {
		expect(currencyExponent('IDR')).toBe(2);
		expect(currencyExponent('USD')).toBe(2);
		expect(currencyExponent('JPY')).toBe(0);
		expect(currencyExponent('KWD')).toBe(3);
		expect(currencyExponent('XYZ')).toBe(2);
	});
});

describe('formatMoney', () => {
	it.each([
		[0, `Rp${NBSP}0`],
		[2_500_000, `Rp${NBSP}25.000`],
		[126_400_000, `Rp${NBSP}1.264.000`],
		[125_000_050, `Rp${NBSP}1.250.000,50`],
		[5, `Rp${NBSP}0,05`],
		[-2_500_000, `${MINUS}Rp${NBSP}25.000`]
	])('IDR %i → %s', (minor, text) => {
		expect(formatMoney(minor)).toBe(text);
	});

	it('signs income and expense when asked', () => {
		expect(formatMoney(950_000_000, 'IDR', 'signed')).toBe(`+Rp${NBSP}9.500.000`);
		expect(formatMoney(-2_500_000, 'IDR', 'signed')).toBe(`${MINUS}Rp${NBSP}25.000`);
		expect(formatMoney(0, 'IDR', 'signed')).toBe(`Rp${NBSP}0`);
	});

	it('treats -0 as 0', () => {
		expect(formatMoney(-0, 'IDR', 'signed')).toBe(`Rp${NBSP}0`);
	});

	it('formats other currencies with their code and exponent', () => {
		expect(formatMoney(1999, 'USD')).toBe(`USD${NBSP}19,99`);
		expect(formatMoney(1500, 'JPY')).toBe(`JPY${NBSP}1.500`);
	});

	it('rejects floats and unsafe integers', () => {
		expect(() => formatMoney(12.5)).toThrow(RangeError);
		expect(() => formatMoney(2 ** 60)).toThrow(RangeError);
		expect(() => formatMoney(Number.NaN)).toThrow(RangeError);
	});
});

describe('formatMoneyCompact', () => {
	it.each([
		[95_000, `Rp950`],
		[18_700_000, `Rp187${NBSP}rb`],
		[99_999_900, `Rp999${NBSP}rb`],
		[100_000_000, `Rp1${NBSP}jt`],
		[524_000_000, `Rp5,24${NBSP}jt`],
		[1_250_000_000, `Rp12,5${NBSP}jt`],
		[12_500_000_000, `Rp125${NBSP}jt`],
		[320_000_000_000, `Rp3,2${NBSP}M`],
		[-524_000_000, `${MINUS}Rp5,24${NBSP}jt`]
	])('IDR %i → %s', (minor, text) => {
		expect(formatMoneyCompact(minor)).toBe(text);
	});

	it('never rounds up past the true value', () => {
		expect(formatMoneyCompact(529_900_000)).toBe(`Rp5,29${NBSP}jt`);
	});

	it('falls back to the full format for other currencies', () => {
		expect(formatMoneyCompact(1999, 'USD')).toBe(`USD${NBSP}19,99`);
	});
});
```

Run: `npx vitest run src/lib/shared/money-format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement the formatter**

`src/lib/shared/money-format.ts`:

```ts
const NBSP = ' ';
const MINUS = '−';

const EXPONENTS: Readonly<Record<string, number>> = {
	IDR: 2,
	USD: 2,
	EUR: 2,
	SGD: 2,
	MYR: 2,
	AUD: 2,
	GBP: 2,
	JPY: 0,
	KRW: 0,
	VND: 0,
	BHD: 3,
	KWD: 3,
	OMR: 3
};

const SYMBOLS: Readonly<Record<string, string>> = { IDR: 'Rp' };

/** ISO 4217 minor-unit exponent; unknown codes default to 2. */
export function currencyExponent(currency: string): number {
	return EXPONENTS[currency] ?? 2;
}

function assertMinor(minor: number): void {
	if (!Number.isSafeInteger(minor)) throw new RangeError('amount_minor must be a safe integer');
}

function group(digits: string): string {
	return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** `Rp 1.264.000` (NBSP), sen only when non-zero, `−` U+2212 for negatives, `+` for income when signed. */
export function formatMoney(
	minor: number,
	currency = 'IDR',
	sign: 'auto' | 'signed' = 'auto'
): string {
	assertMinor(minor);
	const exp = currencyExponent(currency);
	const abs = BigInt(Math.abs(minor));
	const base = 10n ** BigInt(exp);
	const whole = group((abs / base).toString());
	const frac = abs % base;
	const fracText = frac === 0n ? '' : ',' + frac.toString().padStart(exp, '0');
	const body = `${SYMBOLS[currency] ?? currency}${NBSP}${whole}${fracText}`;
	if (minor < 0) return MINUS + body;
	if (sign === 'signed' && minor > 0) return '+' + body;
	return body;
}

const UNITS: readonly { size: bigint; label: string }[] = [
	{ size: 1_000_000_000_000n, label: 'T' },
	{ size: 1_000_000_000n, label: 'M' },
	{ size: 1_000_000n, label: 'jt' },
	{ size: 1_000n, label: 'rb' }
];

/** `Rp5,24 jt`, `Rp187 rb`: three significant digits, truncated (never overstates). IDR only. */
export function formatMoneyCompact(minor: number, currency = 'IDR'): string {
	assertMinor(minor);
	if (currency !== 'IDR') return formatMoney(minor, currency);
	const rupiah = BigInt(Math.abs(minor)) / 100n;
	const prefix = minor < 0 ? MINUS : '';
	const unit = UNITS.find((u) => rupiah >= u.size);
	if (!unit) return `${prefix}Rp${rupiah.toString()}`;
	const whole = rupiah / unit.size;
	const decimals = whole >= 100n ? 0 : whole >= 10n ? 1 : 2;
	const scaled = (rupiah * 10n ** BigInt(decimals)) / unit.size;
	let text = scaled.toString();
	if (decimals > 0) {
		const intPart = text.slice(0, -decimals) || '0';
		const fracPart = text.slice(-decimals).replace(/0+$/, '');
		text = fracPart ? `${intPart},${fracPart}` : intPart;
	}
	return `${prefix}Rp${text}${NBSP}${unit.label}`;
}
```

Run: `npx vitest run src/lib/shared/money-format.test.ts`
Expected: PASS.

- [ ] **Step 3: Failing contrast test**

`src/lib/shared/contrast.ts` is created in Step 4; write the test first.

`test/contrast.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, readTokens } from '#lib/shared/contrast';

const css = readFileSync('docs/design/tokens.css', 'utf8');
const light = readTokens(css, ':root {');
const dark = { ...light, ...readTokens(css, ":root[data-theme='dark'] {") };

const TEXT_PAIRS: [string, string][] = [
	['--ink', '--bg'],
	['--ink-2', '--bg'],
	['--muted', '--bg'],
	['--muted', '--panel'],
	['--money-in', '--bg'],
	['--money-in', '--panel'],
	['--money-up', '--bg'],
	['--money-up', '--panel'],
	['--same', '--bg'],
	['--brand', '--bg'],
	['--on-dark', '--dark'],
	['--on-dark-muted', '--dark']
];

describe('contrastRatio', () => {
	it('matches known values', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
		expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
	});
});

describe.each([
	['light', light],
	['dark', dark]
])('AA text contrast (%s)', (_name, tokens) => {
	it.each(TEXT_PAIRS)('%s on %s ≥ 4.5', (fg, bg) => {
		const a = tokens[fg];
		const b = tokens[bg];
		expect(a, fg).toBeDefined();
		expect(b, bg).toBeDefined();
		expect(contrastRatio(a as string, b as string)).toBeGreaterThanOrEqual(4.5);
	});
});
```

- [ ] **Step 4: Implement the contrast helpers**

`src/lib/shared/contrast.ts`:

```ts
function luminance(hex: string): number {
	const h = hex.replace('#', '');
	const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
	const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
		number,
		number,
		number
	];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio for two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** Hex custom properties declared in the first block that starts with `selector`. */
export function readTokens(css: string, selector: string): Record<string, string> {
	const start = css.indexOf(selector);
	if (start < 0) throw new Error(`selector not found: ${selector}`);
	const block = css.slice(start, css.indexOf('}', start));
	const tokens: Record<string, string> = {};
	for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
		tokens[m[1] as string] = (m[2] as string).toLowerCase();
	}
	return tokens;
}
```

Run: `npx vitest run test/contrast.test.ts`
Expected: FAIL in light for `--money-in` (3.47 on bg), `--money-up` (3.91), `--same` (4.49). Dark passes.

- [ ] **Step 5: Fix the three light tokens (smallest change that passes AA on bg and panel)**

In `docs/design/tokens.css`, inside the first `:root {` block only:

```css
	--money-in: #16813a; /* income, "lebih hemat" (spent less); AA on bg and panel */
	--money-up: #cf3339; /* spent more than last month, over budget, errors; AA on bg and panel */
	--same: #5b52e0; /* "hampir sama" (about the same as last month); AA on bg and panel */
```

In `docs/design/DESIGN_SYSTEM.md`, update the Light column for `--money-in` (`#16813A`), `--money-up` (`#CF3339`),
`--same` (`#5B52E0`), and append to `## Change log`:

```markdown
- **v1.1 (2026-10-07)** — FN-00 contrast test: light `--money-in`, `--money-up` and `--same` darkened to meet WCAG AA
  (4.5:1) for 16 px amount text on `--bg` and `--panel`. Dark theme unchanged.
```

Run: `npx vitest run test/contrast.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(design): shared money formatter and AA contrast gate for tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: App shell and site shell

**Files:**
- Create: `src/lib/ui/Icon.svelte`, `src/lib/ui/shell/nav.ts`, `src/lib/ui/shell/TabBar.svelte`,
  `src/lib/ui/shell/Sidebar.svelte`, `src/lib/ui/shell/Sheet.svelte`, `src/lib/ui/shell/ScreenTitle.svelte`,
  `src/lib/ui/shell/EmptyState.svelte`, `src/lib/ui/shell/AddSheet.svelte`,
  `src/routes/(app)/+layout.svelte`, `src/routes/(app)/+page.svelte` (Beranda),
  `src/routes/(app)/riwayat/+page.svelte`, `src/routes/(app)/laporan/+page.svelte`,
  `src/routes/(app)/kekayaan/+page.svelte`, `src/routes/(app)/[stub=stub]/+page.svelte`,
  `src/params/stub.ts`, `src/routes/(app)/+error.svelte`,
  `src/routes/(site)/site/+layout.svelte`, `src/routes/(site)/site/+layout.server.ts`,
  `src/routes/(site)/site/+page.svelte`, `src/routes/(site)/site/blog/+page.svelte`,
  `src/routes/(site)/site/[legal=legal]/+page.svelte`, `src/params/legal.ts`, `src/routes/(site)/site/+error.svelte`
- Delete: `src/routes/+page.svelte` (temporary from Task 1)
- Modify: `src/lib/shared/i18n-en.ts`
- Test: `src/lib/ui/shell/nav.test.ts`, `src/params/params.test.ts`

**Interfaces:**
- Consumes: `useI18n` (Task 2), `msg` (Task 2), `appOriginForSite` (Task 4), `appName` (Task 1).
- Produces:
  - `TABS: readonly NavItem[]` (4 links; Tambah is a button), `SIDEBAR_EXTRA: readonly NavItem[]`,
    `STUBS: readonly NavItem[]`, `ADD_PATHS: readonly AddPath[]`, `isActive(href: string, pathname: string): boolean`
  - `interface NavItem { href: string; label: string; icon: IconName }`
  - `interface AddPath { id: 'otomatis' | 'suara' | 'struk' | 'mutasi' | 'manual'; label: string; hint: string; icon: IconName }`
  - `type IconName` and `<Icon name size? />`
  - `<Sheet open bind:open title onclose? children />` — native `<dialog>`, returns focus to the opener
  - `<ScreenTitle title />`, `<EmptyState text actionLabel? actionHref? />`

- [ ] **Step 1: Failing nav and param tests**

`src/lib/ui/shell/nav.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { match as stubMatch } from '../../../params/stub';
import { ADD_PATHS, isActive, SIDEBAR_EXTRA, STUBS, TABS } from './nav';

describe('navigation tables', () => {
	it('mirrors the reference tab order', () => {
		expect(TABS.map((t) => t.label)).toEqual(['Beranda', 'Riwayat', 'Laporan', 'Kekayaan']);
		expect(TABS.map((t) => t.href)).toEqual(['/', '/riwayat', '/laporan', '/kekayaan']);
	});

	it('mirrors the reference capture paths, then manual', () => {
		expect(ADD_PATHS.map((p) => p.id)).toEqual(['otomatis', 'suara', 'struk', 'mutasi', 'manual']);
	});

	it('sidebar adds Impor, Kotak masuk, Pengaturan', () => {
		expect(SIDEBAR_EXTRA.map((t) => t.href)).toEqual(['/impor', '/kotak-masuk', '/pengaturan']);
	});

	it('every STUBS href is accepted by the stub param matcher', () => {
		expect(STUBS.every((s) => stubMatch(s.href.slice(1)))).toBe(true);
	});

	it('every stub route is unique and not a tab', () => {
		const hrefs = STUBS.map((s) => s.href);
		expect(new Set(hrefs).size).toBe(hrefs.length);
		expect(hrefs.some((h) => TABS.some((t) => t.href === h))).toBe(false);
	});
});

describe('isActive', () => {
	it('matches Beranda only on /', () => {
		expect(isActive('/', '/')).toBe(true);
		expect(isActive('/', '/riwayat')).toBe(false);
	});
	it('matches a section and its children, not prefixes of other words', () => {
		expect(isActive('/riwayat', '/riwayat')).toBe(true);
		expect(isActive('/riwayat', '/riwayat/123')).toBe(true);
		expect(isActive('/riwayat', '/riwayatx')).toBe(false);
	});
});
```

`src/params/params.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { match as legal } from './legal';
import { match as stub } from './stub';

describe('param matchers', () => {
	it('stub accepts only known stub slugs', () => {
		expect(stub('tanya')).toBe(true);
		expect(stub('pengaturan')).toBe(true);
		expect(stub('riwayat')).toBe(false);
		expect(stub('anything')).toBe(false);
	});
	it('legal accepts only the three legal pages', () => {
		expect(['privasi', 'ketentuan', 'hapus-akun'].every(legal)).toBe(true);
		expect(legal('blog')).toBe(false);
	});
});
```

Run: `npx vitest run src/lib/ui/shell/nav.test.ts src/params`
Expected: FAIL — modules not found.

- [ ] **Step 2: Navigation tables and param matchers**

`src/lib/ui/shell/nav.ts`:

```ts
import { msg } from '#lib/shared/i18n';
import type { IconName } from '#lib/ui/icons';

export interface NavItem {
	href: string;
	label: string;
	icon: IconName;
}

export interface AddPath {
	id: 'otomatis' | 'suara' | 'struk' | 'mutasi' | 'manual';
	label: string;
	hint: string;
	icon: IconName;
}

export const TABS: readonly NavItem[] = [
	{ href: '/', label: msg('Beranda'), icon: 'home' },
	{ href: '/riwayat', label: msg('Riwayat'), icon: 'list' },
	{ href: '/laporan', label: msg('Laporan'), icon: 'chart' },
	{ href: '/kekayaan', label: msg('Kekayaan'), icon: 'wallet' }
];

export const SIDEBAR_EXTRA: readonly NavItem[] = [
	{ href: '/impor', label: msg('Impor'), icon: 'file' },
	{ href: '/kotak-masuk', label: msg('Kotak masuk'), icon: 'inbox' },
	{ href: '/pengaturan', label: msg('Pengaturan'), icon: 'gear' }
];

export const STUBS: readonly NavItem[] = [
	...SIDEBAR_EXTRA,
	{ href: '/tanya', label: msg('Tanya'), icon: 'sparkle' },
	{ href: '/ruang', label: msg('Ruang'), icon: 'people' },
	{ href: '/masuk', label: msg('Masuk'), icon: 'user' },
	{ href: '/daftar', label: msg('Daftar'), icon: 'user' }
];

export const ADD_PATHS: readonly AddPath[] = [
	{ id: 'otomatis', label: msg('Otomatis'), hint: msg('Dari Gmail: QRIS dan transfer'), icon: 'mail' },
	{ id: 'suara', label: msg('Suara'), hint: msg('Ucapkan transaksimu'), icon: 'mic' },
	{ id: 'struk', label: msg('Struk'), hint: msg('Foto struk belanja'), icon: 'receipt' },
	{ id: 'mutasi', label: msg('Mutasi'), hint: msg('PDF, Excel atau CSV dari bank'), icon: 'file' },
	{ id: 'manual', label: msg('Ketik manual'), hint: msg('Isi sendiri'), icon: 'keyboard' }
];

export function isActive(href: string, pathname: string): boolean {
	if (href === '/') return pathname === '/';
	return pathname === href || pathname.startsWith(href + '/');
}
```

`src/params/stub.ts`:

```ts
import type { ParamMatcher } from '@sveltejs/kit';

const SLUGS = new Set(['impor', 'kotak-masuk', 'pengaturan', 'tanya', 'ruang', 'masuk', 'daftar']);

export const match: ParamMatcher = (param) => SLUGS.has(param);
```

`src/params/legal.ts`:

```ts
import type { ParamMatcher } from '@sveltejs/kit';

export const match: ParamMatcher = (param) => ['privasi', 'ketentuan', 'hapus-akun'].includes(param);
```

Keep the stub slug list in `stub.ts` and `STUBS` in `nav.ts` equal; the nav test asserts it.

- [ ] **Step 3: Icons**

`src/lib/ui/icons.ts`:

```ts
/** 24×24 stroke icons (ours, simple geometry). */
export const ICONS = {
	home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
	list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
	chart: 'M4 20V10M10 20V4M16 20v-7M2 20h20',
	wallet: 'M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4v4M16 14h.01',
	plus: 'M12 5v14M5 12h14',
	mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
	receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
	mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
	file: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6',
	inbox: 'M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z',
	gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
	keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
	close: 'M6 6l12 12M18 6 6 18',
	sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
	people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.1a4 4 0 0 1 0 7.8M22 21v-1a6 6 0 0 0-4-5.7',
	user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21v-1a8 8 0 0 1 16 0v1',
	check: 'M5 12l5 5 9-10',
	'arrow-up': 'M12 19V5M5 12l7-7 7 7',
	'arrow-down': 'M12 5v14M5 12l7 7 7-7'
} as const;

export type IconName = keyof typeof ICONS;
```

`src/lib/ui/Icon.svelte`:

```svelte
<script lang="ts">
	import { ICONS, type IconName } from './icons';

	let { name, size = 24 }: { name: IconName; size?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
>
	<path d={ICONS[name]} />
</svg>
```

Update the import in `nav.ts` to `import type { IconName } from '#lib/ui/icons';` (already written that way).

Run: `npx vitest run src/lib/ui/shell/nav.test.ts src/params`
Expected: PASS.

- [ ] **Step 4: Shell components**

`src/lib/ui/shell/Sheet.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';

	let {
		open = $bindable(false),
		title,
		children
	}: { open?: boolean; title: string; children: Snippet } = $props();

	const { tr } = useI18n();
	let dialog: HTMLDialogElement | undefined = $state();
	let opener: HTMLElement | null = null;

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});

	function onclose() {
		open = false;
		opener?.focus();
	}

	function onclick(event: MouseEvent) {
		if (event.target === dialog) open = false;
	}
</script>

<dialog bind:this={dialog} class="sheet" aria-labelledby="sheet-title" {onclose} {onclick}>
	<div class="sheet-body">
		<header class="sheet-head">
			<h2 id="sheet-title">{title}</h2>
			<button type="button" class="close" aria-label={tr('Tutup')} onclick={() => (open = false)}>
				<Icon name="close" size={20} />
			</button>
		</header>
		{@render children()}
	</div>
</dialog>

<style>
	.sheet {
		margin: auto auto 0;
		width: 100%;
		max-width: 640px;
		border: 0;
		padding: 0;
		border-radius: var(--r-l) var(--r-l) 0 0;
		background: var(--bg);
		color: var(--ink);
		box-shadow: var(--shadow-sheet);
	}
	.sheet::backdrop {
		background: rgb(0 0 0 / 0.35);
	}
	.sheet[open] {
		animation: rise 0.32s var(--ease);
	}
	.sheet-body {
		padding: 8px 20px calc(20px + env(safe-area-inset-bottom));
	}
	.sheet-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 56px;
	}
	h2 {
		margin: 0;
		font-size: 19px;
		font-weight: 600;
		letter-spacing: -0.012em;
	}
	.close {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
	}
	@media (min-width: 1024px) {
		.sheet {
			margin: auto;
			border-radius: var(--r-l);
			max-width: 480px;
		}
	}
	@keyframes rise {
		from {
			transform: translateY(24px);
			opacity: 0;
		}
	}
</style>
```

`src/lib/ui/shell/AddSheet.svelte`:

```svelte
<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Sheet from './Sheet.svelte';
	import { ADD_PATHS } from './nav';

	let { open = $bindable(false) }: { open?: boolean } = $props();
	const { tr } = useI18n();
</script>

<Sheet bind:open title={tr('Tambah transaksi')}>
	<ul class="paths">
		{#each ADD_PATHS as path (path.id)}
			<li>
				<button type="button" class="path" disabled aria-describedby="soon-{path.id}">
					<span class="tile"><Icon name={path.icon} /></span>
					<span class="text">
						<span class="label">{tr(path.label)}</span>
						<span class="hint">{tr(path.hint)}</span>
					</span>
					<span class="soon" id="soon-{path.id}">{tr('Segera hadir')}</span>
				</button>
			</li>
		{/each}
	</ul>
</Sheet>

<style>
	.paths {
		list-style: none;
		margin: 0;
		padding: 0;
		background: var(--panel);
		border-radius: var(--r-group);
		overflow: hidden;
	}
	li + li .path {
		border-top: 1px solid var(--line);
	}
	.path {
		display: flex;
		align-items: center;
		gap: 14px;
		width: 100%;
		min-height: 64px;
		padding: 10px 16px;
		border: 0;
		background: transparent;
		color: var(--ink);
		text-align: left;
		font: inherit;
	}
	.path:disabled {
		cursor: not-allowed;
	}
	.tile {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--r-pill);
		background: var(--bg);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
	}
	.label {
		font-size: 16px;
		font-weight: 600;
	}
	.hint,
	.soon {
		font-size: 13px;
		color: var(--muted);
	}
</style>
```

`src/lib/ui/shell/TabBar.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import { isActive, TABS } from './nav';

	let { onadd }: { onadd: () => void } = $props();
	const { tr } = useI18n();
</script>

<nav class="tabbar" aria-label={tr('Navigasi utama')}>
	{#each TABS as tab (tab.href)}
		<a
			href={tab.href}
			class="tab"
			aria-current={isActive(tab.href, page.url.pathname) ? 'page' : undefined}
		>
			<Icon name={tab.icon} size={22} />
			<span>{tr(tab.label)}</span>
		</a>
	{/each}
	<button type="button" class="tab" aria-haspopup="dialog" onclick={onadd}>
		<Icon name="plus" size={22} />
		<span>{tr('Tambah')}</span>
	</button>
</nav>

<style>
	.tabbar {
		position: fixed;
		left: 14px;
		right: 14px;
		bottom: calc(14px + env(safe-area-inset-bottom));
		z-index: 20;
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		height: var(--tabbar-h);
		padding: 6px;
		border-radius: var(--r-pill);
		background: var(--glass-bg);
		box-shadow: var(--glass-ring);
		backdrop-filter: var(--glass-blur);
		-webkit-backdrop-filter: var(--glass-blur);
	}
	.tab {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--muted);
		font: inherit;
		font-size: 11px;
		font-weight: 500;
		text-decoration: none;
		transition: transform 0.15s var(--ease);
	}
	.tab:active {
		transform: scale(var(--press-scale));
	}
	.tab[aria-current='page'] {
		background: var(--on-glass-active);
		color: var(--ink);
	}
	@media (min-width: 1024px) {
		.tabbar {
			display: none;
		}
	}
</style>
```

`src/lib/ui/shell/Sidebar.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { appName } from '#lib/shared/sanity';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import { isActive, SIDEBAR_EXTRA, TABS } from './nav';

	let { onadd }: { onadd: () => void } = $props();
	const { tr } = useI18n();
</script>

<nav class="sidebar" aria-label={tr('Navigasi utama')}>
	<p class="brand">{appName()}</p>
	<ul>
		{#each [...TABS, ...SIDEBAR_EXTRA] as item (item.href)}
			<li>
				<a
					href={item.href}
					class="item"
					aria-current={isActive(item.href, page.url.pathname) ? 'page' : undefined}
				>
					<Icon name={item.icon} size={20} />
					<span>{tr(item.label)}</span>
				</a>
			</li>
		{/each}
	</ul>
	<button type="button" class="add" aria-haspopup="dialog" onclick={onadd}>
		<Icon name="plus" size={20} />
		<span>{tr('Tambah')}</span>
	</button>
</nav>

<style>
	.sidebar {
		display: none;
	}
	@media (min-width: 1024px) {
		.sidebar {
			position: sticky;
			top: 0;
			display: flex;
			flex-direction: column;
			gap: 8px;
			width: 240px;
			height: 100dvh;
			padding: 24px 16px;
			border-right: 1px solid var(--line);
			background: var(--bg);
		}
	}
	.brand {
		margin: 0 12px 16px;
		font-size: 19px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	.item,
	.add {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-s);
		background: transparent;
		color: var(--ink-2);
		font: inherit;
		font-size: 15px;
		font-weight: 500;
		text-decoration: none;
	}
	.item:hover {
		background: var(--panel);
	}
	.item[aria-current='page'] {
		background: var(--panel-2);
		color: var(--ink);
		font-weight: 600;
	}
	.add {
		margin-top: auto;
		justify-content: center;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
	}
</style>
```

`src/lib/ui/shell/ScreenTitle.svelte` (shrinks after the page scrolls 24 px, via an IntersectionObserver sentinel):

```svelte
<script lang="ts">
	let { title }: { title: string } = $props();
	let sentinel: HTMLElement | undefined = $state();
	let compact = $state(false);

	$effect(() => {
		if (!sentinel) return;
		const observer = new IntersectionObserver(([entry]) => (compact = !entry?.isIntersecting));
		observer.observe(sentinel);
		return () => observer.disconnect();
	});
</script>

<div class="sentinel" bind:this={sentinel} aria-hidden="true"></div>
<header class="screen-title" class:compact>
	<h1>{title}</h1>
</header>

<style>
	.sentinel {
		height: 1px;
		margin-bottom: -1px;
	}
	.screen-title {
		position: sticky;
		top: 0;
		z-index: 10;
		padding: 12px 0 8px;
		background: var(--bg);
	}
	h1 {
		margin: 0;
		font-size: 34px;
		line-height: 1.1;
		font-weight: 700;
		letter-spacing: -0.03em;
		transition: font-size 0.2s var(--ease);
	}
	.compact h1 {
		font-size: 19px;
		letter-spacing: -0.012em;
	}
</style>
```

`src/lib/ui/shell/EmptyState.svelte`:

```svelte
<script lang="ts">
	let {
		text,
		actionLabel,
		actionHref
	}: { text: string; actionLabel?: string; actionHref?: string } = $props();
</script>

<div class="empty">
	<p>{text}</p>
	{#if actionLabel && actionHref}
		<a class="action" href={actionHref}>{actionLabel}</a>
	{/if}
</div>

<style>
	.empty {
		display: grid;
		justify-items: center;
		gap: 16px;
		padding: 48px 0;
		text-align: center;
	}
	p {
		margin: 0;
		max-width: 32ch;
		color: var(--muted);
	}
	.action {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 20px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
		text-decoration: none;
	}
</style>
```

- [ ] **Step 5: App layout and screens**

`src/routes/(app)/+layout.svelte`:

```svelte
<script lang="ts">
	import AddSheet from '#lib/ui/shell/AddSheet.svelte';
	import Sidebar from '#lib/ui/shell/Sidebar.svelte';
	import TabBar from '#lib/ui/shell/TabBar.svelte';

	let { children } = $props();
	let adding = $state(false);
</script>

<div class="app">
	<Sidebar onadd={() => (adding = true)} />
	<main class="content">
		{@render children()}
	</main>
	<TabBar onadd={() => (adding = true)} />
	<AddSheet bind:open={adding} />
</div>

<style>
	.app {
		display: flex;
		min-height: 100dvh;
	}
	.content {
		flex: 1;
		min-width: 0;
		max-width: 640px;
		margin: 0 auto;
		padding: 0 20px calc(var(--tabbar-h) + 40px + env(safe-area-inset-bottom));
	}
	@media (min-width: 1024px) {
		.content {
			padding-bottom: 48px;
		}
	}
</style>
```

`src/routes/(app)/+page.svelte` (Beranda):

```svelte
<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	const { tr } = useI18n();
</script>

<svelte:head><title>{tr('Beranda')}</title></svelte:head>

<ScreenTitle title={tr('Beranda')} />

<div class="capture">
	<button type="button" class="pill voice" disabled aria-describedby="capture-soon">
		<Icon name="mic" size={20} />{tr('Suara')}
	</button>
	<button type="button" class="pill receipt" disabled aria-describedby="capture-soon">
		<Icon name="receipt" size={20} />{tr('Struk')}
	</button>
</div>
<p id="capture-soon" class="soon">{tr('Segera hadir')}</p>

<EmptyState text={tr('Belum ada transaksi bulan ini.')} />

<style>
	.capture {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		margin-top: 16px;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 52px;
		border: 0;
		border-radius: var(--r-pill);
		font: inherit;
		font-size: 16px;
		font-weight: 600;
	}
	.pill:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.voice {
		background: var(--panel);
		color: var(--ink);
	}
	.receipt {
		background: var(--ink);
		color: var(--bg);
	}
	.soon {
		margin: 8px 0 0;
		text-align: center;
		font-size: 13px;
		color: var(--muted);
	}
</style>
```

`src/routes/(app)/riwayat/+page.svelte`:

```svelte
<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	const { tr } = useI18n();
</script>

<svelte:head><title>{tr('Riwayat')}</title></svelte:head>
<ScreenTitle title={tr('Riwayat')} />
<EmptyState text={tr('Transaksi yang kamu catat muncul di sini.')} />
```

`src/routes/(app)/laporan/+page.svelte`:

```svelte
<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	const { tr } = useI18n();
</script>

<svelte:head><title>{tr('Laporan')}</title></svelte:head>
<ScreenTitle title={tr('Laporan')} />
<EmptyState text={tr('Laporan muncul setelah ada transaksi.')} />
```

`src/routes/(app)/kekayaan/+page.svelte`:

```svelte
<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	const { tr } = useI18n();
</script>

<svelte:head><title>{tr('Kekayaan')}</title></svelte:head>
<ScreenTitle title={tr('Kekayaan')} />
<EmptyState text={tr('Tambahkan dompet dan aset untuk melihat kekayaan bersihmu.')} />
```

`src/routes/(app)/[stub=stub]/+page.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { useI18n } from '#lib/ui/i18n-context';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import { STUBS } from '#lib/ui/shell/nav';

	const { tr } = useI18n();
	const item = $derived(STUBS.find((s) => s.href === `/${page.params.stub}`));
</script>

<svelte:head><title>{item ? tr(item.label) : ''}</title></svelte:head>
<ScreenTitle title={item ? tr(item.label) : ''} />
<EmptyState text={tr('Segera hadir')} actionLabel={tr('Kembali ke Beranda')} actionHref="/" />
```

`src/routes/(app)/+error.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { useI18n } from '#lib/ui/i18n-context';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';

	const { tr } = useI18n();
</script>

<EmptyState
	text={page.status === 404 ? tr('Halaman tidak ditemukan.') : tr('Terjadi kesalahan. Coba lagi.')}
	actionLabel={tr('Kembali ke Beranda')}
	actionHref="/"
/>
```

Also create `src/routes/+error.svelte` (outside both groups, catches `/__not_found`) with the same content.

- [ ] **Step 6: Site layout and pages**

`src/routes/(site)/site/+layout.server.ts`:

```ts
import { appOriginForSite } from '#lib/shared/hosts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ url }) => ({
	appOrigin: appOriginForSite(url.hostname, url.port, url.protocol)
});
```

`src/routes/(site)/site/+layout.svelte`:

```svelte
<script lang="ts">
	import { appName } from '#lib/shared/sanity';
	import { useI18n } from '#lib/ui/i18n-context';

	let { data, children } = $props();
	const { tr } = useI18n();
</script>

<header class="site-header">
	<a class="brand" href="/">{appName()}</a>
	<a class="cta" href={data.appOrigin}>{tr('Mulai gratis')}</a>
</header>

<main class="site-main">{@render children()}</main>

<footer class="site-footer">
	<nav aria-label={tr('Tautan kaki')}>
		<a href="/privasi">{tr('Privasi')}</a>
		<a href="/ketentuan">{tr('Ketentuan')}</a>
		<a href="/hapus-akun">{tr('Hapus akun')}</a>
		<a href="/blog">{tr('Blog')}</a>
	</nav>
</footer>

<style>
	.site-header {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--header-h);
		padding: 0 var(--gutter);
		background: var(--bg);
		border-bottom: 1px solid var(--line);
	}
	.brand {
		font-size: 19px;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--ink);
		text-decoration: none;
	}
	.cta {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 18px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-size: 15px;
		font-weight: 600;
		text-decoration: none;
	}
	.site-main {
		max-width: var(--maxw);
		margin: 0 auto;
		padding: 0 var(--gutter);
	}
	.site-footer {
		padding: 40px var(--gutter);
		background: var(--panel);
	}
	.site-footer nav {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 20px;
	}
	.site-footer a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink-2);
		text-decoration: none;
	}
</style>
```

`src/routes/(site)/site/+page.svelte`:

```svelte
<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';

	const { tr } = useI18n();
</script>

<svelte:head><title>{tr('Catat uang tanpa repot')}</title></svelte:head>

<section class="hero">
	<h1>{tr('Catat uang tanpa repot')}</h1>
	<p class="lead">{tr('Pembayaranmu tercatat sendiri dari email, suara, struk dan mutasi bank.')}</p>
</section>
<section class="placeholder">
	<p>{tr('Halaman lengkap segera hadir.')}</p>
</section>

<style>
	.hero {
		padding: clamp(88px, 12vw, 160px) 0;
		text-align: center;
	}
	h1 {
		margin: 0;
		font-size: clamp(44px, 7.2vw, 100px);
		line-height: 1;
		font-weight: 600;
		letter-spacing: -0.044em;
		text-wrap: balance;
	}
	.lead {
		max-width: 36ch;
		margin: 24px auto 0;
		font-size: clamp(18px, 1.55vw, 21px);
		line-height: 1.45;
		color: var(--muted);
		text-wrap: pretty;
	}
	.placeholder {
		padding: 48px 0;
		text-align: center;
		color: var(--muted);
	}
</style>
```

`src/routes/(site)/site/blog/+page.svelte`:

```svelte
<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';

	const { tr } = useI18n();
</script>

<svelte:head><title>{tr('Blog')}</title></svelte:head>
<h1 class="title">{tr('Blog')}</h1>
<EmptyState text={tr('Belum ada artikel.')} />

<style>
	.title {
		margin: 48px 0 0;
		font-size: 34px;
		font-weight: 700;
		letter-spacing: -0.03em;
	}
</style>
```

`src/routes/(site)/site/[legal=legal]/+page.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { msg } from '#lib/shared/i18n';
	import { useI18n } from '#lib/ui/i18n-context';

	const TITLES: Record<string, string> = {
		privasi: msg('Kebijakan privasi'),
		ketentuan: msg('Ketentuan layanan'),
		'hapus-akun': msg('Hapus akun')
	};
	const { tr } = useI18n();
	const title = $derived(tr(TITLES[page.params.legal ?? ''] ?? ''));
</script>

<svelte:head><title>{title}</title></svelte:head>
<article class="legal">
	<h1>{title}</h1>
	<p class="draft">{tr('Draf. Isi lengkap menunggu tinjauan hukum.')}</p>
</article>

<style>
	.legal {
		max-width: 680px;
		padding: 48px 0;
	}
	h1 {
		margin: 0;
		font-size: 34px;
		font-weight: 700;
		letter-spacing: -0.03em;
	}
	.draft {
		color: var(--muted);
	}
</style>
```

`src/routes/(site)/site/+error.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { useI18n } from '#lib/ui/i18n-context';

	const { tr } = useI18n();
</script>

<p class="error">
	{page.status === 404 ? tr('Halaman tidak ditemukan.') : tr('Terjadi kesalahan. Coba lagi.')}
	<a href="/">{tr('Kembali ke beranda situs')}</a>
</p>

<style>
	.error {
		padding: 64px 0;
		text-align: center;
	}
</style>
```

Delete `src/routes/+page.svelte`.

- [ ] **Step 7: English entries**

Replace the object in `src/lib/shared/i18n-en.ts` with:

```ts
export const en: Record<string, string> = {
	Beranda: 'Home',
	Riwayat: 'History',
	Laporan: 'Reports',
	Kekayaan: 'Net worth',
	Tambah: 'Add',
	Impor: 'Import',
	'Kotak masuk': 'Inbox',
	Pengaturan: 'Settings',
	Tanya: 'Ask',
	Ruang: 'Spaces',
	Masuk: 'Sign in',
	Daftar: 'Sign up',
	Otomatis: 'Automatic',
	'Dari Gmail: QRIS dan transfer': 'From Gmail: QRIS and transfers',
	Suara: 'Voice',
	'Ucapkan transaksimu': 'Say your transaction',
	Struk: 'Receipt',
	'Foto struk belanja': 'Photograph a receipt',
	Mutasi: 'Statement',
	'PDF, Excel atau CSV dari bank': 'PDF, Excel or CSV from your bank',
	'Ketik manual': 'Type it in',
	'Isi sendiri': 'Fill it in yourself',
	'Tambah transaksi': 'Add a transaction',
	'Segera hadir': 'Coming soon',
	Tutup: 'Close',
	'Navigasi utama': 'Main navigation',
	'Belum ada transaksi bulan ini.': 'No transactions this month yet.',
	'Transaksi yang kamu catat muncul di sini.': 'Transactions you record show up here.',
	'Laporan muncul setelah ada transaksi.': 'Reports appear once you have transactions.',
	'Tambahkan dompet dan aset untuk melihat kekayaan bersihmu.':
		'Add wallets and assets to see your net worth.',
	'Kembali ke Beranda': 'Back to Home',
	'Halaman tidak ditemukan.': 'Page not found.',
	'Terjadi kesalahan. Coba lagi.': 'Something went wrong. Try again.',
	'Mulai gratis': 'Start free',
	'Tautan kaki': 'Footer links',
	Privasi: 'Privacy',
	Ketentuan: 'Terms',
	'Hapus akun': 'Delete account',
	Blog: 'Blog',
	'Catat uang tanpa repot': 'Track money without the effort',
	'Pembayaranmu tercatat sendiri dari email, suara, struk dan mutasi bank.':
		'Your payments record themselves from e-mail, voice, receipts and bank statements.',
	'Halaman lengkap segera hadir.': 'The full page is coming soon.',
	'Belum ada artikel.': 'No articles yet.',
	'Kebijakan privasi': 'Privacy policy',
	'Ketentuan layanan': 'Terms of service',
	'Draf. Isi lengkap menunggu tinjauan hukum.': 'Draft. Full text awaits legal review.',
	'Kembali ke beranda situs': 'Back to the site home',
	'{n} transaksi': '{n} transactions'
};
```

Run: `npm test`
Expected: all PASS, including `test/i18n-coverage.test.ts` and `test/no-inline-style.test.ts`.

- [ ] **Step 8: Check and look at it**

Run: `npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings && npm run lint && npm run build`
Expected: all exit 0.

Run: `npx wrangler dev --port 8787` (background) and open `http://localhost:8787/` at 360 px and 1280 px,
`http://site.localhost:8787/`. Expected: tab bar on phone, sidebar on desktop, Tambah opens the sheet, site header
and footer render. Stop the server.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(shell): app shell with floating tab bar, sidebar, Tambah sheet and site shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Component kit A — buttons, chips, badges, lists, rows, hero

**Files:**
- Create: `src/lib/ui/kit/Button.svelte`, `Chip.svelte`, `Segmented.svelte`, `Badge.svelte`, `StatusTag.svelte`,
  `GroupList.svelte`, `GroupRow.svelte`, `DayHeader.svelte`, `CategoryTile.svelte`, `TransactionRow.svelte`,
  `HeroBlock.svelte`, `ComparisonPill.svelte` (all under `src/lib/ui/kit/`), `src/lib/ui/kit/category.ts`
- Modify: `src/lib/shared/i18n-en.ts`
- Test: `src/lib/ui/kit/category.test.ts`

**Interfaces:**
- Consumes: `formatMoney`, `formatMoneyCompact` (Task 7), `useI18n` (Task 2), `Icon` (Task 8).
- Produces (props):
  - `Button { variant?: 'primary'|'secondary'|'ghost'|'destructive'; size?: 'lg'|'md'|'sm'; type?: 'button'|'submit'; disabled?: boolean; full?: boolean; onclick?: (e: MouseEvent) => void; children: Snippet }`
  - `Chip { selected?: boolean; count?: number; onclick?: () => void; children: Snippet }`
  - `Segmented { options: { value: string; label: string }[]; value: string (bindable); label: string }`
  - `Badge { children: Snippet }`, `StatusTag { children: Snippet }`
  - `GroupList { children: Snippet }`, `GroupRow { href?: string; inset?: boolean; children: Snippet }`
  - `DayHeader { label: string; inMinor: number; outMinor: number; currency?: string }`
  - `CategoryTile { category: CategoryKey; size?: 36 | 40 }`
  - `TransactionRow { title: string; meta: string; amountMinor: number; currency?: string; category: CategoryKey; status?: string; href?: string }`
  - `HeroBlock { label: string; amountMinor: number; currency?: string; children?: Snippet }`
  - `ComparisonPill { diffMinor: number; monthName: string; avgPerDayMinor?: number; sameThresholdMinor?: number }`
  - `type CategoryKey`, `CATEGORIES: Record<CategoryKey, { label: string; emoji: string; cssVar: string }>`,
    `comparisonKind(diffMinor: number, thresholdMinor: number): 'more' | 'less' | 'same'`

- [ ] **Step 1: Failing test for the category table and comparison rule**

`src/lib/ui/kit/category.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, comparisonKind } from './category';

describe('CATEGORIES', () => {
	it('has the 15 preset categories from the design system', () => {
		expect(Object.keys(CATEGORIES)).toHaveLength(15);
	});
	it('every category colour exists as a token', () => {
		const css = readFileSync('docs/design/tokens.css', 'utf8');
		for (const c of Object.values(CATEGORIES)) expect(css).toContain(`${c.cssVar}:`);
	});
});

describe('comparisonKind', () => {
	it('more / less / same around a threshold', () => {
		expect(comparisonKind(12_000_000, 5_000_000)).toBe('more');
		expect(comparisonKind(-8_000_000, 5_000_000)).toBe('less');
		expect(comparisonKind(4_999_999, 5_000_000)).toBe('same');
		expect(comparisonKind(-5_000_000, 5_000_000)).toBe('same');
	});
});
```

Run: `npx vitest run src/lib/ui/kit/category.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `category.ts`**

```ts
import { msg } from '#lib/shared/i18n';

export const CATEGORIES = {
	kopi: { label: msg('Kopi'), emoji: '☕', cssVar: '--cat-kopi' },
	makan: { label: msg('Makan & Minum'), emoji: '🍜', cssVar: '--cat-makan' },
	'belanja-harian': { label: msg('Belanja Harian'), emoji: '🛒', cssVar: '--cat-belanja-harian' },
	belanja: { label: msg('Belanja'), emoji: '🛍️', cssVar: '--cat-belanja' },
	transportasi: { label: msg('Transportasi'), emoji: '🛵', cssVar: '--cat-transportasi' },
	tagihan: { label: msg('Tagihan'), emoji: '🧾', cssVar: '--cat-tagihan' },
	hiburan: { label: msg('Hiburan'), emoji: '🎬', cssVar: '--cat-hiburan' },
	kesehatan: { label: msg('Kesehatan'), emoji: '💊', cssVar: '--cat-kesehatan' },
	pendidikan: { label: msg('Pendidikan'), emoji: '📚', cssVar: '--cat-pendidikan' },
	'tempat-tinggal': { label: msg('Tempat Tinggal'), emoji: '🏠', cssVar: '--cat-tempat-tinggal' },
	gaji: { label: msg('Gaji'), emoji: '💼', cssVar: '--cat-gaji' },
	bonus: { label: msg('Bonus'), emoji: '🎁', cssVar: '--cat-bonus' },
	freelance: { label: msg('Freelance'), emoji: '💻', cssVar: '--cat-freelance' },
	hadiah: { label: msg('Hadiah'), emoji: '🎀', cssVar: '--cat-hadiah' },
	lain: { label: msg('Lainnya'), emoji: '✨', cssVar: '--cat-lain' }
} as const;

export type CategoryKey = keyof typeof CATEGORIES;

/** "Hampir sama" when the month-over-month difference is within the threshold (inclusive). */
export function comparisonKind(diffMinor: number, thresholdMinor: number): 'more' | 'less' | 'same' {
	if (Math.abs(diffMinor) <= thresholdMinor) return 'same';
	return diffMinor > 0 ? 'more' : 'less';
}
```

Run: `npx vitest run src/lib/ui/kit/category.test.ts`
Expected: PASS.

- [ ] **Step 3: Components**

`Button.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		variant = 'primary',
		size = 'md',
		type = 'button',
		disabled = false,
		full = false,
		onclick,
		children
	}: {
		variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
		size?: 'lg' | 'md' | 'sm';
		type?: 'button' | 'submit';
		disabled?: boolean;
		full?: boolean;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	} = $props();
</script>

<button {type} {disabled} {onclick} class="btn {variant} {size}" class:full>
	{@render children()}
</button>

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border: 0;
		border-radius: var(--r-pill);
		font: inherit;
		font-weight: 600;
		transition:
			transform 0.15s var(--ease),
			box-shadow 0.2s var(--ease),
			background 0.2s var(--ease);
	}
	.btn:active:not(:disabled) {
		transform: scale(var(--press-scale));
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.lg {
		height: 52px;
		padding: 0 24px;
		font-size: 16px;
	}
	.md {
		height: 44px;
		padding: 0 20px;
		font-size: 16px;
	}
	.sm {
		height: 40px;
		padding: 0 18px;
		font-size: 15px;
	}
	.full {
		width: 100%;
	}
	.primary {
		background: var(--ink);
		color: var(--bg);
	}
	.primary:hover:not(:disabled) {
		box-shadow: var(--shadow-btn-hover);
	}
	.secondary {
		background: var(--panel);
		color: var(--ink);
	}
	.secondary:hover:not(:disabled) {
		background: var(--panel-2);
	}
	.ghost {
		background: transparent;
		color: var(--ink);
	}
	.destructive {
		background: var(--panel);
		color: var(--money-up);
	}
</style>
```

`Chip.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		selected = false,
		count,
		onclick,
		children
	}: { selected?: boolean; count?: number; onclick?: () => void; children: Snippet } = $props();
</script>

<button type="button" class="chip" aria-pressed={selected} {onclick}>
	{@render children()}
	{#if count !== undefined}<span class="count num">{count}</span>{/if}
</button>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 44px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 15px;
		font-weight: 600;
	}
	.chip[aria-pressed='true'] {
		background: var(--ink);
		color: var(--bg);
	}
	.count {
		opacity: 0.7;
	}
</style>
```

`Segmented.svelte`:

```svelte
<script lang="ts">
	let {
		options,
		value = $bindable(),
		label
	}: { options: { value: string; label: string }[]; value: string; label: string } = $props();
</script>

<div class="segmented" role="radiogroup" aria-label={label}>
	{#each options as option (option.value)}
		<button
			type="button"
			role="radio"
			aria-checked={value === option.value}
			class="segment"
			onclick={() => (value = option.value)}
		>
			{option.label}
		</button>
	{/each}
</div>

<style>
	.segmented {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border-radius: var(--r-pill);
		background: var(--panel);
	}
	.segment {
		min-height: 44px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--ink-2);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
	}
	.segment[aria-checked='true'] {
		background: var(--ink);
		color: var(--bg);
	}
</style>
```

`Badge.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<span class="badge">{@render children()}</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		height: 28px;
		padding: 0 12px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
	}
</style>
```

`StatusTag.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/ui/Icon.svelte';
	let { children }: { children: Snippet } = $props();
</script>

<span class="tag"><span class="dot"><Icon name="check" size={10} /></span>{@render children()}</span>

<style>
	.tag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--money-in);
		font-size: 13px;
		font-weight: 600;
	}
	.dot {
		display: grid;
		place-items: center;
		width: 14px;
		height: 14px;
		border-radius: var(--r-pill);
		background: var(--money-in);
		color: var(--bg);
	}
</style>
```

`GroupList.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<ul class="group">{@render children()}</ul>

<style>
	.group {
		list-style: none;
		margin: 0;
		padding: 0;
		border-radius: var(--r-group);
		background: var(--panel);
		overflow: hidden;
	}
	.group :global(li + li > .row)::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: 62px;
		border-top: 1px solid var(--line);
	}
</style>
```

`GroupRow.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	let { href, children }: { href?: string; children: Snippet } = $props();
</script>

<li>
	{#if href}
		<a class="row tappable" {href}>{@render children()}</a>
	{:else}
		<div class="row">{@render children()}</div>
	{/if}
</li>

<style>
	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 56px;
		padding: 8px 16px;
		color: var(--ink);
		text-decoration: none;
	}
	.tappable {
		transition: transform 0.15s var(--ease);
	}
	.tappable:active {
		transform: scale(var(--press-scale));
	}
</style>
```

`DayHeader.svelte`:

```svelte
<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';

	let {
		label,
		inMinor,
		outMinor,
		currency = 'IDR'
	}: { label: string; inMinor: number; outMinor: number; currency?: string } = $props();
</script>

<div class="day">
	<span>{label}</span>
	<span class="num">
		{#if inMinor > 0}<span class="in">{formatMoney(inMinor, currency, 'signed')}</span>{/if}
		{#if outMinor !== 0}<span>{formatMoney(-Math.abs(outMinor), currency)}</span>{/if}
	</span>
</div>

<style>
	.day {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 20px 4px 8px;
		font-size: 14px;
		font-weight: 600;
		color: var(--muted);
	}
	.num {
		display: inline-flex;
		gap: 10px;
	}
	.in {
		color: var(--money-in);
	}
</style>
```

`CategoryTile.svelte` (tint via one class per category, no inline style):

```svelte
<script lang="ts">
	import { CATEGORIES, type CategoryKey } from './category';
	let { category, size = 40 }: { category: CategoryKey; size?: 36 | 40 } = $props();
</script>

<span class="tile s{size} c-{category}" aria-hidden="true">{CATEGORIES[category].emoji}</span>

<style>
	.tile {
		--c: var(--cat-lain);
		display: grid;
		flex: none;
		place-items: center;
		border-radius: var(--r-pill);
		background: color-mix(in srgb, var(--c) 16%, var(--bg));
	}
	.s40 {
		width: 40px;
		height: 40px;
		font-size: 20px;
	}
	.s36 {
		width: 36px;
		height: 36px;
		font-size: 18px;
	}
	.c-kopi { --c: var(--cat-kopi); }
	.c-makan { --c: var(--cat-makan); }
	.c-belanja-harian { --c: var(--cat-belanja-harian); }
	.c-belanja { --c: var(--cat-belanja); }
	.c-transportasi { --c: var(--cat-transportasi); }
	.c-tagihan { --c: var(--cat-tagihan); }
	.c-hiburan { --c: var(--cat-hiburan); }
	.c-kesehatan { --c: var(--cat-kesehatan); }
	.c-pendidikan { --c: var(--cat-pendidikan); }
	.c-tempat-tinggal { --c: var(--cat-tempat-tinggal); }
	.c-gaji { --c: var(--cat-gaji); }
	.c-bonus { --c: var(--cat-bonus); }
	.c-freelance { --c: var(--cat-freelance); }
	.c-hadiah { --c: var(--cat-hadiah); }
	.c-lain { --c: var(--cat-lain); }
</style>
```

(Prettier will expand the one-line rules; that is fine.)

`TransactionRow.svelte`:

```svelte
<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';
	import CategoryTile from './CategoryTile.svelte';
	import GroupRow from './GroupRow.svelte';
	import StatusTag from './StatusTag.svelte';
	import type { CategoryKey } from './category';

	let {
		title,
		meta,
		amountMinor,
		currency = 'IDR',
		category,
		status,
		href
	}: {
		title: string;
		meta: string;
		amountMinor: number;
		currency?: string;
		category: CategoryKey;
		status?: string;
		href?: string;
	} = $props();
</script>

<GroupRow {href}>
	<CategoryTile {category} />
	<span class="text">
		<span class="title">{title}</span>
		<span class="meta">{meta}</span>
		{#if status}<StatusTag>{status}</StatusTag>{/if}
	</span>
	<span class="amount num" class:income={amountMinor > 0}>
		{formatMoney(amountMinor, currency, 'signed')}
	</span>
</GroupRow>

<style>
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.title {
		overflow: hidden;
		font-size: 16px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
	}
	.amount {
		font-size: 16px;
		font-weight: 600;
		white-space: nowrap;
	}
	.income {
		color: var(--money-in);
	}
</style>
```

`ComparisonPill.svelte`:

```svelte
<script lang="ts">
	import { formatMoneyCompact } from '#lib/shared/money-format';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import { comparisonKind } from './category';

	let {
		diffMinor,
		monthName,
		avgPerDayMinor,
		sameThresholdMinor = 5_000_000
	}: {
		diffMinor: number;
		monthName: string;
		avgPerDayMinor?: number;
		sameThresholdMinor?: number;
	} = $props();

	const { trf } = useI18n();
	const kind = $derived(comparisonKind(diffMinor, sameThresholdMinor));
	const amount = $derived(formatMoneyCompact(Math.abs(diffMinor)));
</script>

<p class="pill {kind}">
	{#if kind === 'same'}
		{trf('Hampir sama dengan {bulan}', { bulan: monthName })}
	{:else}
		<Icon name={kind === 'more' ? 'arrow-up' : 'arrow-down'} size={14} />
		{kind === 'more' ? trf('{jumlah} lebih banyak', { jumlah: amount }) : trf('{jumlah} lebih hemat', { jumlah: amount })}
	{/if}
	{#if avgPerDayMinor !== undefined}
		<span class="avg">· {trf('rata-rata {jumlah}/hari', { jumlah: formatMoneyCompact(avgPerDayMinor) })}</span>
	{/if}
</p>

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		padding: 6px 14px;
		border-radius: var(--r-pill);
		background: var(--panel);
		font-size: 14px;
		font-weight: 600;
	}
	.same {
		color: var(--same);
	}
	.more {
		color: var(--money-up);
	}
	.less {
		color: var(--money-in);
	}
	.avg {
		color: var(--muted);
		font-weight: 400;
	}
</style>
```

`HeroBlock.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { formatMoney } from '#lib/shared/money-format';

	let {
		label,
		amountMinor,
		currency = 'IDR',
		children
	}: { label: string; amountMinor: number; currency?: string; children?: Snippet } = $props();

	// Split "Rp 1.264.000" into the symbol (superscript) and the figure.
	const parts = $derived(formatMoney(amountMinor, currency).split(' '));
</script>

<section class="hero">
	<p class="label">{label}</p>
	<p class="figure num">
		<span class="cur">{parts[0]}</span>{parts.slice(1).join(' ')}
	</p>
	{@render children?.()}
</section>

<style>
	.hero {
		display: grid;
		justify-items: center;
		gap: 10px;
		padding: 24px 0;
		text-align: center;
	}
	.label {
		margin: 0;
		color: var(--muted);
		font-size: 15px;
	}
	.figure {
		margin: 0;
		font-size: 52px;
		line-height: 1.05;
		font-weight: 700;
		letter-spacing: -0.045em;
	}
	.cur {
		margin-right: 0.08em;
		font-size: 0.42em;
		vertical-align: super;
		color: var(--muted);
		letter-spacing: 0;
	}
</style>
```

Add English entries to `i18n-en.ts`:

```ts
	Kopi: 'Coffee',
	'Makan & Minum': 'Food & Drink',
	'Belanja Harian': 'Groceries',
	Belanja: 'Shopping',
	Transportasi: 'Transport',
	Tagihan: 'Bills',
	Hiburan: 'Entertainment',
	Kesehatan: 'Health',
	Pendidikan: 'Education',
	'Tempat Tinggal': 'Housing',
	Gaji: 'Salary',
	Bonus: 'Bonus',
	Freelance: 'Freelance',
	Hadiah: 'Gifts',
	Lainnya: 'Other',
	'Hampir sama dengan {bulan}': 'About the same as {bulan}',
	'{jumlah} lebih banyak': '{jumlah} more',
	'{jumlah} lebih hemat': '{jumlah} less',
	'rata-rata {jumlah}/hari': 'avg {jumlah}/day',
```

- [ ] **Step 4: Gates and commit**

Run: `npm test && npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings && npm run lint`
Expected: all pass.

```bash
git add -A
git commit -m "feat(ui): component kit A - buttons, chips, lists, transaction row, hero

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Component kit B — inputs, feedback, charts, `/dev/ui`

**Files:**
- Create: `src/lib/shared/amount-input.ts`, `src/lib/ui/kit/chart-scale.ts`, `src/lib/ui/kit/TextInput.svelte`,
  `AmountInput.svelte`, `FloatingCard.svelte`, `Banner.svelte`, `Skeleton.svelte`, `ErrorState.svelte`,
  `BarChart.svelte`, `CategoryBar.svelte`, `MonthLines.svelte` (under `src/lib/ui/kit/`),
  `src/lib/server/dev.ts`, `src/routes/(app)/dev/ui/+page.server.ts`, `src/routes/(app)/dev/ui/+page.svelte`
- Modify: `src/lib/shared/i18n-en.ts`
- Test: `src/lib/shared/amount-input.test.ts`, `src/lib/ui/kit/chart-scale.test.ts`, `src/lib/server/dev.test.ts`

**Interfaces:**
- Produces:
  - `amountDigits(text: string): string` (digits only, max 13), `groupDigits(digits: string): string`,
    `digitsToMinor(digits: string, currency?: string): number | null`
  - `barHeights(values: readonly number[], maxHeight: number, minVisible?: number): number[]`
  - `stackSegments(values: readonly number[], width: number): { x: number; width: number }[]`
  - `linePoints(values: readonly number[], width: number, height: number, max: number): string`
  - `devRoutesEnabled(env: { DEV_ROUTES?: string } | undefined, isDev: boolean): boolean`
  - `AmountInput { valueMinor: number | null (bindable); label: string; currency?: 'IDR' }`
  - `BarChart { days: { label: string; minor: number }[]; selected?: number (bindable); label: string }`

- [ ] **Step 1: Failing tests**

`src/lib/shared/amount-input.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { amountDigits, digitsToMinor, groupDigits } from '#lib/shared/amount-input';

describe('amount input', () => {
	it('keeps digits only and drops leading zeros', () => {
		expect(amountDigits('Rp 25.000')).toBe('25000');
		expect(amountDigits('00120')).toBe('120');
		expect(amountDigits('abc')).toBe('');
	});
	it('caps at 13 digits (under Rp 10 triliun)', () => {
		expect(amountDigits('99999999999999999')).toBe('9999999999999');
	});
	it('groups with dots', () => {
		expect(groupDigits('1264000')).toBe('1.264.000');
		expect(groupDigits('')).toBe('');
	});
	it('converts whole rupiah digits to integer minor units', () => {
		expect(digitsToMinor('25000')).toBe(2_500_000);
		expect(digitsToMinor('')).toBeNull();
		expect(Number.isSafeInteger(digitsToMinor('9999999999999'))).toBe(true);
	});
});
```

`src/lib/ui/kit/chart-scale.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { barHeights, linePoints, stackSegments } from './chart-scale';

describe('barHeights', () => {
	it('handles empty and all-zero data', () => {
		expect(barHeights([], 100)).toEqual([]);
		expect(barHeights([0, 0, 0], 100)).toEqual([0, 0, 0]);
	});
	it('scales to the max and keeps small values visible', () => {
		expect(barHeights([50, 100, 1], 100, 2)).toEqual([50, 100, 2]);
	});
	it('treats negative values as zero', () => {
		expect(barHeights([-5, 10], 100)).toEqual([0, 100]);
	});
	it('works for a single day', () => {
		expect(barHeights([7], 80)).toEqual([80]);
	});
});

describe('stackSegments', () => {
	it('splits the width proportionally', () => {
		expect(stackSegments([1, 1, 2], 100)).toEqual([
			{ x: 0, width: 25 },
			{ x: 25, width: 25 },
			{ x: 50, width: 50 }
		]);
	});
	it('returns nothing for zero total', () => {
		expect(stackSegments([0, 0], 100)).toEqual([]);
	});
});

describe('linePoints', () => {
	it('maps values onto the box, top is max', () => {
		expect(linePoints([0, 10], 100, 50, 10)).toBe('0,50 100,0');
	});
	it('handles a single point and zero max', () => {
		expect(linePoints([5], 100, 50, 10)).toBe('0,25');
		expect(linePoints([0, 0], 100, 50, 0)).toBe('0,50 100,50');
	});
});
```

`src/lib/server/dev.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { devRoutesEnabled } from '#lib/server/dev';

describe('devRoutesEnabled', () => {
	it('is on in vite dev', () => {
		expect(devRoutesEnabled(undefined, true)).toBe(true);
	});
	it('is on only when DEV_ROUTES is exactly "1"', () => {
		expect(devRoutesEnabled({ DEV_ROUTES: '1' }, false)).toBe(true);
		expect(devRoutesEnabled({ DEV_ROUTES: 'true' }, false)).toBe(false);
		expect(devRoutesEnabled({}, false)).toBe(false);
		expect(devRoutesEnabled(undefined, false)).toBe(false);
	});
});
```

Run: `npx vitest run src/lib/shared/amount-input.test.ts src/lib/ui/kit/chart-scale.test.ts src/lib/server/dev.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 2: Implement the pure modules**

`src/lib/shared/amount-input.ts`:

```ts
const MAX_DIGITS = 13;

/** Whole-unit digits typed into an amount field. Not a general money parser (Phase 2 owns that). */
export function amountDigits(text: string): string {
	return text.replace(/\D/g, '').replace(/^0+/, '').slice(0, MAX_DIGITS);
}

export function groupDigits(digits: string): string {
	return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function digitsToMinor(digits: string, currency = 'IDR'): number | null {
	if (digits === '') return null;
	return Number(digits) * 10 ** currencyExponent(currency);
}
```

Add `import { currencyExponent } from './money-format';` at the top of the file.

`src/lib/ui/kit/chart-scale.ts`:

```ts
export function barHeights(values: readonly number[], maxHeight: number, minVisible = 2): number[] {
	const clean = values.map((v) => Math.max(0, v));
	const max = Math.max(0, ...clean);
	if (max === 0) return clean.map(() => 0);
	return clean.map((v) => (v === 0 ? 0 : Math.max(minVisible, Math.round((v / max) * maxHeight))));
}

export function stackSegments(values: readonly number[], width: number): { x: number; width: number }[] {
	const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
	if (total === 0) return [];
	let x = 0;
	return values.map((v) => {
		const w = (Math.max(0, v) / total) * width;
		const segment = { x, width: w };
		x += w;
		return segment;
	});
}

export function linePoints(values: readonly number[], width: number, height: number, max: number): string {
	const step = values.length > 1 ? width / (values.length - 1) : 0;
	return values
		.map((v, i) => {
			const y = max > 0 ? height - (Math.max(0, v) / max) * height : height;
			return `${Math.round(i * step * 100) / 100},${Math.round(y * 100) / 100}`;
		})
		.join(' ');
}
```

`src/lib/server/dev.ts`:

```ts
/** /dev/ui and /api/v1/dev/* exist only in `vite dev` or when the local-only var DEV_ROUTES is exactly "1". */
export function devRoutesEnabled(env: { DEV_ROUTES?: string } | undefined, isDev: boolean): boolean {
	return isDev || env?.DEV_ROUTES === '1';
}
```

Run the three tests again.
Expected: PASS.

- [ ] **Step 3: Components**

`TextInput.svelte`:

```svelte
<script lang="ts">
	let {
		label,
		value = $bindable(''),
		name,
		type = 'text',
		autocomplete
	}: {
		label: string;
		value?: string;
		name?: string;
		type?: 'text' | 'email' | 'search';
		autocomplete?: HTMLInputElement['autocomplete'];
	} = $props();
	const id = $props.id();
</script>

<label class="field" for={id}>
	<span class="label">{label}</span>
	<input {id} {name} {type} {autocomplete} bind:value class="input" />
</label>

<style>
	.field {
		display: grid;
		gap: 6px;
	}
	.label {
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.005em;
	}
	.input {
		height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
	}
	.input:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 0;
	}
</style>
```

`AmountInput.svelte`:

```svelte
<script lang="ts">
	import { amountDigits, digitsToMinor, groupDigits } from '#lib/shared/amount-input';

	let {
		label,
		valueMinor = $bindable(null)
	}: { label: string; valueMinor?: number | null } = $props();

	const id = $props.id();
	let text = $state('');

	function oninput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const digits = amountDigits(input.value);
		text = groupDigits(digits);
		input.value = text;
		valueMinor = digitsToMinor(digits);
	}
</script>

<label class="amount" for={id}>
	<span class="label">{label}</span>
	<span class="row">
		<span class="cur">Rp</span>
		<input {id} class="num" inputmode="numeric" autocomplete="off" value={text} {oninput} placeholder="0" />
	</span>
</label>

<style>
	.amount {
		display: grid;
		gap: 6px;
	}
	.label {
		font-size: 14px;
		font-weight: 600;
		color: var(--muted);
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: 6px;
	}
	.cur {
		font-size: 22px;
		font-weight: 600;
		color: var(--muted);
	}
	input {
		width: 100%;
		min-width: 0;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 52px;
		line-height: 1.05;
		font-weight: 700;
		letter-spacing: -0.045em;
	}
	input:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
		border-radius: var(--r-xs);
	}
</style>
```

`FloatingCard.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<div class="card">{@render children()}</div>

<style>
	.card {
		padding: 16px;
		border-radius: var(--r-m);
		background: var(--bg);
		box-shadow: var(--shadow-card);
	}
</style>
```

`Banner.svelte`:

```svelte
<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';

	let {
		icon,
		source,
		when,
		title,
		text
	}: { icon: IconName; source: string; when: string; title: string; text: string } = $props();
</script>

<div class="banner" role="status">
	<span class="icon"><Icon name={icon} size={20} /></span>
	<span class="body">
		<span class="top">{source} · {when}</span>
		<span class="title">{title}</span>
		<span class="text">{text}</span>
	</span>
</div>

<style>
	.banner {
		display: flex;
		gap: 12px;
		padding: 12px 14px;
		border-radius: 22px;
		background: var(--glass-bg);
		box-shadow: var(--glass-ring);
		backdrop-filter: var(--glass-blur);
		-webkit-backdrop-filter: var(--glass-blur);
	}
	.icon {
		display: grid;
		flex: none;
		place-items: center;
		width: 38px;
		height: 38px;
		border-radius: 28%;
		background: var(--ink);
		color: var(--bg);
	}
	.body {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.top {
		font-size: 12px;
		color: var(--muted);
	}
	.title {
		font-weight: 600;
	}
	.text {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 14px;
	}
</style>
```

`Skeleton.svelte`:

```svelte
<script lang="ts">
	let { rows = 3 }: { rows?: number } = $props();
</script>

<div class="skeleton" aria-hidden="true">
	{#each Array.from({ length: rows }, (_, i) => i) as i (i)}
		<div class="bar"></div>
	{/each}
</div>

<style>
	.skeleton {
		display: grid;
		gap: 10px;
	}
	.bar {
		height: 56px;
		border-radius: var(--r-s);
		background: var(--panel-2);
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.55;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar {
			animation: none;
		}
	}
</style>
```

`ErrorState.svelte`:

```svelte
<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from './Button.svelte';

	let { text, onretry }: { text: string; onretry: () => void } = $props();
	const { tr } = useI18n();
</script>

<div class="error" role="alert">
	<p>{text}</p>
	<Button variant="secondary" onclick={onretry}>{tr('Coba lagi')}</Button>
</div>

<style>
	.error {
		display: grid;
		justify-items: center;
		gap: 12px;
		padding: 32px 0;
		text-align: center;
	}
	p {
		margin: 0;
	}
</style>
```

`BarChart.svelte` (14 days; tapping a bar selects it and shows its figure; heights through SVG attributes):

```svelte
<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';
	import { barHeights } from './chart-scale';

	let {
		days,
		selected = $bindable(days.length - 1),
		label
	}: { days: { label: string; minor: number }[]; selected?: number; label: string } = $props();

	const H = 120;
	const W = 22;
	const GAP = 8;
	const heights = $derived(barHeights(days.map((d) => d.minor), H));
	const current = $derived(days[selected]);
</script>

<figure class="chart">
	<figcaption class="readout num">
		{#if current}<span class="day">{current.label}</span>{formatMoney(current.minor)}{/if}
	</figcaption>
	<div class="scroll">
		<svg
			width={days.length * (W + GAP)}
			height={H}
			viewBox="0 0 {days.length * (W + GAP)} {H}"
			role="group"
			aria-label={label}
		>
			{#each heights as h, i (i)}
				<rect
					x={i * (W + GAP)}
					y={H - h}
					width={W}
					height={h}
					rx="4"
					class:active={i === selected}
					role="button"
					tabindex="0"
					aria-label="{days[i]?.label}: {formatMoney(days[i]?.minor ?? 0)}"
					onclick={() => (selected = i)}
					onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (selected = i)}
				/>
			{/each}
		</svg>
	</div>
</figure>

<style>
	.chart {
		margin: 0;
	}
	.readout {
		display: flex;
		gap: 8px;
		margin-bottom: 8px;
		font-weight: 600;
	}
	.day {
		color: var(--muted);
		font-weight: 400;
	}
	.scroll {
		overflow-x: auto;
		overscroll-behavior-x: contain;
	}
	rect {
		fill: var(--chart-bar);
		cursor: pointer;
	}
	rect.active {
		fill: var(--ink);
	}
</style>
```

`CategoryBar.svelte`:

```svelte
<script lang="ts">
	import type { CategoryKey } from './category';
	import { stackSegments } from './chart-scale';

	let {
		parts,
		label
	}: { parts: { category: CategoryKey; minor: number }[]; label: string } = $props();
	const segments = $derived(stackSegments(parts.map((p) => p.minor), 100));
</script>

<svg class="bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label={label}>
	{#each segments as s, i (i)}
		<rect x={s.x} y="0" width={s.width} height="10" class="c-{parts[i]?.category}" />
	{/each}
</svg>

<style>
	.bar {
		display: block;
		width: 100%;
		height: 12px;
		border-radius: var(--r-pill);
		background: var(--chart-track);
	}
	.c-kopi { fill: var(--cat-kopi); }
	.c-makan { fill: var(--cat-makan); }
	.c-belanja-harian { fill: var(--cat-belanja-harian); }
	.c-belanja { fill: var(--cat-belanja); }
	.c-transportasi { fill: var(--cat-transportasi); }
	.c-tagihan { fill: var(--cat-tagihan); }
	.c-hiburan { fill: var(--cat-hiburan); }
	.c-kesehatan { fill: var(--cat-kesehatan); }
	.c-pendidikan { fill: var(--cat-pendidikan); }
	.c-tempat-tinggal { fill: var(--cat-tempat-tinggal); }
	.c-gaji { fill: var(--cat-gaji); }
	.c-bonus { fill: var(--cat-bonus); }
	.c-freelance { fill: var(--cat-freelance); }
	.c-hadiah { fill: var(--cat-hadiah); }
	.c-lain { fill: var(--cat-lain); }
</style>
```

`MonthLines.svelte`:

```svelte
<script lang="ts">
	import { linePoints } from './chart-scale';

	let {
		thisMonth,
		lastMonth,
		label
	}: { thisMonth: number[]; lastMonth: number[]; label: string } = $props();

	const W = 300;
	const H = 120;
	const max = $derived(Math.max(0, ...thisMonth, ...lastMonth));
</script>

<svg viewBox="0 0 {W} {H}" class="lines" role="img" aria-label={label}>
	<polyline points={linePoints(lastMonth, W, H, max)} class="last" />
	<polyline points={linePoints(thisMonth, W, H, max)} class="this" />
</svg>

<style>
	.lines {
		display: block;
		width: 100%;
		height: auto;
	}
	polyline {
		fill: none;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.this {
		stroke: var(--ink);
	}
	.last {
		stroke: var(--faint);
	}
</style>
```

- [ ] **Step 4: `/dev/ui` preview (dev-only)**

`src/routes/(app)/dev/ui/+page.server.ts`:

```ts
import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import { devRoutesEnabled } from '#lib/server/dev';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ platform }) => {
	if (!devRoutesEnabled(platform?.env as { DEV_ROUTES?: string } | undefined, dev)) error(404);
	return {};
};
```

`src/routes/(app)/dev/ui/+page.svelte` — every component and variant with fictional values (`Data demo`):

```svelte
<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import BarChart from '#lib/ui/kit/BarChart.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryBar from '#lib/ui/kit/CategoryBar.svelte';
	import Chip from '#lib/ui/kit/Chip.svelte';
	import ComparisonPill from '#lib/ui/kit/ComparisonPill.svelte';
	import DayHeader from '#lib/ui/kit/DayHeader.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import FloatingCard from '#lib/ui/kit/FloatingCard.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import HeroBlock from '#lib/ui/kit/HeroBlock.svelte';
	import MonthLines from '#lib/ui/kit/MonthLines.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
	import TextInput from '#lib/ui/kit/TextInput.svelte';
	import TransactionRow from '#lib/ui/kit/TransactionRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	const { tr } = useI18n();
	let period = $state('bulan');
	let amount: number | null = $state(null);
	const days = Array.from({ length: 14 }, (_, i) => ({
		label: `${i + 1} Okt`,
		minor: [8, 12, 0, 25, 6, 18, 9, 30, 4, 11, 0, 16, 22, 7][i]! * 1_000_000
	}));
</script>

<svelte:head><title>UI kit</title></svelte:head>
<ScreenTitle title="UI kit" />
<p><Badge>{tr('Data demo')}</Badge></p>

<section>
	<h2>Button</h2>
	<div class="row">
		<Button size="lg">{tr('Simpan')}</Button>
		<Button variant="secondary">{tr('Batal')}</Button>
		<Button variant="ghost" size="sm">{tr('Lewati')}</Button>
		<Button variant="destructive">{tr('Hapus')}</Button>
		<Button disabled>{tr('Simpan')}</Button>
	</div>
</section>

<section>
	<h2>Chip · Segmented · Badge · StatusTag</h2>
	<div class="row">
		<Chip selected count={128}>{tr('Semua')}</Chip>
		<Chip count={121}>{tr('Keluar')}</Chip>
		<Chip count={7}>{tr('Masuk')}</Chip>
	</div>
	<Segmented
		label={tr('Periode')}
		bind:value={period}
		options={[
			{ value: 'bulan', label: tr('Bulan ini') },
			{ value: 'periode', label: tr('Periode ini') }
		]}
	/>
	<p><StatusTag>{tr('Tercatat')}</StatusTag></p>
</section>

<section>
	<h2>HeroBlock · ComparisonPill</h2>
	<HeroBlock label={tr('Pengeluaran Oktober')} amountMinor={126_400_000}>
		<ComparisonPill diffMinor={-8_000_000} monthName="September" avgPerDayMinor={20_300_000} />
	</HeroBlock>
	<div class="row">
		<ComparisonPill diffMinor={12_000_000} monthName="September" />
		<ComparisonPill diffMinor={1_000_000} monthName="September" />
	</div>
</section>

<section>
	<h2>GroupList · DayHeader · TransactionRow</h2>
	<DayHeader label={tr('Hari ini')} inMinor={950_000_000} outMinor={4_000_000} />
	<GroupList>
		<TransactionRow title="Kopi susu" meta="Kopi · GoPay" amountMinor={-2_500_000} category="kopi" status={tr('Tercatat')} href="/riwayat" />
		<TransactionRow title="Parkir" meta="Transportasi · Tunai" amountMinor={-500_000} category="transportasi" />
		<TransactionRow title="Gaji Oktober" meta="Gaji · BCA" amountMinor={950_000_000} category="gaji" />
	</GroupList>
</section>

<section>
	<h2>Inputs</h2>
	<TextInput label={tr('Catatan')} />
	<AmountInput label={tr('Jumlah')} bind:valueMinor={amount} />
	<p class="num">amount_minor = {amount ?? '—'}</p>
</section>

<section>
	<h2>FloatingCard · Banner · Skeleton · ErrorState</h2>
	<FloatingCard><strong>Kopi susu</strong> −Rp 25.000</FloatingCard>
	<Banner icon="mail" source="Montra" when={tr('baru saja')} title={tr('Dicatat dari Gmail')} text="QRIS · Kopi susu · Rp 25.000" />
	<Skeleton rows={2} />
	<ErrorState text={tr('Terjadi kesalahan. Coba lagi.')} onretry={() => {}} />
</section>

<section>
	<h2>Charts</h2>
	<BarChart {days} label={tr('Pengeluaran 14 hari terakhir')} />
	<CategoryBar
		label={tr('Pengeluaran per kategori')}
		parts={[
			{ category: 'makan', minor: 40 },
			{ category: 'kopi', minor: 15 },
			{ category: 'transportasi', minor: 25 },
			{ category: 'tagihan', minor: 20 }
		]}
	/>
	<MonthLines label={tr('Bulan ini dibanding bulan lalu')} thisMonth={[0, 8, 20, 45, 51, 70]} lastMonth={[0, 12, 25, 31, 55, 62, 80, 95]} />
</section>

<style>
	section {
		display: grid;
		gap: 12px;
		padding: 16px 0;
		border-bottom: 1px solid var(--line);
	}
	h2 {
		margin: 0;
		font-size: 19px;
		font-weight: 600;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
```

Add English entries:

```ts
	'Data demo': 'Demo data',
	Simpan: 'Save',
	Batal: 'Cancel',
	Lewati: 'Skip',
	Hapus: 'Delete',
	Semua: 'All',
	Keluar: 'Out',
	Periode: 'Period',
	'Bulan ini': 'This month',
	'Periode ini': 'This period',
	Tercatat: 'Recorded',
	'Pengeluaran Oktober': 'October spending',
	'Hari ini': 'Today',
	Catatan: 'Note',
	Jumlah: 'Amount',
	'baru saja': 'just now',
	'Dicatat dari Gmail': 'Recorded from Gmail',
	'Coba lagi': 'Try again',
	'Pengeluaran 14 hari terakhir': 'Spending, last 14 days',
	'Pengeluaran per kategori': 'Spending by category',
	'Bulan ini dibanding bulan lalu': 'This month versus last month',
```

(`Masuk` already exists from Task 8.)

- [ ] **Step 5: Gates and commit**

Run: `npm test && npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings && npm run lint && npm run build`
Expected: all pass.

Run: `npm run dev` and open `http://localhost:5173/dev/ui` in light and dark (DevTools → Rendering →
prefers-color-scheme). Expected: every component renders; no layout overflow at 360 px. Stop the server.

```bash
git add -A
git commit -m "feat(ui): component kit B - inputs, feedback, SVG charts and /dev/ui preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: inbound Worker + dev ping route (queue round trip)

**Files:**
- Create: `workers/inbound/wrangler.jsonc`, `workers/inbound/tsconfig.json`, `workers/inbound/src/index.ts`,
  `workers/inbound/src/decide.ts`, `src/routes/api/v1/dev/ping/+server.ts`
- Generated (committed): `workers/inbound/worker-configuration.d.ts`
- Test: `workers/inbound/src/decide.test.ts`

**Interfaces:**
- Consumes: `devRoutesEnabled` (Task 10), `JobMessage` (Task 6), `app_meta.last_ping` (Task 6).
- Produces: `MAX_INBOUND_BYTES = 5 * 1024 * 1024`; `inboundDecision(rawSize: number): { action: 'reject'; reason: string } | { action: 'drop' }`;
  `POST /api/v1/dev/ping` → `{ id }`; `GET /api/v1/dev/ping?id=…` → `{ received: boolean }`.

- [ ] **Step 1: Failing test**

`workers/inbound/src/decide.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { inboundDecision, MAX_INBOUND_BYTES } from './decide';

describe('inboundDecision', () => {
	it('rejects messages over the cap with a reason', () => {
		const d = inboundDecision(MAX_INBOUND_BYTES + 1);
		expect(d.action).toBe('reject');
		expect(d.action === 'reject' && d.reason.length).toBeGreaterThan(0);
	});
	it('drops messages at or under the cap (real path arrives with FN-19)', () => {
		expect(inboundDecision(MAX_INBOUND_BYTES)).toEqual({ action: 'drop' });
		expect(inboundDecision(0)).toEqual({ action: 'drop' });
	});
});
```

Run: `npx vitest run workers/inbound`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement the inbound Worker**

`workers/inbound/src/decide.ts`:

```ts
export const MAX_INBOUND_BYTES = 5 * 1024 * 1024;

export function inboundDecision(
	rawSize: number
): { action: 'reject'; reason: string } | { action: 'drop' } {
	if (rawSize > MAX_INBOUND_BYTES) return { action: 'reject', reason: 'Message too large' };
	return { action: 'drop' };
}
```

`workers/inbound/src/index.ts`:

```ts
import { inboundDecision } from './decide';

export default {
	async email(message) {
		const decision = inboundDecision(message.rawSize);
		if (decision.action === 'reject') message.setReject(decision.reason);
		// 'drop': the body is never read until FN-19 adds the forwarding path.
	}
} satisfies ExportedHandler<Env>;
```

`workers/inbound/wrangler.jsonc`:

```jsonc
{
	"$schema": "../../node_modules/wrangler/config-schema.json",
	"name": "financer-inbound",
	"main": "src/index.ts",
	"compatibility_date": "2026-10-01",
	"observability": { "enabled": true },
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "montra",
			"database_id": "00000000-0000-4000-8000-000000000000",
			"migrations_dir": "../../migrations"
		}
	]
}
```

`workers/inbound/tsconfig.json`: same content as `workers/jobs/tsconfig.json` (Task 6 Step 3), copied verbatim.

Run: `npx wrangler types -c workers/inbound/wrangler.jsonc workers/inbound/worker-configuration.d.ts && npx vitest run workers/inbound && npx tsc -p workers/inbound/tsconfig.json`
Expected: PASS and tsc exit 0.

- [ ] **Step 3: Dev ping route**

`src/routes/api/v1/dev/ping/+server.ts`:

```ts
import { dev } from '$app/environment';
import { error, json } from '@sveltejs/kit';
import { devRoutesEnabled } from '#lib/server/dev';
import type { JobMessage } from '#lib/shared/jobs';
import type { RequestHandler } from './$types';

function guard(platform: App.Platform | undefined): App.Platform {
	if (!platform || !devRoutesEnabled(platform.env as { DEV_ROUTES?: string }, dev)) error(404);
	return platform;
}

export const POST: RequestHandler = async ({ platform }) => {
	const { env } = guard(platform);
	const message: JobMessage = { type: 'ping', id: crypto.randomUUID() };
	await env.JOBS_QUEUE.send(message);
	return json({ id: message.id });
};

export const GET: RequestHandler = async ({ platform, url }) => {
	const { env } = guard(platform);
	const id = url.searchParams.get('id') ?? '';
	const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'last_ping'").first<{
		value: string;
	}>();
	return json({ received: row?.value === id });
};
```

- [ ] **Step 4: Round trip across the three Workers**

Run: `npm run build && FIN_PERSIST_TO=.wrangler/state npm run db:migrate:local` then
`npx wrangler dev -c wrangler.jsonc -c workers/jobs/wrangler.jsonc -c workers/inbound/wrangler.jsonc --persist-to .wrangler/state --port 8787 --var DEV_ROUTES:1`
(background). Then:

```bash
ID=$(curl -s -X POST -H 'Origin: http://localhost:8787' http://localhost:8787/api/v1/dev/ping | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
sleep 3; curl -s "http://localhost:8787/api/v1/dev/ping?id=$ID"
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/dev/ui
```

Expected: `{"received":true}` and `200`. Restart without `--var DEV_ROUTES:1` and confirm both
`/api/v1/dev/ping` and `/dev/ui` return `404`. If `--var` is not applied to the primary Worker in multi-config
mode, put `DEV_ROUTES=1` in a local `.dev.vars` instead (gitignored) and note that in the RUNBOOK.

- [ ] **Step 5: Full gates and commit**

Run: `npm run gates`
Expected: check, lint, test, build all pass (this is the first run of the complete `check` script).

```bash
git add -A
git commit -m "feat(workers): inbound Worker skeleton and dev-only queue ping round trip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Playwright journeys on `wrangler dev`

**Files:**
- Create: `playwright.config.ts`, `e2e/shell.spec.ts`, `e2e/site.spec.ts`, `e2e/security.spec.ts`,
  `e2e/kit.spec.ts`, `e2e/helpers.ts`

**Interfaces:**
- Consumes: all routes; `DEV_ROUTES` var; `FIN_PERSIST_TO` env for the migrate script.

- [ ] **Step 1: Config**

`playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

const PORT = 8787;

export default defineConfig({
	testDir: 'e2e',
	fullyParallel: true,
	retries: process.env.CI ? 1 : 0,
	use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
	webServer: {
		command: [
			'npm run build',
			'rm -rf .wrangler/e2e-state',
			'FIN_PERSIST_TO=.wrangler/e2e-state node scripts/migrate-local.ts',
			`npx wrangler dev -c wrangler.jsonc -c workers/jobs/wrangler.jsonc -c workers/inbound/wrangler.jsonc --persist-to .wrangler/e2e-state --port ${PORT} --var DEV_ROUTES:1`
		].join(' && '),
		url: `http://localhost:${PORT}/api/v1/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 240_000
	},
	projects: [
		{ name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 } } },
		{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }
	]
});
```

Run: `npx playwright install chromium`
Expected: browser installed (a one-time download).

`e2e/helpers.ts`:

```ts
import { expect, type Page } from '@playwright/test';

export function collectCspViolations(page: Page): string[] {
	const violations: string[] = [];
	page.on('console', (m) => {
		if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
	});
	return violations;
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
}

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;
```

- [ ] **Step 2: Shell journeys**

`e2e/shell.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { collectCspViolations, expectNoHorizontalScroll, isPhone } from './helpers';

const TABS = [
	{ path: '/', title: 'Beranda' },
	{ path: '/riwayat', title: 'Riwayat' },
	{ path: '/laporan', title: 'Laporan' },
	{ path: '/kekayaan', title: 'Kekayaan' }
];

for (const tab of TABS) {
	test(`${tab.title} renders with active nav and no overflow`, async ({ page }) => {
		const csp = collectCspViolations(page);
		await page.goto(tab.path);
		await expect(page.getByRole('heading', { level: 1, name: tab.title })).toBeVisible();
		const nav = page.getByRole('navigation', { name: 'Navigasi utama' }).filter({ visible: true });
		await expect(nav.getByRole('link', { name: tab.title })).toHaveAttribute('aria-current', 'page');
		await expectNoHorizontalScroll(page);
		expect(csp).toEqual([]);
	});
}

test('phone shows the tab bar with 44 px targets; desktop shows the sidebar', async ({ page }) => {
	await page.goto('/');
	const nav = page.getByRole('navigation', { name: 'Navigasi utama' }).filter({ visible: true });
	await expect(nav).toHaveCount(1);
	const links = nav.getByRole('link');
	if (isPhone(page)) {
		await expect(links).toHaveCount(4);
		for (const box of await Promise.all((await links.all()).map((l) => l.boundingBox()))) {
			expect(box!.height).toBeGreaterThanOrEqual(44);
			expect(box!.width).toBeGreaterThanOrEqual(44);
		}
	} else {
		await expect(links).toHaveCount(7);
	}
});

test('Tambah sheet opens, lists the capture paths, closes with Esc and returns focus', async ({ page }) => {
	await page.goto('/');
	const add = page.getByRole('button', { name: 'Tambah' }).filter({ visible: true });
	await add.click();
	const dialog = page.getByRole('dialog', { name: 'Tambah transaksi' });
	await expect(dialog).toBeVisible();
	for (const name of ['Otomatis', 'Suara', 'Struk', 'Mutasi', 'Ketik manual']) {
		await expect(dialog.getByRole('button', { name: new RegExp(name) })).toBeDisabled();
	}
	await expect(dialog.getByText('Segera hadir').first()).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(add).toBeFocused();
});

test('Tambah sheet closes with the close button', async ({ page }) => {
	await page.goto('/riwayat');
	await page.getByRole('button', { name: 'Tambah' }).filter({ visible: true }).click();
	await page.getByRole('button', { name: 'Tutup' }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
});

test('stub routes show Segera hadir and unknown routes 404', async ({ page }) => {
	await page.goto('/tanya');
	await expect(page.getByRole('heading', { level: 1, name: 'Tanya' })).toBeVisible();
	await expect(page.getByText('Segera hadir')).toBeVisible();
	const res = await page.goto('/tidak-ada');
	expect(res?.status()).toBe(404);
	await expect(page.getByText('Halaman tidak ditemukan.')).toBeVisible();
});

test('English via the lang cookie', async ({ page, context }) => {
	await context.addCookies([{ name: 'lang', value: 'en', url: 'http://localhost:8787' }]);
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
});

test('dark scheme follows the system; the theme cookie overrides it', async ({ browser }) => {
	const dark = await browser.newContext({ colorScheme: 'dark' });
	const page = await dark.newPage();
	await page.goto('http://localhost:8787/');
	const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	expect(await bg()).toBe('rgb(17, 17, 18)');
	await dark.addCookies([{ name: 'theme', value: 'light', url: 'http://localhost:8787' }]);
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	expect(await bg()).toBe('rgb(255, 255, 255)');
	await dark.close();
});

test('pages render without JavaScript', async ({ browser }) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	const page = await context.newPage();
	await page.goto('http://localhost:8787/riwayat');
	await expect(page.getByRole('heading', { level: 1, name: 'Riwayat' })).toBeVisible();
	await context.close();
});
```

The `body` background check requires `body { background: var(--bg) }`; if `html` carries the colour instead, add
`background: var(--bg);` to the `body` rule in `src/app.css`.

- [ ] **Step 3: Site and security journeys**

`e2e/site.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { collectCspViolations, expectNoHorizontalScroll } from './helpers';

const SITE = 'http://site.localhost:8787';

test('site home renders with header and footer links', async ({ page }) => {
	const csp = collectCspViolations(page);
	await page.goto(`${SITE}/`);
	await expect(page.getByRole('heading', { level: 1, name: 'Catat uang tanpa repot' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Mulai gratis' })).toHaveAttribute('href', 'http://localhost:8787');
	await expectNoHorizontalScroll(page);
	expect(csp).toEqual([]);
});

test('legal pages render on the site host', async ({ page }) => {
	await page.goto(`${SITE}/`);
	await page.getByRole('link', { name: 'Privasi' }).click();
	await expect(page).toHaveURL(`${SITE}/privasi`);
	await expect(page.getByRole('heading', { level: 1, name: 'Kebijakan privasi' })).toBeVisible();
	for (const path of ['/ketentuan', '/hapus-akun', '/blog']) {
		const res = await page.goto(`${SITE}${path}`);
		expect(res?.status()).toBe(200);
	}
});

test('the site tree is not reachable on the app host', async ({ page }) => {
	for (const path of ['/site', '/site/privasi']) {
		const res = await page.goto(path);
		expect(res?.status()).toBe(404);
	}
});
```

`e2e/security.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('security headers and CSP on an app page', async ({ request }) => {
	const res = await request.get('/');
	const h = res.headers();
	expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(h['content-security-policy']).toContain("object-src 'none'");
	expect(h['content-security-policy']).not.toContain('unsafe-inline');
	expect(h['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
	expect(h['x-content-type-options']).toBe('nosniff');
	expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
	expect(h['cross-origin-opener-policy']).toBe('same-origin');
	expect(h['permissions-policy']).toContain('geolocation=()');
});

test('health reports the database and leaks nothing', async ({ request }) => {
	const res = await request.get('/api/v1/health');
	expect(res.status()).toBe(200);
	expect(await res.json()).toEqual({ ok: true, db: true, version: '0.0.1' });
});

test('queue ping round trip through the jobs Worker', async ({ request }) => {
	const sent = await request.post('/api/v1/dev/ping', { headers: { origin: 'http://localhost:8787' } });
	expect(sent.status()).toBe(200);
	const { id } = (await sent.json()) as { id: string };
	await expect
		.poll(async () => ((await (await request.get(`/api/v1/dev/ping?id=${id}`)).json()) as { received: boolean }).received, {
			timeout: 15_000
		})
		.toBe(true);
});
```

`e2e/kit.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { collectCspViolations, expectNoHorizontalScroll, isPhone } from './helpers';

for (const colorScheme of ['light', 'dark'] as const) {
	test(`/dev/ui renders in ${colorScheme} without overflow or CSP violations`, async ({ browser }) => {
		const context = await browser.newContext({ colorScheme, viewport: { width: 360, height: 780 } });
		const page = await context.newPage();
		const csp = collectCspViolations(page);
		await page.goto('http://localhost:8787/dev/ui');
		await expect(page.getByRole('heading', { level: 1, name: 'UI kit' })).toBeVisible();
		await expect(page.getByText('Data demo')).toBeVisible();
		await expectNoHorizontalScroll(page);
		expect(csp).toEqual([]);
		await context.close();
	});
}

test('kit controls meet 44 px targets on phone', async ({ page }) => {
	test.skip(!isPhone(page), 'phone only');
	await page.goto('/dev/ui');
	const controls = page.locator('main button:not([disabled]), main [role="radio"]');
	for (const control of await controls.all()) {
		const box = await control.boundingBox();
		if (box) expect(box.height, await control.innerText()).toBeGreaterThanOrEqual(40);
	}
});

test('AmountInput produces integer minor units', async ({ page }) => {
	await page.goto('/dev/ui');
	await page.getByLabel('Jumlah').fill('25000');
	await expect(page.getByText('amount_minor = 2500000')).toBeVisible();
	await expect(page.getByLabel('Jumlah')).toHaveValue('25.000');
});
```

(`sm` buttons are 40 px high by design; the check uses 40 px for kit controls, 44 px for navigation.)

- [ ] **Step 4: Run**

Run: `npm run test:e2e`
Expected: all tests pass in both projects. On failure, read the trace (`npx playwright show-trace
test-results/…/trace.zip`), fix the cause in the owning task's files, and rerun. Never loosen an assertion to pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(e2e): Playwright journeys for shell, site host, security headers, queue and UI kit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Staging guard, RUNBOOK and trackers

**Files:**
- Create: `scripts/deploy-staging.ts`
- Modify: `docs/RUNBOOK.md`, `docs/TASKS.md`, `docs/HISTORY.md`, `docs/ACCEPTANCE.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: Deploy guard**

`scripts/deploy-staging.ts`:

```ts
/**
 * Staging is not configured yet: it needs the owner's Cloudflare account (docs/TASKS.md). This script exits
 * non-zero until the staging section of docs/RUNBOOK.md is filled in and real resource ids replace the placeholders.
 */
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const { readFileSync } = await import('node:fs');
if (readFileSync('wrangler.jsonc', 'utf8').includes(PLACEHOLDER)) {
	console.error('deploy:staging: staging is not configured (placeholder D1 id in wrangler.jsonc). See docs/RUNBOOK.md.');
	process.exit(1);
}
console.error('deploy:staging: staging environments are not defined yet. See docs/RUNBOOK.md.');
process.exit(1);
```

Run: `npm run deploy:staging; echo "exit=$?"`
Expected: the "not configured" message and `exit=1`.

- [ ] **Step 2: RUNBOOK**

Replace `docs/RUNBOOK.md` with sections: **Local setup** (Node ≥ 22, `npm ci`, `cp .dev.vars.example .dev.vars`,
`npm run db:reset:local`, `npm run dev` for the UI on `localhost:5173` and `site.localhost:5173`), **Three Workers
locally** (`npm run build && npm run dev:workers`; ports; `--test-scheduled` for cron), **Migrations** (generate with
`npm run db:generate -- --name <name>`; apply locally with `npm run db:migrate:local`; never edit an applied migration;
remote apply is a separate, manual step: create a D1 Time Travel bookmark first with
`wrangler d1 time-travel info montra`, then `wrangler d1 migrations apply montra --remote` — only on the owner's
instruction), **Seed and reset** (local only; the guard refuses `--remote`, `--env`, `-e`, `--preview`),
**Tests** (`npm run gates`; `npm run test:e2e` builds, migrates `.wrangler/e2e-state` and starts all three
Workers), **Secrets** (names only: `DEV_ROUTES` local only; later FNs add theirs here), **Staging** (not configured:
needs the Cloudflare account; `deploy:staging` exits 1 until then), **Types** (`npm run types:cf` after any
binding change). Every command in it must have been run in this plan, except the remote ones, which are marked
"not run".

- [ ] **Step 3: Trackers**

- `docs/TASKS.md`: tick and remove the FN-00 and component-kit items; keep staging open (blocked by the Cloudflare
  account); add a **Phase 0 review** item for the owner (per-phase review). Update the status summary and the
  "Last updated" line.
- `docs/HISTORY.md`: add a **FN-00 Foundation + component kit (2026-10-…)** entry under Completed work, and under
  Test evidence log the exact summary lines from `npm run gates` and `npm run test:e2e` (test counts, pass/fail).
- `docs/ACCEPTANCE.md` Design rows: `Tokens … AA contrast both themes` → **Automated** with check
  `test/contrast.test.ts`; `360 px layout, 44 px touch targets, reduced motion` → **Browser** with check
  `e2e/shell.spec.ts`, `e2e/kit.spec.ts` (reduced motion is CSS-only; say "reduced motion not browser-tested").
  Change no other row.
- `docs/ARCHITECTURE.md`: under Data model add "IDR uses the ISO 4217 exponent 2: `amount_minor` is sen (Rp 25.000 =
  2 500 000). Display drops `,00`." and under Runtime map note "SvelteKit 3 config lives in `vite.config.ts`;
  shared code is imported as `#lib/*`."

- [ ] **Step 4: Final verification and commit**

Run: `npm run gates && npm run test:e2e`
Expected: both pass. Quote the summary lines in HISTORY.

```bash
git add -A
git commit -m "docs: FN-00 runbook, staging guard and tracker updates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
