# Security report: CI/CD (chore/ci-cd, HEAD 9de5b1f, base main 3265fb6)

Scope: `git diff main...HEAD` — `.github/workflows/{ci,deploy-staging,codeql}.yml`, `.github/dependabot.yml`,
`.staging.env.example`, `scripts/deploy-staging.ts` (+ test), the three `wrangler.jsonc`, `.gitignore`,
`docs/RUNBOOK.md` › CI/CD, plus a value grep of the whole tracked tree and of git history. Reviewer: red team,
2026-10-13. Nothing remote was changed (read-only `gh api` GETs only; no push, no deploy).

## Verdict: FAIL

Two medium findings, both about real identifiers that would become public with the repository. The workflows,
the deploy script and the permissions are sound.

## Findings

### M1 (medium): the tracked tree still holds the owner's workers.dev subdomain and the staging host

- `docs/HISTORY.md:555` holds the full `montra-app-staging.<owner-subdomain>.workers.dev` address. The subdomain is
  derived from the owner's personal e-mail (PII). It also gives the direct workers.dev route. Staging keeps
  `workers_dev: true`, so that route bypasses any zone-level WAF, rate-limit or Access rule on the custom domain.
- The real staging host appears 9 times: `docs/TASKS.md:12,15,23,29,34,40,44,364` and `docs/HISTORY.md:598`.
- This contradicts `docs/RUNBOOK.md:396`: "no real account id, resource id, staging hostname or workers.dev
  subdomain is committed."
- Reproduce: `git ls-files -z | xargs -0 grep -c <value from .staging.env>`.
- Fix: replace these values with `<staging-app-host>` / `<subdomain>`. Then decide whether to set
  `workers_dev: false` for the staging app.

The host alone is low risk because Certificate Transparency logs already reveal custom domains. The subdomain is
what makes this finding medium.

### M2 (medium): git history still holds every real id

The current tree is clean of the account, D1 and KV ids, but history is not. `git log --all -S<value>` finds:

| Value | Commits |
| ----- | ------- |
| account id | 5 |
| D1 id | 2 |
| KV id | 2 |
| staging host | 17 |

Making this repository public with its history publishes all of these values, whatever HEAD says.

None of these values is a credential: an API token is still needed to use any of them. Still, this branch exists
to keep them out of the public repository, and it does not achieve that on its own.

Fix (owner decision, before the visibility switch): publish a fresh, squashed history, or rewrite history with
`git filter-repo --replace-text`. Never force-push the private remote without the owner's explicit approval.

### L1 (low): the host is printed before it is masked

At `.github/workflows/deploy-staging.yml:44-48`, `STAGING_APP_HOST` comes from `vars`, which GitHub does not mask.

GitHub prints a step's `env:` block in the step header, before the step runs. So the "Mask staging host" step logs
the plain host before `::add-mask::` runs, and Actions logs are public in a public repository.

Fix: store `STAGING_APP_HOST` as an environment secret instead, and keep the mask step as a guard. Optionally add
the workers.dev subdomain as a secret, so it is masked as well as removed by `sed`.

Dry-run check: wrangler does print the KV id (twice) and the host (once). In CI both are masked: the KV id
because it is a secret, the host after the mask step. Wrangler printed no account id and no D1 id. The `sed`
filter removed every workers.dev address.

### L2 (low): generated configs survive a signal

At `scripts/deploy-staging.ts:229-234`, the `finally` block runs on errors but not when SIGINT or SIGTERM kills
Node during a `execFileSync` call. After a Ctrl-C, or a cancelled CI job, `wrangler.staging.generated.jsonc`
files holding the real ids stay on disk.

They are gitignored (`.gitignore:45` matches the file name in every directory; checked with `git check-ignore`),
so the risk is low.

Fix: add `process.on('SIGINT'|'SIGTERM')` handlers that remove the files and then exit with 130/143. Also clean
up stale generated files when the script starts.

### L3 (low): a tag on a commit outside `main` can deploy after approval

