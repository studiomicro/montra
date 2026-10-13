# FN-42b — Changelog and automatic update checks

Status: PRD (2026-10-10). Risk tier: **Medium** (no migration, no auth change, no money; the real-browser part is the
service-worker update flow). Extends FN-42 (`docs/features/fn-42-version-usage/{PRD,SUMMARY,SECURITY_REPORT}.md`).
Owner request 2026-10-10: "add changelog and auto update checker". Owner said proceed automatically: every Owner
decision below carries a default, and the defaults are the spec.

## Goal

FN-42 shows the last three releases and updates only when the person taps "Periksa pembaruan". Two gaps remain: a
person cannot read older releases, and an open app (a PWA kept in the background for days) never learns about a new
build unless the browser's own 24-hour check happens to run. FN-42b adds (1) a full changelog page, (2) quiet automatic
update checks while the app is open, still never reloading by itself so an unsent FN-02 offline-queue item is never at
risk, (3) a one-time "what's new" notice the first time a device runs a newer version, and (4) a release rule plus a
test so a release cannot ship without notes.

## Current behaviour (cited)

- `/pengaturan/tentang` lives at `src/routes/(app)/pengaturan/tentang/+page.{server.ts,svelte}`. Load:
  `+page.server.ts:11-19` redirects signed-out users to `/masuk`, returns `version = getEnv().APP_VERSION`,
  `releasedOn: releaseDateOf(version)` and `notes: listReleaseNotes(locals.locale)` (default limit 3).
  Page: "Apa yang baru" section `+page.svelte:97-118`, one `<article class="release">` per note (`:103-116`), notes are
  server-rendered HTML (`{@html note.html}` `:113`), update controls render only after hydration (`:73-95`),
  `check()` calls `checkForUpdate()` (`:28-36`).
- Notes loader `src/lib/server/content/release-notes.ts`: `RELEASE_NOTES_SHOWN = 3` (`:25`),
  `compareVersionsDesc` (`:37`), `parseReleaseNotes` throws on a lone language or mismatched dates (`:47-75`),
  `listReleaseNotes(locale, limit = 3)` (`:85-87`), `releaseDateOf` (`:90-92`). Header comment `:9-12` says "a release
  without a note is legal" (this PRD changes that for the newest release, AC 20). Files:
  `src/lib/content/release-notes/<version>.{id,en}.md`, currently 0.1.0–0.6.0 (12 files); no "Behind the scenes".
  `release-notes.test.ts:17-45` already tests order, dates and that no note contains "behind the scenes"/file names.
- `src/lib/ui/pwa/update.svelte.ts`: state `pwaUpdate` (`:16-25`); `startServiceWorker(enabled)` (`:46-81`) returns
  `() => {}` and sets `registration = 'unavailable'` when `!enabled` or no `serviceWorker` (`:47-50`); the module-level
  `registration` is set at `:67`; `applyUpdate()` (`:84-95`) is the only path that reloads; `checkForUpdate()`
  (`:98-108`) calls `reg.update()` and maps through `updateCheckOutcome`; it is called only from the Tentang button.
- `src/lib/shared/sw-update.ts`: pure `skipWaitingOnInstall` (`:15`), `isSkipWaitingMessage` (`:20`), `offerUpdate`
  (`:30-36`), `UpdateCheck`/`updateCheckOutcome` (`:38-53`). Tests in `sw-update.test.ts`.
- Root `src/routes/+layout.svelte:33-43`: `onMount` calls `startServiceWorker(!dev)`; `showUpdate` hides the global
  banner on `/pengaturan/tentang` (`:50-52`); `UpdateBanner` slot `:97-101`. Root `src/routes/+layout.server.ts`
  returns only locale/theme/in-app-browser data. App layout `src/routes/(app)/+layout.server.ts:16-37` returns
  `hiddenModules`, `shell`, `queue`, `receiptReady` (and for signed-out users `queue: null`, `:20`); the app layout
  component is `src/routes/(app)/+layout.svelte`.
