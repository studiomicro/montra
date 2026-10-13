# FN-03 Spaces and sharing — QA report

**Verdict: PASS**

Reviewed at commit `ea91618` (FN-03 cycle 2, detached, rebased onto `main` 0e01a08).

## Commands run

- `npm ci` — installed 245 packages, exit 0, local only (no network provider calls beyond npm registry).
- `npx svelte-kit sync` — exit 0, no output, generates `.svelte-kit` types.
- `npm run gates` (check + lint + test + build) — exit 0; svelte-check 0 errors/0 warnings; prettier+eslint clean;
  Vitest 38 files / 325 tests passed; `vite build` succeeded for both client and server bundles; local D1 (SQLite
  via Miniflare), no real provider.
- `rm -rf .wrangler/state/v3/d1 && npm run db:migrate:local` — fresh local D1, 3 migrations applied
  (`0000_init.sql`, `0001_accounts.sql`, `0002_spaces.sql`), all ✅, exit 0, local D1 only.
- `npx playwright test` (full suite, port 8787, `LD_LIBRARY_PATH` set) — 80 passed, 9 skipped (desktop-only skip
  of the 360 px phone-project specs plus pre-existing skips), exit 0; local wrangler dev + local D1, no real
  provider.
- `npx vitest run src/lib/shared/i18n.test.ts` — 1 file / 12 tests passed, exit 0 (i18n EN-coverage check).

## Checked criteria

1. **Uniform 404 (missing / not-member / tombstoned / over-long id)** — PASS. `requireSpaceAccess`
   (`src/lib/server/spaces/access.ts:47-71`) is one indexed query producing one `error(404,'Not found')` body
   for all four cases. `test/integration/spaces.test.ts:90-114` asserts identical `{status:404, body:{message:
   'Not found', status:404}}` for missing/not-mine/removed/over-long/another user's personal space.
2. **403 only on role mismatch** — PASS. Same helper, `test/integration/spaces.test.ts:118-130` (member on
   owner-only → 403; owner on member-only → 403; matching role → ok).
3. **Every space-id-bearing load/action calls the helper, never trusts `locals.space`** — PASS. Verified by
   reading `src/routes/(app)/ruang/[id]/+page.server.ts`, `baru/+page.server.ts`, `undangan/[token]/+page.server.ts`
   and `+page.server.ts`'s `switchSpace`: every one resolves the id from `params`/form field through
   `requireSpaceAccess`/`acceptInvite`/`resolveInvite`. `locals.space` only supplies the default on the list page.