The tag check (`deploy-staging.yml:37-41`) compares only the tag name with `package.json`. Anyone with write access
can push `v0.11.0` on an unmerged branch commit with the same version. That code reaches staging and its secrets
once the reviewer approves.

Fix:
- Add a ruleset that restricts creating `v*` tags to the owner.
- In the job, check `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` (needs `fetch-depth: 0`, or a fetch
  of `main`).

### L4 (low): the deploy step exposes the API token to more code than needed

- `npm run deploy:staging` runs `vite build`, with every build plugin and dependency, while
  `CLOUDFLARE_API_TOKEN` is in the environment.
- The deploy job also restores the npm cache from `main`. A pull request cannot poison that cache: PR caches are
  scoped to `refs/pull/N/merge`, and `npm ci` checks integrity against the lockfile.

Hardening: drop `cache: npm` in the deploy job, build in a step without the token, and let `deploy:staging` skip
the rebuild.

### L5 (low): `/ship` and the tag workflow both deploy

`/ship` deploys from the local machine and then pushes the `v*` tag, so `deploy-staging.yml` starts as well.

- Migrations cannot apply twice in sequence: `wrangler d1 migrations apply` records each one in `d1_migrations`,
  so a re-run does nothing.
- The workflow `concurrency` group only covers workflow runs, not the local deploy. If the reviewer approves while
  the local deploy is still running, two `migrations apply` calls can race on the same pending migration.
- Approving later re-deploys the tagged commit. That silently undoes any `wrangler rollback` done after the local
  deploy.
- `.claude/commands/ship.md:12` calls `npm run db:migrate:staging`, which does not exist in `package.json`.

**Safest default:** make the tag workflow the only deploy path. `/ship` writes the release commit, pushes `main`
and the tag, and stops. The approval gate and the `deploy-staging` concurrency group then cover every deploy, and
the bookmark lands in the job summary. Keep the local `npm run deploy:staging` only as a documented break-glass
step. Until then, the RUNBOOK rule "reviewer rejects the tag run after a local `/ship` deploy" stays, and the
reviewer must never approve while a local deploy is running.

### L6 (info): Playwright artifacts

The `playwright-report` and `test-results` artifacts (`ci.yml:102-111`, `trace: retain-on-failure`) are public in
a public repository. They contain fictional sign-up data, a localhost session cookie and the fixed fake keys from
`playwright.config.ts`. CI has no secrets or real values, so nothing sensitive can reach them. Acceptable.

### L7 (info): API token scope

The documented scope (`docs/RUNBOOK.md` › CI/CD › Owner setup 3) is least-privilege and limited to one account and
one zone. It is not proven by a live run: wrangler may also need `Account Settings: Read`, and custom domains may
need DNS permissions. The RUNBOOK already says to add only the permission an error names. Fine.

## Checks that passed

- **Fork pull requests:**
  - There is no `pull_request_target` and no `workflow_run`.
  - `ci.yml` and `codeql.yml` use `pull_request` with `contents: read` and no secrets.
  - `persist-credentials: false` on every checkout.
  - The deploy workflow runs only on `push: tags v*` or `workflow_dispatch`, behind
    `github.event.repository.fork == false && startsWith(github.ref, 'refs/tags/v')`.
  - It uses `environment: staging` (required reviewer and `v*` tag rule, per RUNBOOK owner setup 1).
  - Secrets appear only in the deploy step's `env`.
- **Script injection:** every untrusted context (`ref_name`, matrix shard, `needs.*.result`, sha) reaches `run:`
  through `env:` and is quoted. No PR title, branch name or commit message is used.
  `${{ github.event.pull_request.number || github.ref }}` appears only in the concurrency key.
- **Permissions:**
  - workflow default `contents: read`
  - `ci-ok` `{}`
  - CodeQL adds `security-events: write` only (GitHub downgrades it on fork pull requests)
  - no `id-token`