- Existing e2e for the update flow: `e2e/pwa.spec.ts:321-460` (describe "updates (FN-42, /pengaturan/tentang)": first
  install silent, update waits, one reload, offline item survives; no-JS render at 360 px `:432-452`). No separate
  tentang spec exists. Pengaturan subpages use `ScreenTitle` (`src/lib/ui/shell/ScreenTitle.svelte`) and no back
  link component; APP_PARITY § 3 "wave D" says Pengaturan sub-pages use the page header row + panel GroupedLists.
- `CHANGELOG.md` is the engineering log written by `.claude/commands/ship.md:12`; nothing in `src`/`test` reads it.
  `docs/RUNBOOK.md` has no release-notes rule (versions appear only at `:190`).

## Scope

### 1. Changelog page `/pengaturan/tentang/catatan-rilis`

- New route `src/routes/(app)/pengaturan/tentang/catatan-rilis/+page.{server.ts,svelte}`. Load: signed-out redirects
  to `/masuk` like every Pengaturan page; returns `notes` for **all** releases in the user's locale, newest first,
  plus `version` (running). Add `listAllReleaseNotes(locale)` (or let `listReleaseNotes` accept `Infinity`) in
  `release-notes.ts`; no new parsing.
- Rendering: `ScreenTitle` "Catatan rilis", subtitle with the release count; a text link "Tentang Montra" back to
  `/pengaturan/tentang` above the list (44 px target); one article per release using the same markup as Tentang (heading level is a prop: H3 on Tentang, H2 here)
  (extract the card into one shared component, e.g. `src/lib/ui/pwa/ReleaseNote.svelte`, used by both pages so they
  cannot drift). The running version's card carries a small "Versi kamu" badge (kit `Badge`). Markdown is rendered
  only at build time (`markdown.ts`, text escaped), so no JS is needed.
- Entry point: in "Apa yang baru" on Tentang add a "Lihat semua" link (to the new route) after the notes; always shown
  when at least one note exists.
- No-notes state: "Belum ada catatan rilis." (existing phrase).
- Not on the marketing site (Owner decision D1). No `sitemap.ts` / `robots` change; the route is behind sign-in.
- Do not edit `src/lib/ui/shell/nav.ts` or `e2e/shell.spec.ts` (the page needs no nav entry; it is reached from Tentang).

### 2. Automatic update checks while the app is open

- New pure function(s) in `src/lib/shared/sw-update.ts`, unit-tested in `sw-update.test.ts`:
  `shouldCheckForUpdate({ trigger: 'visible' | 'online' | 'interval', now, lastCheckAt: number | null,
  inFlight, visible, registrationReady, updateWaiting, enabled }): boolean`. Rules, in order: false when `!enabled`
  (vite dev / no SW support); false when `!registrationReady`; false when `inFlight`; false when `updateWaiting`
  or an install is already running (nothing more to find; the banner is the next step); false when `!visible`; false
  when `lastCheckAt !== null && now - lastCheckAt < MIN_GAP_MS`; else true. Exported constants
  `MIN_GAP_MS = 10 * 60_000`, `CHECK_INTERVAL_MS = 45 * 60_000` (Owner decision D2). A small pure helper decides
  whether a finished check advances `lastCheckAt`: `'found'` and `'latest'` do, `'failed'` does not, so a check
  that failed offline is retried by the next `online` event instead of waiting out the gap.
- Wiring in `src/lib/ui/pwa/update.svelte.ts` (browser only), started inside `startServiceWorker` after
  registration and torn down in its returned cleanup: listens to `document` `visibilitychange` (when it becomes
  `visible`), `window` `online`, and a `setInterval(CHECK_INTERVAL_MS)` that runs only while the document is visible
  (cleared on hidden, restarted on visible). Every trigger goes through the pure function, then the existing
  `checkForUpdate()`.
- `checkForUpdate()` gains an in-flight guard shared by the manual button and the automatic triggers: a second call
  while one runs returns the same promise (no second `reg.update()`). The manual button ignores the min gap but
  records `lastCheckAt`. Result of an automatic check is silent: no result text, no toast. A newer build surfaces
  only through the existing `updatefound` → `watch` → `pwaUpdate.available` banner.
