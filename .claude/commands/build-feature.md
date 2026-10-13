---
description: Runs the full CTO -> senior engineer -> QA -> red-team pipeline for one feature request, retrying fixes up to 3 times, then updates the trackers. Never commits or deploys; use /ship for that.
---

Feature request: $ARGUMENTS

Run this pipeline for the feature request above. Derive a kebab-case `<slug>` from it, prefixed with its catalogue ID from `docs/FEATURES.md` when it has one (e.g. "budgets with daily safe-to-spend" -> `fn-07-budgets`), and use it for every file path below.

0. Preflight: run `git status --short`. If the tree has unrelated uncommitted changes, tell the user and continue only when they confirm. Read the `To do` list in `docs/TASKS.md`; if the request is blocked on a `**You**` item (credentials, decision), report that and ask whether to build the credential-independent part only.

0a. Risk tier sizes the pipeline:

- **Small** (UI text, nav, docs, tooling, no data or access change): engineer, then one light review by the orchestrator; no separate QA and red-team runs.
- **Medium** (a feature without migration, auth, money logic or new external input): engineer, then QA and a narrow red team in parallel.
- **Large** (migration, auth, access control, money calculation, AI capture, payments, new external input): the full sequence below.
  Models: CTO and QA on Sonnet 5 (high); engineer and red team on Opus 5.5 (medium). Start agents by named type (`cto-strategist`, `senior-software-engineer`, `qa-tester`, `red-team-pentester`) so their model pins apply.

0b. Branching: one worktree and branch per feature, from `main` (`git worktree add ../montra-worktrees/<slug> -b feat/<slug>`). Shared code needed by two features lands on `main` first. Before each engineer or QA dispatch, rebase the branch onto `main`. Engineers commit `wip(<slug>): cycle N`; re-checks read `git diff <previous cycle commit>..HEAD`. When QA and red team pass: squash to one Conventional Commit on `main`, run the gates on `main`, then update the trackers.

0c. Economy:

- **Owner decisions up front:** the PRD lists every owner-visible trade-off under "Owner decisions" with a proposed default; ask them before step 2, not mid-cycle.
- **Engineer self-probe:** the engineer runs the applicable `docs/ENGINEERING_CHECKLIST.md` › "Pre-handoff probes" and lists the result lines.
- **Separate worktrees** for QA and red team when both run; never two builds in one tree.
- **Concurrency:** at most 5 agents while test-heavy work runs.
- **Short handoffs:** every agent's final message is at most 15 lines; details stay in the report files.

0d. E2e economy: browser tests are for journeys and browser-only behaviour, not for every change.

- **Small:** no new e2e spec. Vitest for logic; run `npm run gates` plus only the existing e2e specs that assert the changed text or element.
- **Medium:** Vitest for logic; add or extend an e2e spec only for a new journey or real-browser behaviour (keyboard and focus, layout at 360 px, camera/mic input, PWA install, share target).
- **Large:** as Medium, and the full e2e suite runs on `main` before the deploy that ships it.
- **Bug fixes:** regression test in the lowest layer that shows the bug (Vitest first).
- **Flakes:** a failure in an untouched spec is rerun once as a file; if it passes, note it and go on.

1. Dispatch the `cto-strategist` subagent with the feature request. It writes `docs/features/<slug>/PRD.md`. If that file was not created, stop and report. If the PRD lists a missing prerequisite credential, tell the user and build only the parts that do not depend on it; the rest becomes a `**You**` To do item.

2. Dispatch the `senior-software-engineer` subagent with the path to the PRD, instructing it to implement it.

3. Dispatch the `qa-tester` subagent with the `<slug>`. It writes `docs/features/<slug>/QA_REPORT.md` with a PASS/FAIL verdict.

4. If QA's verdict is FAIL: go to step 6 with the QA report as the failure source.

5. If QA's verdict is PASS: dispatch the `red-team-pentester` subagent with the `<slug>`. It writes `docs/features/<slug>/SECURITY_REPORT.md`.
   - PASS: go to step 7.
   - FAIL: go to step 6 with the security report as the failure source.

6. Fix cycle (max 3 total across QA and red-team failures):
   - Dispatch `senior-software-engineer` again, pointing it at the failing report(s), to fix exactly those findings.
   - Go back to step 3.
   - If the 3rd fix cycle still fails: stop. Write `docs/features/<slug>/SUMMARY.md` stating the feature is **incomplete**, list the unresolved findings verbatim, add an open `- [ ] **Claude** — …` item in `docs/TASKS.md` pointing at the report, and report this to the user. No 4th cycle.

7. Done: write `docs/features/<slug>/SUMMARY.md` stating the feature is **complete** (PRD goal, files changed, migrations added, QA and red-team passed). Then update the trackers:
   - `docs/HISTORY.md` → `## Completed work`: one bullet `- **<FN-xx Feature> (<YYYY-MM-DD>)** — what was built, migrations, tests added, what is NOT verified (e.g. real provider).` Append the command result lines to `## Test evidence log`.
   - `docs/TASKS.md`: tick or remove the related To do entry, adjust `## Status summary`, add any new `**You**` prerequisite. Leave the `pushes since last deploy` counter alone (only `/ship` changes it).
   - `docs/ACCEPTANCE.md`: update a row's status only with the named check.
   - `docs/RUNBOOK.md`: only if a new secret, script or operational step exists.
     Do not commit, push, deploy or touch remote D1. Report the summary and suggest `/ship`.
