# FN-42b security report (cycle 1)

Scope: `git diff 38c5f82..679fa23 -- . ':!docs/features'` (Medium tier, narrow red team). Reviewer: red-team-pentester.

## Verdict

**PASS.** No high or medium findings. One low finding carried over from FN-42 is unchanged and not made worse.

## Findings

### L1 (low, carried over from FN-42, unchanged): the service worker's `message` handler does not check `event.source`

- Location: `src/service-worker/index.ts:38` (not touched by this diff).
- Scenario: any same-origin client can post `{ type: SKIP_WAITING }` and activate a waiting worker. The attacker needs
  script running on the origin already, so the extra impact is small. FN-42b does not post to the worker.
  Automatic checks only call `registration.update()`. `applyUpdate()` stays the only sender, and only a user tap
  calls it. The finding is not worse.
- Fix (still open): accept the message only when `event.source` is a `WindowClient` of this origin.

## Focus checks

- **`{@html}` of release notes** (`src/lib/ui/pwa/ReleaseNote.svelte:33`, `src/lib/ui/pwa/WhatsNew.svelte:743`):
  the HTML comes only from `import.meta.glob('../../content/release-notes/*.md')`. These are repo files bundled at
  build time. `markdown.ts` escapes all text and allows only site-path and https links. Nothing user-controlled
  reaches the notes. `releaseNoteFor(locale, APP_VERSION)` takes the version from Worker env. `locals.locale` is
  the resolved `Locale` union, and a bad value only finds no note. `WhatsNew` prints `note.version` as escaped
  text.
- **Marketing host**: `routeFor()` sends every site-host path to `/site…`. So
  `/pengaturan/tentang/catatan-rilis` on the site host resolves to `/site/pengaturan/…`, which has no route. The
  changelog is not exposed there.
- **Signed out**: the route `/(app)/pengaturan/tentang/catatan-rilis` is protected (`isProtectedRoute`), so
  `authGate` redirects it to `/masuk?next=…` before the page loads. The page's own `redirect(303, '/masuk')` uses a
  constant target, so it is no open redirect. The `(app)` layout returns `appVersion: null, whatsNew: null` when
  signed out.
- **Layout data**: the new fields are `appVersion` (also public on `/api/v1/health`) and the bundled note
  (version, date, HTML). The diff adds no email, space id, secret or D1 read. Responses for signed-in users keep
  `cache-control: private, no-store`.
- **localStorage** (`montra-last-seen-version`): the value goes only to `isVersion()`, an anchored regex with
  bounded quantifiers. It is linear on oversized input and never used as an object key, so prototype keys cannot
  matter. It is never rendered. A tampered, corrupt or oversized value is replaced by the running version, and no
  notice shows. A downgrade or rollback shows nothing. Read and write are wrapped in `try/catch`, so blocked
  storage cannot crash the app.
- **Timers and listeners**: `startServiceWorker` runs once from the root layout's `onMount`. The root layout
  persists across client navigations. It starts `startAutoUpdateChecks` only after registration and only when not
  `stopped`. Cleanup removes both listeners and the interval. `timer ??=` prevents a second interval.
  `checkForUpdate` shares one `inFlight` promise, so `update()` calls never stack. `shouldCheckForUpdate` enforces
  a 10-minute minimum gap. No path calls `location.reload()` or `skipWaiting`. `controllerchange` reloads only when
  `pwaUpdate.applying` is set, which happens only after a user tap. The FN-02 offline queue is not touched. There
  is no reload loop.
- **CSP**: unchanged. The diff adds no `'unsafe-inline'`, no inline script and no CSP edit.
- **Checklist** (`docs/ENGINEERING_CHECKLIST.md`): the new i18n strings have English entries. Keyed `{#each}`
  blocks use `note.version`, which comes from repo files and is not user input. The only redirect has a constant
  target. The diff adds no SQL, uploads, AI, money or sync code.

## Commands

- `npx vitest run src/lib/shared/whats-new.test.ts src/lib/shared/versions.test.ts src/lib/shared/sw-update.test.ts src/lib/ui/pwa/auto-check.test.ts src/lib/ui/pwa/update.test.ts src/lib/server/content/release-notes.test.ts test/release-pages.test.ts`
  -> `Test Files  7 passed (7)`, `Tests  52 passed (52)`.
- `git diff 38c5f82..679fa23 -- . ':!docs/features' | grep "unsafe-inline\|content-security"` -> no matches.