- Never reloads, never calls `SKIP_WAITING`, never calls `applyUpdate()`. `skipWaitingOnInstall`/`offerUpdate` are not
  changed, so a first install still activates silently and an update still waits for "Muat ulang sekarang".
- Do nothing when `enabled` is false (`startServiceWorker(!dev)` already passes this; no listeners attached), when
  `serviceWorker` is unsupported, or when `registration` is null/failed (state `unavailable`).
- Bounded cost: at most one `reg.update()` per 10 minutes from automatic triggers; a hidden tab makes none.

### 3. "What's new" after an update

- Data: add `whatsNew: { version: string; date: string; html: string } | null` to the **(app) layout load**
  (`src/routes/(app)/+layout.server.ts`): the running `APP_VERSION` and its note in the user's locale; `null` when
  signed out or when the version has no note. Rationale (Owner decision D4): reuses the existing loader, needs no new
  endpoint or auth surface, works offline from the cached document, and one note is about 1 KB; a fetch endpoint
  was rejected as extra surface for the same payload. With no note nothing is shown, so the value is `null`. Add `releaseNoteFor(locale, version)` to `release-notes.ts`.
  A test caps every note's rendered HTML at 4 KB so this stays small.
- Decision logic is a pure function in a new `src/lib/shared/whats-new.ts` (unit-tested):
  `decideWhatsNew({ stored: string | null, current: string, hasNote: boolean }): { show: boolean; store: string | null }`.
  - `stored` null or not a valid `MAJOR.MINOR.PATCH` (first install, cleared storage, corrupt): `store = current`,
    `show = false`. **Never shown on first install.**
  - `stored === current`: `show = false`, no write.
  - `current` newer than `stored`: `show = hasNote`, `store = current`.
  - `current` older than `stored` (rollback / downgrade): `show = false`, `store = current`.
  - Version comparison reuses `compareVersionsDesc`, moved to `src/lib/shared` (e.g. `versions.ts`) and re-exported
    from `release-notes.ts` so the existing import and tests keep working.
- Storage: `localStorage` key `montra-last-seen-version`, every read and write in try/catch. Storage blocked: the
  notice simply never shows (nothing can be remembered, and showing every load would nag). No server write, no D1,
  no cookie (Owner decision D5).
- UI: a component mounted in `src/routes/(app)/+layout.svelte` (not the root layout, so signed-out pages, `/masuk`,
  the marketing site and `+error` never show it), rendered after hydration only: an inline, non-modal card at the
  top of `<main>` (same slot style as the update banner, never blocks the tab bar or the offline-queue status).
  Content: title "Baru di Montra {versi}" (`trf`), the note HTML in a region capped at about 40 vh with its own
  scroll, link "Lihat semua catatan rilis" to the changelog, button "Tutup" (44 px, closes, returns focus to
  `<main>` like `focusMain` in the root layout). `role="status"`, not a focus trap. It sits below the
  "Versi baru tersedia" banner when both are present.
- "Once": the stored version is written at the moment the notice is shown (decision D3), so a reload, another tab or
  the next day never shows it again whether or not it was dismissed. Landing on `/pengaturan/tentang` or
  `/pengaturan/tentang/catatan-rilis` counts as seen: store current, show nothing.
- Several versions skipped (0.4.0 → 0.6.0): show only the current version's note plus the "Lihat semua" link
  (decision D6).
- A new device or a browser after sign-out sees nothing (sign-out sends `Clear-Site-Data: "storage"`, `docs/RUNBOOK.md`
  "Service worker and sign-out"): this is the first-install rule and is intended.
- No analytics events added.

### 4. Release discipline

- `docs/RUNBOOK.md`: new short section "Release notes" (near "Staging"): every user-visible release adds
  `src/lib/content/release-notes/<version>.id.md` and `.en.md` in the same commit that bumps `package.json` and
  writes the `CHANGELOG.md` section; front matter `version` (matches the file name) and `date`; plain-language bullets,
  no "Behind the scenes", no file names, no open security findings; `npm test` fails when the newest `CHANGELOG.md`
  version has no pair. Do **not** edit `.claude/commands/*.md`; the runbook is the only place the rule is written.
  State the known gap: `/ship` writes `CHANGELOG.md` and does not know about the notes, so the notes pair is added in
  the same release commit by the engineer or orchestrator preparing the release (Owner decision D7).
