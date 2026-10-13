---
description: Commit the current work with a Conventional Commit, push to origin, keep the staging deploy counter, and deploy to staging only on the 10th push or on explicit owner request.
---

Instruction (optional, e.g. "deploy now"): $ARGUMENTS

1. `git status --short` and `git diff --stat`. If the tree is clean, say so and stop. Confirm `npm run gates` ran in this session on this tree; if not, run it now and stop on failure. Before a deploy, run the full e2e suite only when `/build-feature` step 0d asks for it.
2. Compose the commit message: `type(scope): summary` in lowercase imperative, ≤ 72 chars, scope = feature slug or area (`auth`, `spaces`, `transactions`, `budgets`, `capture`, `import`, `assistant`, `networth`, `billing`, `pwa`, `jobs`, `inbound`, `tasks`, `CLAUDE.md`). Body: what changed and what is not verified. End with the attribution trailer from the session's system reminder. Stage only the files that belong to the work (`git add <paths>`, never `git add -A` with unrelated changes).
3. Tracker-only updates use `docs(tasks): …`. Otherwise include the tracker edits in the same commit as the code.
4. Push: `git push origin main` (if no `origin` remote exists, say so and stop after the commit). Then increment `pushes since last deploy: N` in `docs/TASKS.md`; if that edit is the only change, commit it as `docs(tasks): count push` and push once more (that push does not count).
5. Deploy decision:
   - Counter reached 10, or `$ARGUMENTS` asks explicitly ("deploy now", "deploy staging"): write the new `CHANGELOG.md` section (one section per UTC day, `## vX.Y.Z — YYYY-MM-DD HH:MM UTC (staging, <7-char sha>)`, 2–6 short plain-language bullets for users, one `Behind the scenes:` bullet naming any database update), bump `package.json` and lockfile to `X.Y.Z` (SemVer 0.x, minor per deploy, patch for bug-fix-only), commit; then `npm run deploy:staging` (reads the real ids from the gitignored `.staging.env`; prints the D1 Time Travel bookmark (record it), applies any pending remote migrations, builds, deploys jobs, inbound, app; stops at the first failure). Set the counter to 0, record the deploy line in `docs/TASKS.md` (date UTC, commit, migrations, what shipped), tag `git tag -a vX.Y.Z <sha> -m "Staging deploy …"`, commit as `docs(tasks): record staging deploy <sha>`, push `main` and the tag. Release notes never mention open security findings or internal file names.
   - Once the GitHub `staging` environment and its secrets exist (docs/RUNBOOK.md › CI/CD), the tag workflow is the deploy path: do everything above except `npm run deploy:staging`, push `main` and the tag, and the approved `Deploy staging` run deploys (bookmark in its job summary). The local `npm run deploy:staging` stays the fallback.
   - Otherwise: report "pushes since last deploy: N/10, no deploy".
     Never deploy to production, never seed or reset a remote DB, never apply migrations to production.
6. Report: commit sha, push result, counter, deploy status (or reason skipped), new version and tag when deployed, what remains unverified on staging.
