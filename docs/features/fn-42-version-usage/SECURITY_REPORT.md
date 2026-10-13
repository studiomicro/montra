# FN-42 Version and usage — Security report (Medium tier, narrow)

Reviewed: `git diff main...HEAD` in read-only worktree `.claude/worktrees/fn-42-rt` (detached at 6547dd8).
Scope: service-worker update flow, release-notes rendering, `/pengaturan/pemakaian`, `/pengaturan/tentang`.

## Verdict: PASS

No medium or high findings. Low/informational items below are tracked, none blocks.

## Checks

### Service worker and page messaging
- `src/service-worker/index.ts:32-40` — `message` handler only acts on the exact `{ type: 'SKIP_WAITING' }` shape
  (`isSkipWaitingMessage`, `src/lib/shared/sw-update.ts:22`). A service worker can only be messaged from
  same-origin clients (the `ServiceWorker` object is never exposed cross-origin), so no foreign page or frame can
  force `skipWaiting`. A same-origin script could, but that already implies XSS and gains nothing beyond activating
  the build the server deployed.
- Reload loop: `src/lib/ui/pwa/update.svelte.ts:368-372` reloads on `controllerchange` only when this page set
  `applying` and only once (`reloading` guard); a first install's `clients.claim()` or another tab's takeover does
  not reload. `applyUpdate` with nothing waiting does a single plain reload (user-initiated). No loop.
- Caching: fetch policy unchanged — navigations network-only with the offline page as fallback, `__data.json` and
  `/api/*` never intercepted or stored; the cache holds only build/static files. No authenticated HTML is cached,
  so nothing stale survives sign-out; sign-out still sends `Clear-Site-Data`, which also removes a waiting worker.
- `?build=` query: appears only in `e2e/pwa.spec.ts:379-404` (test registers `/service-worker.js?build=old`).
  No `src/` code reads a `build` parameter; production registers the fixed `/service-worker.js`. Not honoured.
- Registration remains from bundled code, no inline script: CSP unchanged.

### Release notes
- `src/routes/(app)/pengaturan/tentang/+page.svelte:669` uses `{@html note.html}`. Source is repo files bundled via
  `import.meta.glob(... '?raw', eager)` and rendered at build/module-load time by the existing blog renderer
  (`src/lib/server/content/markdown.ts`): every text run is HTML-escaped, links limited to site paths and
  `https://` (no `javascript:`/`data:`/`//`), malformed input throws. Frontmatter is zod-validated, file names
  regex-checked. No user input reaches it. Output is plain markup without inline script/style: CSP-compatible.

### `/pengaturan/pemakaian`
- Signed-out → 303 `/masuk`; `requireSpaceAccess(locals.db, user.id, locals.space.id)` runs before any query and
  outside the try, so a forged/removed membership is the shared 404 (integration tests AC2/AC3 and "after leaving").
- Account figures keyed on `locals.user.id` only; space figures on the access-checked `spaceId` only. The request
  carries no id.
- Members: only `members.length` is returned (`{ used, allowed }`); no names or e-mails in page data.
- Bounded: every list has a `limit` (spaces, tokens, categories, connections, members, ledger page +1); the rest
  are single aggregates. Parameterised Drizzle `sql` templates throughout; no string interpolation.
- No secrets in page data: token rows are reduced to a count; connections to real/demo counts.

### `/pengaturan/tentang`
- Signed-in only; returns `APP_VERSION` (a plain `wrangler.jsonc` var), its release date and bundled notes. No
  commit hash, env, binding or secret values.

## Findings

1. **Low (informational)** — `src/routes/(app)/pengaturan/pemakaian/+page.server.ts:507-508`: page data includes
   the caller's own `credit_ledger` row ids (in `ledger` and `olderCursor`). Own data only, same exposure as
   `/pengaturan/paket`; no cross-user impact. Reproduce: load the page, inspect `__data.json`. Optionally drop
   `id` from the rows if the page does not paginate from here.
2. **Low (defence in depth)** — `src/service-worker/index.ts:37`: the `message` handler does not check
   `event.source`/origin. Browser same-origin rules already block foreign senders; adding
   `event.source instanceof WindowClient` is optional hardening. Reproduce: none from a foreign origin.

## Engineering checklist
Shared space-access helper used; bounded, parameterised queries; no secrets serialised in loaders; error state
instead of invented zeros (AC24). No conflict found.

## Commands run
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 src/lib/shared/sw-update.test.ts
  src/lib/server/content/release-notes.test.ts test/integration/pengaturan-pemakaian.test.ts` — 3 files, 32 tests
  passed.
- Playwright (`e2e/pwa.spec.ts`) not run in this review.