- New Vitest case in `src/lib/server/content/release-notes.test.ts` (no existing test reads `CHANGELOG.md`; checked):
  reads `CHANGELOG.md`, takes the first `## vX.Y.Z` heading, and expects both `<version>.id.md` and `<version>.en.md`
  to exist (via `listReleaseNotes('id'|'en', 100)`), dates equal to the heading date (UTC day, as `/ship` writes it).
  Fail-before proof: temporarily point the check at a heading `## v9.9.9` (or delete 0.6.0.en.md) and show the red run.
  Update the stale comment in `release-notes.ts:9-12`.

## Out of scope

- Any automatic reload, auto-`SKIP_WAITING`, or applying an update without the tap.
- Push-notifying an update; a server endpoint for version checks; "force update" or minimum-version gating.
- Showing the changelog on the marketing site, in the sitemap, or as RSS (decision D1).
- Per-user "seen" state on the server, analytics on the notice, or per-space/per-user note targeting.
- Editing release-note content, translating older notes, or adding a note editor; editing `.claude/commands/*.md`.
- Changes to `skipWaitingOnInstall`/`offerUpdate`, the worker's caching (`src/service-worker/`), or the offline queue.
- Editing `src/lib/ui/shell/nav.ts` or `e2e/shell.spec.ts`; running the full e2e suite.

## Owner decisions (defaults are binding; nobody will answer)

- **D1 Marketing site shows the changelog?** Default **no**. In-app only, behind sign-in.
- **D2 Check cadence.** Default: on visible, on `online`, and every **45 min** while visible; minimum gap **10 min**.
- **D3 When "seen" is written.** Default: when the notice is shown (shows exactly once even if not dismissed).
- **D4 How the client gets the note.** Default: the (app) layout load carries the current version's note (about 1 KB);
  no new endpoint.
- **D5 Server record of "seen".** Default **none**; per-device `localStorage` only.
- **D6 Skipped versions.** Default: show only the newest version's note plus "Lihat semua".
- **D7 Release-note enforcement.** Default: Vitest test plus RUNBOOK rule; `/ship` is not changed (command files are
  frozen), so the pair is added by whoever prepares the release commit.
- **D8 "Lihat semua" visibility.** Default: always shown when any note exists (not only when more than 3).

## Acceptance criteria

Levels: **Unit** (Vitest), **Integration** (Vitest local D1 / load functions), **Browser** (Playwright real
Chromium), **Manual** (checklist, evidence in QA report). Strings are Indonesian via `tr()`/`trf()`.

Changelog page
1. (Integration) Given a signed-in user, when `/pengaturan/tentang/catatan-rilis` loads, then `notes` holds every
   release in the user's locale, newest first (0.6.0 … 0.1.0 now), and the English locale returns the English text.
   A signed-out request redirects 303 to `/masuk`.
2. (Browser) With JavaScript disabled at 360 px, the page renders the H1 "Catatan rilis", one H2 per release (count
   equals the number of note pairs), each with its date, no horizontal scroll (`expectNoHorizontalScroll`), no CSP
   violation, and the back link "Tentang Montra" (at least 44 px high) returns to Tentang.
3. (Unit) No rendered note and no page text contains "Behind the scenes"/"Di balik layar" (existing
   `release-notes.test.ts` rule still passes over all files).
4. (Browser) On `/pengaturan/tentang` the "Apa yang baru" section still lists exactly 3 releases and has a "Lihat
   semua" link (44 px) to the new route; the existing no-JS test `e2e/pwa.spec.ts:432-452` still passes.
5. (Unit) Tentang and the changelog render the same extracted card component (one shared component; no duplicated
   markup); the running version's card shows "Versi kamu".
