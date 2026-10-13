# FN-03 Spaces and sharing — engineer report (cycle 1)

Branch `fn-03-spaces` from `753b952` (FN-01 cycle-1 head), with `6e17051` and `42bfbb7` cherry-picked cleanly.
Owner decisions applied as accepted: A hashed invite tokens, B one live link per space, C no shared-space cap,
D no owner leave/delete, E `audit_events` write-only. Coordinator note (FN-01 red team L5) handled; see below.

## What works

- **Migration `0002_spaces.sql`** (drizzle-kit generate): `space_invites` (unique `token_hash`; partial unique
  index `space_invites_live_uq` on `space_id WHERE deleted_at is null`, so the DB allows only one live link per
  space; `space_id` and `created_by_user_id` ON DELETE CASCADE) and `audit_events` (CHECK on the six actions;
  `space_id` CASCADE; `actor_user_id`/`target_user_id` nullable, ON DELETE SET NULL so account deletion keeps the
  event without naming the deleted person). No change to FN-01 column shapes. Applied locally only.
- **`src/lib/server/spaces/access.ts`** — the FN-04+ contract, documented in its JSDoc:
  `requireSpaceAccess(db, userId, spaceId, opts?: { role?: 'owner' | 'member' })` →
  `{ space: { id, kind, name }, role }`, or `error(404, 'Not found')` for missing / not-a-member / tombstoned
  membership or space (one indexed query; ids over 64 chars still run the same query), or `error(403,
  'Forbidden')` only on a role mismatch of an existing membership. Also `resolveCurrentSpace` (cookie → live
  membership, else personal; one query, never throws), `MAX_SPACE_MEMBERS = 5`, `isSharedSpaceOwner` (SQL
  guard reused inside owner-only writes), `SPACE_COOKIE` + set/clear helpers (HttpOnly, SameSite=Lax, Secure on
  deployed hosts).
- **`invites.ts`**: token `randomToken(32)` hashed with FN-01's `sha256Hex` (same as sessions); `createInvite`
  (form carries `replaces` = live invite id the owner saw; revoke + insert + audit in one batch; insert guarded
  `NOT EXISTS live invite` + owner guard → stale/concurrent creates return null → "changed meanwhile");
  `revokeInvite` (by invite id, guarded); `resolveInvite` (one query; malformed/unknown/expired/revoked → null);
  `acceptInvite` (one guarded `INSERT … SELECT … ON CONFLICT DO UPDATE` that re-checks validity, live member
  count < 5 and not-already-member inside the write; a former member's tombstoned row is revived, never
  duplicated; `member_joined` audit guarded on `changes() = 1` in the same batch).
- **`audit.ts`**: `recordAuditEvent(db, event, now, guard?)` → batch item (`INSERT … SELECT FROM spaces WHERE id
  AND guard`), always in the same batch as the change.
- **`spaces.ts`**: `createSharedSpace` (space + owner + `space_created`, one batch; name through `cleanText`, cap
  60), `listSpaces` (bounded 100, personal first), `listMembers` (bounded 5, never returns user ids/e-mails, only
  `isYou`), `removeMember` / `leaveSpace` (tombstone + audit, same guard), `sharedSpaceHandOver` (below).
- **`hooks.server.ts`**: after the FN-01 gate, signed-in `(app)` requests get `locals.space` from the `space`
  cookie via `resolveCurrentSpace` (fallback personal). `App.Locals.space` typed.
- **Routes** `(app)/ruang/`: list + `switchSpace`; `baru` (create, cookie, 303 `/ruang/<id>`); `[id]` (members
  with Pemilik/Anggota, owner: invite create/copy/regenerate/revoke and per-member remove behind a
  `<details>` confirm; member: leave behind a `<details>` confirm); `undangan/[token]` (states open / member /
  full / invalid; `accept` → cookie + 303 `/`). Every load/action re-checks the route id with
  `requireSpaceAccess`, never `locals.space`. `ruang` removed from stub `SLUGS` and `STUBS`; `/ruang` linked from
  Pengaturan. Bodies through FN-01 `readFormBody` (415/400).
- **States**: loading = `ruang/+layout.svelte` skeleton during client navigation between /ruang pages; error =
  `(app)/+error.svelte` retry; empty = "Belum ada ruang bersama…" with create action; saving = buttons disabled
  with "Memproses…"/"Menyimpan…"; success only after the server answer (redirects, `revoked`/`removed`/`created`
  action data, `?keluar=1` after leave).
- **Coordinator note L5**: (a) all member counts, the cap and FN-01's "other member" check now ignore tombstoned
  memberships (`delete-account.ts` change). (b) `sharedSpaceHandOver` runs first in `deleteAccount`'s batch,
  guarded by the same password proof: a shared space owned by the deleted user (no other live owner) passes to
  its longest-standing live member (earliest `created_at`, then id); a shared space with no other live member is
  tombstoned (`deleted_at`), not deleted; personal spaces are still hard-deleted. The old owner's invite link
  dies with the account (cascade). No audit row is written for the hand-over (no action value for it in the
  CHECK; add one when an audit reader exists).