4. **Cookie fallback (no/invalid/foreign/stale cookie) → personal space, no error** — PASS.
   `resolveCurrentSpace` (`access.ts:78-100`); `test/integration/spaces.test.ts:133-151` and
   `ruang-routes.test.ts:141-168` (removed member's next request falls back).
5. **Create shared space: one batch (space + owner membership + `space_created` audit), cookie set, redirect**
   — PASS. `createSharedSpace` (`spaces.ts:18-40`) one `db.batch`; route sets cookie and 303s
   (`ruang-routes.test.ts:415-450`).
6. **Name cleaned/capped** — PASS. `cleanText(rawName, 60)`; `spaces.test.ts:166-177` (zero-width/control
   stripped, capped to 60 chars, empty refused).
7. **No-JS create form** — PASS. Plain POST action, no client-only behaviour required; confirmed by
   `e2e/ruang.spec.ts:195` ("without JavaScript: create a space, make a link, and a new user accepts it") — passed.
8. **Invite creation: hashed token, 7-day expiry, raw token shown once** — PASS. `createInvite`
   (`invites.ts:25-77`) stores `sha256Hex(token)`; `spaces.test.ts:184-194` checks `expires_at = NOW + 7d` and
   that `JSON.stringify(liveInvite())` never contains the raw token; `ruang-routes.test.ts:295-337` (raw link
   only in the create action response, not on reload).
9. **New invite tombstones the previous one in the same write** — PASS. `createInvite`'s batch updates the
   `replaces` row and inserts guarded by `NOT EXISTS live invite`; `spaces.test.ts:196-209`.
10. **Non-owner refused 403 on create/revoke/remove, no row change** — PASS. `spaces.test.ts:227-243`,
    `ruang-routes.test.ts:248-268`.
11. **Revoke tombstones + `invite_revoked` audit + link stops working** — PASS. `spaces.test.ts:245-260`.
12. **Concurrent create-invite races → exactly one active link** — PASS. `spaces.test.ts:211-225` (10 concurrent
    creates → 1 usable); DB partial unique index `space_invites_live_uq` backs the guarded insert
    (`migrations/0002_spaces.sql`).
13. **Signed-out visitor → `/masuk?next=` → back to the same invite** — PASS. Handled by the shared `(app)` auth
    gate (`src/lib/server/auth/gate.ts`) since `/ruang/undangan/[token]` is under `(app)`;
    `ruang-routes.test.ts:183-198` and `e2e/ruang.spec.ts` ("signed-out invitee goes through /masuk?next=, signs
    up, joins and lands on Beranda" — passed).
14. **Invalid/expired/revoked token → one generic message, no distinction** — PASS. `resolveInvite`
    (`invites.ts:119-136`) returns `null` for all three; `spaces.test.ts:262-280` (malformed/expired/revoked all
    null); route test `ruang-routes.test.ts:451-481` (unknown/garbage/expired/revoked render the same state).
15. **Full space (5 members) shows "Ruang ini sudah penuh", no row written** — PASS.
    `spaces.test.ts:302-309`, `ruang-routes.test.ts:499-513`.
16. **Already-a-member idempotent accept** — PASS. `acceptInvite` returns `{status:'member'}` without a write
    when `isMember`; `spaces.test.ts:296-300`, `ruang-routes.test.ts:482-498` (second visit idempotent).
17. **Accept under cap: one guarded insert, `member_joined` audit, cookie set, redirect** — PASS.
    `acceptInvite` (`invites.ts:148-216`) one `db.batch` with the count/membership re-check inside the INSERT
    SELECT WHERE; `spaces.test.ts:284-294`.
18. **20 concurrent accepts at 4/5 → exactly 1 joins, 19 "full", never a 6th row/500** — PASS.
    `spaces.test.ts:311-323` (1 joined / 19 full / exactly 5 live members / 5 total rows / 4 `member_joined`
    audits — matches the pre-handoff probe numbers in the engineer report).
19. **Any string token (including garbage/oversized) → same "not found" shape, never 500** — PASS.
    `INVITE_TOKEN` regex short-circuits malformed tokens before the DB query (`invites.ts:119,125`);
    `spaces.test.ts:262-276` includes `'x'.repeat(43)`, `'ä'.repeat(43)`, `'y'.repeat(9000)`, `'%00'`.
20. **switchSpace re-validates membership before setting the cookie; foreign id refused, cookie unchanged** —
    PASS. `+page.server.ts`'s `switchSpace` calls `requireSpaceAccess` before `setSpaceCookie`;
    `ruang-routes.test.ts:396-414`.
21. **Reload after switch: `locals.space` persists via the cookie, re-validated** — PASS.
    `hooks.server.ts:44-51` calls `resolveCurrentSpace` on every `(app)` request; `ruang-routes.test.ts:141-152`.
22. **Member list shows Pemilik/Anggota (Owner/Member), loading skeleton, retry on failure** — PASS.
    `listMembers` orders owner-first (`spaces.ts:68-82`); role label rendered in
    `src/routes/(app)/ruang/[id]/+page.svelte:88-92`; `ruang/+layout.svelte` shows a `Skeleton` during
    navigation; `(app)/+error.svelte` provides the retry state (reused app-wide, confirmed present).
23. **Owner removes member: tombstone + `member_removed` audit (target set); removed member's next request
    falls back, no error shown** — PASS. `removeMember` (`spaces.ts:91-120`); `spaces.test.ts:339-...` and
    `ruang-routes.test.ts:153-168` (removed member's next request falls back to personal, 200, no error) and
    `:108` 404 on the old URL. `e2e/ruang.spec.ts` "owner removes a member via the confirm" passed.
24. **Owner cannot remove/leave themselves; no "Keluar" control rendered for the owner** — PASS.
    `removeMember` returns `'owner'` and is refused (`spaces.ts:102`); `leaveSpace`/`leave` action requires
    `role:'member'` so an owner gets 403 (`[id]/+page.server.ts` `leave` action); UI guards the leave section
    with `{#if data.role === 'member'}` (`[id]/+page.svelte:160`). `ruang-routes.test.ts:269-294` ("the owner
    cannot leave or remove themselves").
25. **Member leaves: tombstone + `member_left` audit, cookie reset to personal (only if it named the left
    space), redirect `/ruang`** — PASS. `leaveSpace` (`spaces.ts:123-147`); action clears the cookie
    conditionally (`[id]/+page.server.ts` `leave`); `ruang-routes.test.ts:338-357`.
26. **Non-member (incl. just-removed) on `/ruang/[id]` or any action → uniform 404, nothing revealed** — PASS.
    `ruang-routes.test.ts:199-247` (404 on load and every action for non-member/removed/missing id, body never
    contains the space name or member list).
27. **Every load/action touching a space id calls `requireSpaceAccess`** — PASS, confirmed by direct code
    reading of all four route files; no route reads `event.locals.space` for an id the request itself supplies.
28. **i18n EN coverage** — PASS. `npx vitest run src/lib/shared/i18n.test.ts` 12/12 passed (fails if any
    Indonesian phrase added by this feature lacks an English entry); `i18n-en.ts` diff adds 62 lines matching
    the new phrases.
29. **`{#each}` lists keyed by id** — PASS. `/ruang/+page.svelte:{#each data.spaces as space (space.id)}`;
    `[id]/+page.svelte:{#each data.members as member (member.id)}`.
30. **Form bodies size-capped, 400/415 never 500** — PASS, reuses FN-01's `readFormBody`;
    `ruang-routes.test.ts:358-384` (JSON body → 415, oversized body → 400); engineer's pre-handoff probe
    confirms 20 KB body → 400, JSON body → 415.
31. **Invite expiry / audit timestamps shown in WIB** — PASS. `formatDateTimeWib` (`src/lib/shared/dates.ts`)
    used in `[id]/+page.svelte:109,124` for the invite expiry display; no money in this feature so no
    money-arithmetic criterion applies.
32. **No file path / stack trace / session id / row id / raw token in user-facing errors** — PASS by code
    inspection: all error bodies are the fixed constants (`NOT_FOUND`, `FORBIDDEN`, `CHANGED_MEANWHILE`,
    `INVITE_INVALID`, `SPACE_FULL` in `src/lib/server/spaces/messages.ts`); engineer's pre-handoff probe explicitly
    checked this and found none; re-confirmed by reading `access.ts`/`messages.ts`.
33. **Focus returns after copy/confirm; 44 px targets; AA contrast** — PASS (e2e). `e2e/ruang.spec.ts`
    "owner creates a shared space and copies the invite link; focus stays on the copy button" passed; `<details>`
    confirms keep focus in place (no modal trap introduced); buttons use the shared `Button` kit component
    (existing 44 px/contrast tokens, no new colours per the diff).
34. **`npm run gates` clean; fail-before proof shown** — PASS. Gates run above (check/lint/test/build all clean).
    Fail-before proof is narrated in `ENGINEER_REPORT.md` for criteria 1, 2, 9, 12, 17, 18, 20, 24, 26 (mutation
    reverted each time); not independently re-run by QA (narrative evidence only, as the report documents each
    mutation and the tests it broke) — this is the one criterion accepted on the engineer's documented word
    rather than QA's own re-execution; the passing test suite independently re-verifies the same behaviour on the
    current code.

## Cross-cutting / engineering checklist

- **Concurrent writes**: guarded single statements + `db.batch`, backed by the DB partial unique index for
  invites and the count-recheck-inside-insert for membership. Verified by code reading and the 10x/20x
  concurrency tests above.
- **Bounded work**: `listSpaces` limit 100, `listMembers` limit `MAX_SPACE_MEMBERS` (5), no growing `inArray`.
- **Migrations**: `0002_spaces.sql` is new, not edited; applied cleanly to a fresh local D1 (see commands run).
- **One access rule / no oracle**: single helper, single query, identical 404 body; probed with timing samples
  per the engineer's pre-handoff notes (not independently re-timed by QA; functional identity verified directly).
- **Untrusted text**: `cleanText` applied to the space name (criterion 6).
- **Redirects**: fixed internal targets only (`/`, `/ruang`, `/ruang/<id>`, `/masuk?next=...`); sign-in return
  uses the shared `signInLocation`/gate helper from FN-01, not a bespoke `startsWith('/')` check.
- **Form bodies**: reuses `readFormBody`, no second guard added.
- **Keyed lists**: confirmed (criterion 29).
- **i18n**: confirmed (criterion 28).
- **No violations found** against `docs/ENGINEERING_CHECKLIST.md` for this diff.

## Findings

None. No FAIL criteria. Two documented, acceptable deviations noted in `ENGINEER_REPORT.md` (the `?keluar=1`
notice being URL-driven with no data exposure, and the hand-over writing no CHECK-less audit action label
change) are cosmetic/non-functional and do not violate any acceptance criterion; both were reviewed and judged
harmless (no data disclosure, no authorization gap).

## Scope note (tracker)

Per the PRD, "Space isolation on every load, action and sync push/pull" stays **partially covered**: this
feature's own tables (`spaces`, `space_members`, `space_invites`) and the shared helper are fully verified; no
financial table exists yet to scope (FN-04+). `docs/ACCEPTANCE.md` should keep that row as **Not run** overall,
noted "helper verified; no financial data yet," per the PRD's own recommendation.