6. (Manual) Light and dark, and mono theme, checked at 360 px and desktop against `docs/design/DESIGN_SYSTEM.md`
   (AA contrast, panel cards, no new colour) and `docs/design/APP_PARITY.md` § 3 wave D page pattern.

Automatic checks
7. (Unit) `shouldCheckForUpdate` returns false for each of: `enabled=false`, `registrationReady=false`,
   `inFlight=true`, `updateWaiting=true`, `visible=false`; false when `now - lastCheckAt` is `MIN_GAP_MS - 1`; true at
   exactly `MIN_GAP_MS` and when `lastCheckAt` is null; the same table holds for all three triggers.
8. (Unit) A check outcome of `failed` does not advance `lastCheckAt`; `found` and `latest` do. Constants:
   `CHECK_INTERVAL_MS` between 30 and 60 minutes, `MIN_GAP_MS` smaller than `CHECK_INTERVAL_MS`.
9. (Unit) Fake-timer test of the wiring (or of an extracted scheduler): the interval fires only while visible, is
   cleared on hidden and on cleanup, and no listener remains after the returned cleanup runs.
10. (Browser, `e2e/pwa.spec.ts`) With `ServiceWorkerRegistration.prototype.update` counted via an init script: a
    `visibilitychange` to visible (forced `document.visibilityState`) triggers exactly one `update()` once the gap
    has passed (use `page.clock` to advance), a second event within the gap triggers none, and an `online` event after
    the gap triggers one. The page's full-load counter (`fn42-loads`) is unchanged: no reload.
11. (Browser, `e2e/pwa.spec.ts`) Update flow end to end with the existing `?build=old` simulation: after the
    simulated newer worker is installed by an automatic check (no tap on "Periksa pembaruan"), "Versi baru tersedia
    — Muat ulang" appears, the page did not reload, an unsent FN-02 offline item queued before is still queued, and
    after tapping "Muat ulang sekarang" it reloads once and the item saves exactly once (reuse the existing test's
    assertions).
12. (Browser) A manual "Periksa pembaruan" tap during an automatic check does not start a second `update()` (count 1).
13. (Unit/Manual) Under `vite dev` (`startServiceWorker(false)`) no listener or timer is created and `registration`
    is `unavailable`; in a browser without `serviceWorker` nothing throws.
14. (Browser) A hidden page (`visibilityState = 'hidden'`) fast-forwarded past 45 min makes no `update()` call.

What's new
15. (Unit) `decideWhatsNew` table: stored null → `{show:false, store:current}`; stored invalid string
    (`"abc"`, `""`, `"1.2"`) → same; stored equals current → `{show:false, store:null}`; stored 0.5.0 current 0.6.0
    with note → `{show:true, store:'0.6.0'}`; same without note → `{show:false, store:'0.6.0'}`; stored 0.7.0 current
    0.6.0 → `{show:false, store:'0.6.0'}`; `0.10.0` is newer than `0.9.0`.
16. (Integration) The (app) layout load returns `whatsNew` with the running version's note in the user's locale, and
    `null` for a signed-out request and for a version without a note (stub `APP_VERSION` `9.9.9`). A test asserts
    every bundled note's rendered HTML is at most 4 KB.
17. (Browser, new spec `e2e/catatan-rilis.spec.ts`) A fresh user on first load: no notice, and `localStorage` now
    holds the current version. After setting the stored value to `0.1.0` and reloading: the notice "Baru di Montra
    {version}" shows the note text, a "Lihat semua catatan rilis" link to the changelog and a "Tutup" button (44 px);
    reload again: not shown. "Tutup" hides it and focus lands on `<main>`.
18. (Browser, same spec) Stored value higher than the running version: nothing shown, stored value becomes the
    running version. Storage that throws (init script replacing `localStorage` getters): the app loads, no notice, no
    console error beyond none.
19. (Browser, same spec) The notice does not appear on `/masuk`, on the signed-out marketing site, or on the two
    Tentang pages (visiting them stores the current version silently); 360 px has no horizontal scroll with the
    notice open; the offline-queue status stays visible and tappable beneath it.

Release discipline
20. (Unit) The Vitest case reading `CHANGELOG.md` passes now (0.6.0 has a pair) and fails when the newest heading has
    no pair (fail-before run recorded in the QA report).