- **Action pins** (checked with read-only `gh api` GETs, tag object dereferenced):

  | Action | Tag | SHA matches | Latest release |
  | ------ | --- | ----------- | -------------- |
  | `actions/checkout` | v7.0.1 | yes | v7.0.1 |
  | `actions/setup-node` | v7.1.0 | yes | v7.1.0 |
  | `actions/upload-artifact` | v7.0.2 | yes | v7.0.2 |
  | `github/codeql-action` (init/analyze) | v4.38.3 | yes | — |

- **Dependabot:** npm and github-actions run weekly, minor and patch updates are grouped, and the OCR-pinned
  packages are ignored. Its pull requests run CI without secrets. Sane.
- **Deploy log:** `shell: bash` gives `-o pipefail`, so a failed deploy fails the step despite `| sed | tee`.
  The summary prints the bookmark only if it matches `[0-9a-f-]+`.
- **`scripts/deploy-staging.ts`:**
  - It refuses missing, malformed, all-zero or placeholder values, and any placeholder left in a rendered
    `env.staging` block.
  - It names variables in errors, never their values.
  - It stops before migrations when there is no bookmark.
  - Every remote command is pinned to `montra-staging`, `-c <generated>`, `--env staging`.
  - There is no production target, and no remote seed or reset.
  - `--dry-run` skips Time Travel and migrations.
  - The `finally` block removes the generated files after errors.
- **Wrangler configs:** the committed `env.staging` and top-level blocks hold only placeholders.
- **Engineering checklist:** the migration rule ("RUNBOOK notes the D1 Time Travel bookmark before a remote apply")
  is met. The other checklist items do not apply to this diff.

## Commands run

- `npx vitest run scripts/deploy-staging.test.ts` — 1 file, 16 tests passed.
- `npm run deploy:staging -- --dry-run` (values from `.staging.env`; output written to a scratch file and only
  counted) — exit 0, 4/4 steps, "dry run finished; nothing was uploaded". Printed: account id 0, D1 id 0,
  KV id 2, host 1, workers.dev 0. Generated files left afterwards: 0.
- `gh api repos/<action>/git/ref/tags/<tag>` (+ `git/tags/<sha>`) — all 4 pins match.
- Tracked-tree grep (`git ls-files`) for the real values:

  | Value | Matches in tracked files |
  | ----- | ------------------------ |
  | account id | 0 |
  | D1 id | 0 |
  | KV id | 0 |
  | host | 9 (`docs/TASKS.md` 8, `docs/HISTORY.md` 1) |
  | workers.dev subdomain | 1 (`docs/HISTORY.md:555`) |

  Other 32-hex values in `docs/HISTORY.md` and `docs/TASKS.md` are D1 Time Travel bookmarks (not secrets).

## Resolution (2026-10-13, engineer cycle 2)

Rebased onto main 0be8711 (FN-50). FN-50 added more real-host references (the passkey and Turnstile tests, the
RUNBOOK and the FN-50 PRD and QA report). They now use `app.example.com` or `<staging-app-host>`.
`TURNSTILE_SITE_KEY` is committed empty in `env.staging.vars`. `deploy:staging` fills it from the optional
`STAGING_TURNSTILE_SITE_KEY`, read from the environment or `.staging.env`; CI takes it from `vars`, since the key
is public by design.

