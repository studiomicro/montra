---
description: Verification-only pass for one acceptance item or journey: run the real checks, record evidence, update ACCEPTANCE/HISTORY/TASKS. No source changes.
---

What to verify: $ARGUMENTS

Rules: do not edit `src/`, `workers/` or `migrations/`. If verification needs a fix, stop and report; the owner decides whether to run `/fix-bug`.

1. Find the matching row(s) in `docs/ACCEPTANCE.md` and the CLAUDE.md requirement behind them. Pick the strongest available evidence level: **Pass** (real runtime/provider) > **Browser** (Playwright on `wrangler dev`) > **Automated** (Vitest on local D1) > **Mocked**. Never label a mocked or fixture-driven result as Pass.
2. Run it. Runtime checks run against local Cloudflare bindings (`wrangler dev` / `npm run preview` after `npm run build`), never only the Node dev server. Fresh-DB checks use `npm run db:reset:local` (local only). For real providers, read the secret names from `.dev.vars.example`; if a secret is missing, the result is **Not run** with the exact secret name added as a `**You**` item.
3. Record: command, exit code, decisive output line, date, real or mocked, as a bullet in `docs/HISTORY.md` → `## Test evidence log`. Update the row in `docs/ACCEPTANCE.md`. Tick the To do item in `docs/TASKS.md` or leave it with a one-line reason.
4. Report only what ran and what it showed. Never report an unrun command as passed.