21. (Manual) `docs/RUNBOOK.md` has the "Release notes" section with the rule and the known `/ship` gap; `git diff`
    shows no change under `.claude/commands/`.

Cross-cutting (from `docs/ENGINEERING_CHECKLIST.md`)
22. (Unit) i18n: every new Indonesian phrase ("Catatan rilis", "Lihat semua", "Versi kamu", "Baru di Montra {versi}",
    "Lihat semua catatan rilis", "Tutup" if new, the count subtitle) has an English entry in `i18n-en.ts`; the
    existing missing-English test passes; no user-facing string contains a path or internal identifier.
23. (Manual) Accessibility: headings never skip (changelog: H1 then one H2 per release; Tentang keeps its H2 section with H3 per
    release, as `e2e/pwa.spec.ts:446` asserts); the notice is announced as a status, close button
    labelled, focus returns to `<main>`, targets at least 44 px on coarse pointers, AA contrast both themes.
24. (Integration) No new D1 query, table, migration or server write; the changelog load and layout addition read only
    bundled content and the existing `locals.user`/`locals.locale`. Both routes reachable only signed in; no data
    from any space is in their payload.
25. (Gates) `npm run gates` is clean; only `e2e/pwa.spec.ts` and `e2e/catatan-rilis.spec.ts` are run (targeted
    runs, never the full suite); `src/lib/ui/shell/nav.ts` and `e2e/shell.spec.ts` untouched. Evidence of what ran
    is listed; anything unrun is stated as unrun.

## Architecture notes

- Files touched: `src/lib/shared/sw-update.ts` (+test), `src/lib/shared/whats-new.ts` (+test, new),
  `src/lib/shared/versions.ts` (moved `compareVersions`, new), `src/lib/server/content/release-notes.ts` (+test:
  `listAllReleaseNotes`, `releaseNoteFor`, CHANGELOG pair test, comment), `src/lib/ui/pwa/update.svelte.ts`,
  new `src/lib/ui/pwa/ReleaseNote.svelte` and `WhatsNew.svelte`, `src/routes/(app)/+layout.server.ts`,
  `src/routes/(app)/+layout.svelte`, `src/routes/(app)/pengaturan/tentang/+page.{svelte,server.ts}`, new
  `.../tentang/catatan-rilis/+page.{server.ts,svelte}`, `src/lib/shared/i18n-en.ts`, `docs/RUNBOOK.md`.
- Reuse: `listReleaseNotes`/markdown renderer (build-time, escaped), `checkForUpdate`, `watch`/`pwaUpdate`,
  `ScreenTitle`, kit `Button`/`Badge`, `focusMain` pattern from `src/routes/+layout.svelte:88-96`.
- The CSP is unchanged: no inline script, no new origin; the note HTML is the same trusted, escaped build output
  already used with `{@html}` on Tentang.
- Worker: app Worker only. No change to `workers/jobs`, `workers/inbound`, `src/service-worker/` or `wrangler`.
- Risk to watch: `reg.update()` on the build served at `/service-worker.js` is a cheap conditional fetch; the min
  gap bounds it. The offline queue (IndexedDB) is untouched; no code path adds a reload.

## Prerequisites

None: no secrets, no provider. Behaviour when the service worker is unavailable: no automatic checks, Tentang shows
"Pembaruan otomatis tidak tersedia di browser ini." as today; changelog and notice still work (they do not need it).

## Tracker impact

- No open `docs/TASKS.md` item is closed or duplicated (FN-42 is `[x]` at line 141). Orchestrator adds a new row
  "FN-42b changelog page, automatic update checks, what's new notice" at the end of the build, adds an FN-42b entry
  under FN-42 in `docs/FEATURES.md`, and moves evidence to `docs/HISTORY.md`.
- `docs/ACCEPTANCE.md`: the FN-42 update-flow row can gain an FN-42b note only with the named checks AC 10, 11 and 17
  (Browser) passed; AC 7, 8, 15 and 20 are Automated; nothing moves to Pass without the run.
