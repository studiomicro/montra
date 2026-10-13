# FN-42b Changelog and automatic update checks — summary

Status: **complete** (2026-10-10). No migration. Branch `feat/fn-42b-changelog`, not merged.

- **Goal** (owner request 2026-10-10, "add changelog and auto update checker"): a full release history in the app,
  update checks that run on their own while the app is open, and a one-time "what's new" after an update.
- **Changelog:** `/pengaturan/tentang/catatan-rilis` (`src/routes/(app)/pengaturan/tentang/catatan-rilis/`) lists all
  releases newest first from `src/lib/content/release-notes/<version>.{id,en}.md`; server-rendered, no JS needed,
  360 px; Tentang's "Apa yang baru" links to it ("Lihat semua"). Both pages share `src/lib/ui/pwa/ReleaseNote.svelte`.
  Not on the marketing site (owner decision D1 default).
- **Automatic checks:** `src/lib/ui/pwa/auto-check.ts` with pure timing in `src/lib/shared/sw-update.ts`
  (`shouldCheckForUpdate`): on visible, on `online`, every 45 min while visible; 10 min minimum gap; one in-flight check
  shared with "Periksa pembaruan"; off under `vite dev` and without service worker; never reloads.
- **What's new:** `src/lib/shared/whats-new.ts` (`decideWhatsNew`) and `src/lib/ui/pwa/WhatsNew.svelte`; the (app)
  layout load carries `appVersion` and the current version's note (null signed out). Last seen version in
  localStorage `montra-last-seen-version` (try/catch); nothing on first install, downgrade or invalid value.
- **Release discipline:** `docs/RUNBOOK.md` "Release notes" section; `release-notes.test.ts` fails when the newest
  `CHANGELOG.md` version lacks an id/en pair (fail-before shown).
- **Tests:** `versions`, `whats-new`, `auto-check`, `update`, `sw-update`, `release-notes` unit tests;
  `test/release-pages.test.ts`; integration cases in `pengaturan-pemakaian.test.ts`; e2e `catatan-rilis.spec.ts`,
  `catatan-rilis-qa.spec.ts`, new cases in `pwa.spec.ts`.
- **QA PASS** (all 25 criteria, gates clean). **Red team PASS** (L1 low carried over from FN-42: the worker's message
  handler does not check `event.source`; unchanged).
- **Not verified:** an update between two real deploys (the newer build is simulated in e2e); the 5 s banner wait in
  pwa.spec update tests flakes under heavy parallel load (passes with one worker).