## Tests (Vitest 305 total, all pass)

`test/integration/spaces.test.ts` (26) and `test/integration/ruang-routes.test.ts` (16), local D1 via
`openLocalD1`: uniform 404 (missing / not mine / removed / over-long / another user's personal), 403 role
mismatch, cookie fallback, create + name cleaning, hash-only token, 7-day expiry, single live link, 10 concurrent
creates → 1, stale forms, owner-only even bypassing routes, revoke, invalid-token family, idempotent accept, cap,
**20 concurrent accepts at 4/5 → 1 joined / 19 full / 5 rows**, rejoin revives, remove/leave/owner refusals,
account deletion with invites/audit (FK), hand-over / tombstone; routes: hook `locals.space`, removed member's
next request, signed-out invite → `/masuk?next=`, 404 on every load/action, 403 member, raw link only in create
response, leave clears cookie, 415/400, switchSpace refuses foreign ids, invite states. Updated `nav.test.ts`,
`params.test.ts`, `test/helpers/event.ts` (`space`, `params`).

**Fail-before proof** (mutation runs, each reverted): no cap guard in write → concurrency test fails; access
ignoring tombstones → 3 fail; no single-live guard → 3 fail; no role check → 3 fail; owner row removable → 2
fail; switchSpace without access → 1 fail; current-space ignoring tombstones → 2 fail; expiry not checked → 2
fail; hand-over: no promotion → 3 fail, no tombstone → 2 fail, tombstoned member inherits → 1 fail;
FN-01's old "other member" check → tombstone-space test failed before the `delete-account.ts` fix.

## Pre-handoff probes (wrangler dev 127.0.0.1:8792, scratch `--persist-to`, curl-equivalent fetch, no JS)

- Concurrency: 20 concurrent `?/accept` at 4/5 members → `{"303":1,"409":19}`, all 19 show "Ruang ini sudah
  penuh.", member list 5 people. Two concurrent regenerate → 200/409 ("Data sudah berubah…").
- Cross-space: non-member, removed member, missing id → GET 404, createInvite/revokeInvite/removeMember/leave
  404/404/404/404, switchSpace 404 with no cookie set, space name never in body; 404 bodies identical after
  stripping the per-request CSP nonce; timing median 4.7 ms (not mine) vs 4.8 ms (missing), 30 samples each.
  Removed member's `GET /` with stale cookie → 200 (falls back). Member on owner actions → 403/403/403; owner
  leave → 403.
- Two tabs / stale forms: stale revoke → 409, stale remove → 409, stale regenerate → 409.
- No-JS forms: empty name → 400 with message; create → 303 + cookie; create invite → 200 with link; remove →
  200 with success text; accept → 303 `/`; leave → 303 `/ruang?keluar=1` with cookie cleared; JSON body → 415;
  20 KB body → 400.
- Existence oracle on invites: garbage / unknown 43-char / `%3Cscript%3E` / 1500-char / revoked → all 200 with
  the same body after nonce normalisation and the one message. Re-read of `/ruang/<id>` never contains the raw
  token. Signed-out invite → 303 `/masuk?next=<same invite>`.
- User copy: no file path, stack trace, raw token or session id in any error body probed.
- 360 px / contrast / focus in a browser: **not run** (no Playwright run this cycle; see e2e list). Layout uses
  kit components, token colours only, 44 px targets (summary, buttons, links).

## Checklist items applied

Concurrent writes (guarded single statements in `db.batch`, partial unique index, concurrency tests); bounded
work (all lists limited, counts in SQL, no `inArray` over growing lists); migrations (new 0002, none edited);
one access rule / no oracle (single helper, same 404 body, single query, probed); untrusted text (`cleanText`);
redirects (fixed internal targets only; sign-in return through FN-01 `safeReturnTo`); form bodies (`readFormBody`);
keyed lists (space id / membership id); CSP (no inline styles); i18n (59 phrases, all with English); truthful
state; accessibility (labels, `role=status`/`alert`, focus stays on the copy button, details-based confirm keeps
focus in place); gates; fail-before proof.

## Deviations and concerns

- `?keluar=1` success notice is URL-driven (shows for anyone who types it; harmless, no data).
- Leave clears the `space` cookie only when it named the left space (otherwise the user's current space would
  silently change); criterion 25 read in that sense.
- The (app) gate already covers criterion 13; the invite token travels in `next` to `/masuk` (inherent to links).
- Hand-over writes no audit row (CHECK has no action for it). An owner who deletes their account no longer
  orphans a space, but the inheriting member is not notified (no notification system yet).
- Accept page shows the space name to any signed-in holder of a valid link (needed to decide to join).

## E2E journeys needed (not added; FN-00 specs untouched)

1. Owner signs up → `/ruang/baru` → invite created → link copied (clipboard + "Tautan disalin." + focus on button).
2. Second user signs out/in through `/ruang/undangan/<token>` → `/masuk?next=` → accept → Beranda, space current.
3. Owner removes member via the details confirm; member's next page load falls back to personal; old URL 404.
4. Member leaves; `/ruang` shows "Kamu sudah keluar dari ruang."; sixth person sees "Ruang ini sudah penuh."
5. 360 px layout, both themes, no-JS variant of create/accept.

# Cycle 2 (controller follow-up)

- **Rebased** the two FN-03 commits onto `main` 0e01a08 (FN-01 squashed) with no conflicts; migration stays
  `0002_spaces.sql` (regenerated with drizzle-kit — it had only ever been applied to local scratch databases).
- **Hand-over audit**: new action `ownership_transferred` (schema enum + CHECK in 0002). `sharedSpaceHandOver`
  now returns three batch items; the first writes one `audit_events` row per space handed over (target = new
  owner; actor = the deleting user, set to null by the FK when the user row goes in the same batch), evaluated
  before the promotion. Tests: the hand-over row exists with `{ actor: null, target: <heir> }`; no row on a
  wrong proof or when nobody inherits. Fail-before: guarding the insert off (`sql\`0\``) fails the hand-over test.
- **Create form** uses `defaultValue` (FN-01's hydration fix).
- **E2E `e2e/ruang.spec.ts`** (owner = shared signed-in fixture; each other user its own context and simulated
  CF-Connecting-IP): create + invite + copy (clipboard content, "Tautan disalin.", copy button keeps focus, raw
  link absent on re-read); signed-out invitee → `/masuk?next=` → Daftar → accept → Beranda, space current;
  owner removes a member via the confirm → member's old URL 404 "Halaman tidak ditemukan.", `/` still 200;
  member leaves → `/ruang?keluar=1` notice, fifth joins, sixth sees "Ruang ini sudah penuh." with no join
  button, owner sees "5 dari 5 orang"; 360 px light and dark (phone project only: no horizontal scroll, invite
  buttons ≥ 44 px); no-JS owner create + link and no-JS sign-up + accept.
- `npm run gates`: check 0 errors/0 warnings, lint clean, Vitest 38 files / 325 tests, build ok.
  `npm run test:e2e` (all specs, port 8787, server stopped by Playwright): 80 passed, 9 skipped (the FN-03
  360 px tests skip on desktop by design; the rest are existing skips).

# Cycle 3 (red-team findings; QA PASS, both reports cherry-picked)

Every new test was run on the unfixed code first: 9 failed (M1 repro, both L1 deletions, L2 ×2 plus the
updated leave test, L3, L4 ×2); all pass after the fixes.

- **M1 fixed.** `removeMember` now also revokes the space's live invite in the same guarded batch (with an
  `invite_revoked` row). The success text says the old link no longer works. `resolveInvite` and the
  guarded insert in `acceptInvite` also refuse a user with a `member_removed` audit row dated at or after the
  invite's `created_at`. A link the owner makes after the removal still lets that person back in, and a member
  who left on their own can still rejoin. The exact repro (join → remove → accept with the same token) now
  answers `invalid`. Mutations: no revoke → fails; no check in resolve → fails. Dropping only the check inside
  the insert survives: it is a second guard behind the pre-check and has no separately reachable path.
- **L1 fixed.** `purgeSpaces(db, ids, stillPurgeable)` in `spaces.ts` hard-deletes every space the user is the
  last live member of (personal included) and all its rows. The rows come from one list, `SPACE_SCOPED_TABLES`,
  which carries a comment that FN-04+ must add their tables. The ids are bound once as JSON, and every statement
  re-checks "no other live member", so a space someone joined after the pre-read stays whole (race test with a
  stale pre-read; mutation fails). `sharedSpaceHandOver` no longer tombstones anything.
- **L2 fixed.** The `?keluar=1` query parameter is gone. A confirmed leave sets a one-shot HttpOnly cookie,
  `space_left` (`__Host-` on deployed hosts, 60 s). `/ruang` reads it and clears it. A leave that wrote nothing
  answers 409 "Data sudah berubah…" (three concurrent leaves → 1 redirect + notice; the others 409 or 404).
- **L3 fixed, with a deviation.** The hook sets `Referrer-Policy: strict-origin` on every response whose URL
  carries an invite token: `/ruang/undangan/*`, plus `/masuk` and `/daftar` with such a `next` (early and
  resolved responses). I did not use `no-referrer`. The e2e run showed that under it Chromium sends
  `Origin: null` on no-JS form POSTs and SvelteKit's CSRF check refuses them. `strict-origin` never sends the
  path, so the token cannot leave in a Referer. `next` still carries the token (kept, as allowed). Tail and
  observability logging of request URLs remains an ops note.
- **L4 fixed.** `hostCookieName(base, secure)` in `session.ts` now names the session cookie and the space
  cookie: `__Host-space` and Secure on deployed hosts, so a plain `space` cookie planted there is ignored
  (tested). Sign-out and account deletion clear the space cookie.
- `npm run gates`: check 0/0, lint clean, Vitest 38 files / 333 tests. `npm run test:e2e`: 80 passed, 9
  skipped (the same viewport skips as before). The e2e leave journey now expects `/ruang`.