- **M1:** no action in this branch. The public repository is a fresh single-commit export with sanitised trackers
  (`docs/TASKS.md` and `docs/HISTORY.md` are outside an engineer's edit rights here). The `workers_dev` decision
  stays with the owner.
- **M2:** no action in this branch, for the same reason: the fresh single-commit export carries no history.
- **L1:** `STAGING_APP_HOST` is now an environment secret, so the step header shows it as `***`. The step that
  reads it re-masks it with `::add-mask::` before it calls curl. RUNBOOK owner step 2 is updated.
- **L2:** `deploy-staging.ts` now runs each step with an async `spawn`. `cleanUpOnSignals` passes SIGINT or SIGTERM
  on to the running wrangler, deletes the generated configs and exits 130 or 143. A deploy also deletes stale
  generated files when it starts.
  - Unit tests: `scripts/deploy-staging.test.ts › cleanUpOnSignals`.
  - Real run: `kill -INT` during `--dry-run` gave exit 130, with 0 generated files and no orphaned wrangler.
  - Real run: `kill -TERM` gave exit 143, with 0 files.
- **L3:** checkout uses `fetch-depth: 0`. The job refuses a tag whose commit fails
  `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`. New RUNBOOK owner step 4: a tag ruleset on `v*`, so
  that only the owner can create, update or delete these tags.
- **L4:** the deploy job no longer restores the npm cache (`package-manager-cache: false`, no `cache:`).
  `npm ci --ignore-scripts` and `npm run gates` (the build included) run without the token. Only
  `npm run deploy:staging -- --skip-build` gets the secrets. The new flag drops `vite build` and refuses to run
  without existing build output.
  - wrangler itself still bundles the jobs and inbound Workers while the token is in the environment. esbuild
    bundles the code without running it.
  - Not done: a separate job with an artifact. That job would still need `npm ci` for wrangler, so it would add a
    hand-over without removing that exposure.
- **L5:** before the deploy, the job reads `https://$STAGING_APP_HOST/api/v1/health`. When the live `version`
  equals the tag, the job skips (it succeeds and writes "Skipped: staging already runs vX.Y.Z" to the summary).
  An unreachable or unreadable health check deploys as usual. The `deploy-staging` concurrency group, already
  present, stays.
  - `.claude/commands/ship.md:12` now describes what `deploy:staging` really does (the nonexistent
    `db:migrate:staging` is gone).
  - New `ship.md` line: once the `staging` environment and its secrets exist, the tag workflow is the deploy path,
    `/ship` only pushes `main` and the tag, and the local deploy stays as the fallback.
  - The RUNBOOK says to approve a tag run only after a local deploy has finished. The health check cannot see a
    local deploy that is still running.
- **L6, L7:** accepted as reported; no change.

## Cycle 2 (red team re-check, `git diff 3c0170b..f658aef`)

### Verdict: PASS

L1–L5 are resolved, and no new medium or high finding came up. By owner decision, M1 and M2 are out of scope for
this branch. They stay open until the fresh single-commit public export, which must use sanitised
`docs/TASKS.md` and `docs/HISTORY.md` (host ×9, workers.dev subdomain ×1) and carry no history.

### Resolution of earlier findings

- **L1 (resolved):** `STAGING_APP_HOST` is now a secret, so the step header shows `***`. The step re-masks it
  before `curl -fs`, which prints no URL and no error text. The step logs only the parsed `version`.
- **L2 (resolved):** I sent real signals during `--dry-run`:
  - SIGINT: exit 130, and the 3 generated files went to 0.
  - SIGTERM: exit 143, and the files went to 0.
  - No orphaned `vite build` or `wrangler deploy` process was left.
  - Stale generated files are now removed when a deploy starts.
- **L3 (resolved):** with `fetch-depth: 0`, `actions/checkout` fetches every branch into `refs/remotes/origin/*`,
  so `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` is meaningful. It fails closed when `main` is
  missing or the commit is not on it. The RUNBOOK owner step 4 adds the `v*` tag ruleset.
- **L4 (resolved):** the deploy job no longer uses the npm cache. `package-manager-cache` exists in the
  `action.yml` of setup-node at the pinned SHA 949feb24 (checked with `gh api`). The build runs before the token
  is in the environment. With the token present, only wrangler and its esbuild bundling run.
- **L5 (resolved):**
  - `ship.md` now makes the tag workflow the deploy path once the `staging` environment exists, and the
    nonexistent `db:migrate:staging` is gone.
  - The health check skips a redundant redeploy.
  - Spoofing: the health check uses HTTPS to our own host and does not follow redirects (`curl` has no `-L`).
    A forged or redirected response can only cause a skip, which deploys nothing. It cannot run code, reach the
    secrets or leak the host. A 3xx or an unreadable body leaves the version empty, so the deploy runs.

### New low findings

#### C2-L1 (low): the version-only skip trusts the tag name, not the commit

Scenario: `vX.Y.Z` is deleted and pushed again on a different commit with the same `package.json` version.
Staging still reports `X.Y.Z`, so the job skips and the new commit is never deployed. The summary still says
"already runs".

The tag ruleset in RUNBOOK owner step 4 blocks tag updates and deletes, which mitigates this. That step must be
done before CI deploys are enabled.

Optional fix: expose the commit SHA in the health response, as a var that `deploy:staging` fills, and compare it
with `$GITHUB_SHA`.

#### C2-L2 (low): `--skip-build` checks only that build output exists

At `scripts/deploy-staging.ts:281`, the flag checks only that `.svelte-kit/cloudflare/_worker.js` exists, not that
it was built from the current tree.

In CI this is safe: `npm run gates` builds in the same job, on the tagged checkout. Locally, `--skip-build` after
a `git checkout` of another branch, or after an e2e build, deploys stale output.

Fix: make `--skip-build` CI-only (`process.env.CI`), or check that the output is newer than every input, as
`scripts/e2e-build.sh` does.

#### C2-L3 (low): Turnstile turns off silently when the site key is missing

The `TURNSTILE_SITE_KEY` value committed in `wrangler.jsonc` is empty. `STAGING_TURNSTILE_SITE_KEY` is optional,
and `src/lib/server/auth/turnstile.ts:28` turns Turnstile on only when both keys are set.

Scenario: Turnstile is live, and one deploy path lacks the key. That could be a local `.staging.env` without it,
or a missing GitHub var. The next deploy then turns off bot protection on sign-in and sign-up without any error.
Only the admin status page shows "partial".

Fix: once Turnstile is enabled, make the variable required. One option: refuse when it is unset unless
`STAGING_TURNSTILE=off` is set explicitly.

The key's regex (`^[0-9A-Za-z_-]{8,64}$`) prevents JSON injection into the generated config. The key is public by
design, so printing it in the step header is fine.

### Cycle 2 commands

- `npx vitest run scripts/deploy-staging.test.ts` — 1 file, 24 tests passed.
- `npm run deploy:staging -- --dry-run --skip-build` (build output present) — exit 0, 3/3 steps, "dry run finished;
  nothing was uploaded". Printed: account id 0, D1 id 0, KV id 2, host 1. In CI the KV id and host are secrets,
  so both are masked.
- `node scripts/deploy-staging.ts --dry-run`, then `kill -INT` and `kill -TERM` — exit 130 and 143, 0 generated
  files left, no orphaned child process.
- `gh api repos/actions/setup-node/contents/action.yml?ref=949feb24…` — the `package-manager-cache` input exists.

### Resolution of the cycle 2 lows (2026-10-13, orchestrator)

- **C2-L1 accepted:** the health-check skip compares the version only. A re-pushed `vX.Y.Z` on another commit is
  prevented by owner step 4 (the `v*` tag ruleset), which `docs/RUNBOOK.md` › CI/CD requires before the first CI
  deploy. Exposing the commit SHA on `/api/v1/health` is left for later.
- **C2-L2 fixed:** `scripts/deploy-staging.ts` refuses `--skip-build` unless `CI=true`. Checked: a local
  `--dry-run --skip-build` refuses with "only allowed in CI"; with `CI=true` a stale build output failed at "Deploy
  app Worker" (exactly the risk), and after `npm run build` the dry run finished with nothing uploaded.
- **C2-L3 fixed (warning):** the deploy prints that the Turnstile bot check stays off on staging when
  `STAGING_TURNSTILE_SITE_KEY` is unset. It warns instead of refusing because the owner has not created the
  Turnstile widget yet; once it exists, set the variable.
