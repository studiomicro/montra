# CI/CD with GitHub Actions — SUMMARY

Status: **complete** (2026-10-13). Owner request: "add CI CD also", then "sanitize the workflow env and everything".

- CI (`.github/workflows/ci.yml`): pull requests and pushes to `main`; check and lint, Vitest in four shards, build,
  Playwright on chromium and webkit with a fresh local D1 and fixed fake keys; report and traces uploaded only on
  failure. Node 24 LTS. `CI ok` is the single required check.
- CD (`.github/workflows/deploy-staging.yml`): staging only, on a `v*` tag of a commit on `main` or by hand, in the
  `staging` environment with a required reviewer; skips when staging already runs that version; one deploy at a
  time; the Time Travel bookmark goes to the job summary. No production workflow.
- CodeQL and Dependabot (npm and actions, weekly; OCR packages pinned). Every action pinned to a full SHA.
- Real Cloudflare ids, the staging host and the Turnstile site key left the committed configs:
  `scripts/deploy-staging.ts` reads them from the environment or a gitignored `.staging.env` and writes temporary
  gitignored configs that are removed on exit and on SIGINT/SIGTERM. `--skip-build` works only in CI.
- Red team: FAIL cycle 1 (M1, M2: real values in trackers and git history, handled by the fresh public export;
  L1–L5), PASS cycle 2 (C2-L1 accepted with the tag ruleset, C2-L2 and C2-L3 fixed in cycle 3).
- Not verified: no workflow has run on GitHub yet; the documented API token scope is untested against a live deploy.
