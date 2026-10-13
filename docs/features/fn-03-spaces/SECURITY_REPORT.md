# FN-03 Spaces and sharing — Security report

Reviewed: `git diff 0e01a08..ea91618` (cycle 2), PRD, ENGINEER_REPORT, `docs/ENGINEERING_CHECKLIST.md`.
Reviewer: red-team-pentester, 2026-10-08.

## Verdict: FAIL

One medium finding (M1). No high findings. Low findings are tracked below.

## Findings

### M1 (medium): a removed member rejoins straight away through the same invite link

- Where: `src/lib/server/spaces/spaces.ts:91-121` (`removeMember`) together with
  `src/lib/server/spaces/invites.ts:148-216` (`acceptInvite`, which brings back a tombstoned row at `:191-200`).
- Scenario: the owner shares the 7-day link, which can be used by more than one person. Member B joins, and the
  owner later removes B (for example after a break-up). B opens the same link again and clicks "Terima". The
  guarded insert finds a live, unexpired invite, a free seat and no live membership for B, so it brings back B's
  tombstoned row. B is a member again, can see the member list now and every wallet, transaction and budget
  once FN-04+ ship. The owner gets no signal. The only defence is the owner remembering to revoke the link
  separately, and the UI does not tell them to.
- Reproduced: a temporary Vitest probe (deleted afterwards) ran `createInvite` → `acceptInvite(B)` →
  `removeMember(B)` → `acceptInvite(B)` with the same token. Results: `{"status":"joined"}`, then
  `requireSpaceAccess(B)` returned `role: "member"`.
- Breaks: PRD criterion 23 ("no silent continued access") and the brief's rule that a removed member loses
  access at once.
- Fix (either option):
  - (a) `removeMember` also revokes the space's live invite in the same `db.batch`, behind the same guard, and
    writes the `invite_revoked` audit row. The UI then says the link was reset.
  - (b) `acceptInvite` refuses to bring back a row whose last audit event is `member_removed` unless the invite
    was created after that removal (`space_invites.created_at > space_members.deleted_at`).
  - Add a regression test for "removed member + old link → invalid".
  - A member who left on their own may still rejoin (existing test `spaces.test.ts:325`); only removal must
    block.

### L1 (low): a tombstoned shared space outlives its last member's account deletion

- Where: `src/lib/server/spaces/spaces.ts:204-216` (step 3 of `sharedSpaceHandOver`) and
  `src/lib/server/auth/delete-account.ts:50-59`.
- Scenario: a user is the only live member of a shared space and deletes their account. The space is only
  soft-deleted. Its user-chosen name (probe: `"Rahasia Keluarga"`), its `audit_events` rows (actors set to
  null) and the tombstoned memberships of people who left all stay in D1 for good. Today that is only the name
  and metadata. Once FN-04+ add wallets and transactions, every financial row in such a space would survive the
  account deletion with no owner and no deletion path.
- Fix: hard-delete a shared space that has no live member left (the cascades already cover members, invites
  and audit rows), or record a retention sweep (FN-31) as a blocking prerequisite for FN-04. Add a test that
  asserts no row remains.

### L2 (low): the "you left" notice can be forged and also shows when nothing changed

- Where: `src/routes/(app)/ruang/+page.server.ts:16` and `src/routes/(app)/ruang/[id]/+page.server.ts:104-106`.
- Scenario 1: anyone can send a signed-in user a link to `/ruang?keluar=1`, and the page then says "Kamu sudah
  keluar dari ruang." with no write behind it.
- Scenario 2: `leave` ignores the `false` result of `leaveSpace` (for example after losing a race with a
  removal) and still redirects with the success notice.
- Impact: misleading text only, no data exposure. It still breaks "success only after the write is confirmed".
- Fix: show the notice only after a confirmed leave, for example with a short-lived flash cookie set by the
  action, or `fail(409, CHANGED_MEANWHILE)` when `leaveSpace` returns false.

### L3 (low): the invite token travels in URLs

- Where: `src/lib/server/spaces/invites.ts:14` (`invitePath`) and `src/lib/server/auth/gate.ts:23`
  (`next=/ruang/undangan/<token>`).
- Scenario: the raw bearer token sits in the path and in the `next` query string. It can therefore show up in
  same-origin `Referer` headers, Workers observability/tail logs and browser history.
  `Referrer-Policy: strict-origin-when-cross-origin` keeps it away from third parties.
- Impact: this is inherent to link invites. A leaked link stays usable for up to 7 days and up to the member
  cap, and M1 makes that worse.
- Fix: make sure no logpush or observability sampling keeps request URLs for `/ruang/undangan/*`. Optionally
  move the token from the path into a POST-only exchange after the first load.

### L4 (low, informational): the `space` cookie has no `__Host-` prefix and survives sign-out

- Where: `src/lib/server/spaces/access.ts:113-129`.
- Scenario 1: a sibling subdomain can toss a `space` cookie.
- Scenario 2: after A signs out, B signing in on the same browser inherits A's shared-space id in an HttpOnly
  cookie.
- Impact: none found, because `resolveCurrentSpace` checks membership again on every request and falls back to
  B's personal space. Only the id (a UUID) is visible.
- Fix: use `__Host-space` on secure hosts like the session cookie, and clear it on sign-out and account
  deletion.

## Areas checked without findings

- **`requireSpaceAccess` gate (`access.ts:47-71`)**
  - One joined query covers all three not-allowed cases (missing space, no membership, tombstoned
    membership/space), with one fixed `404 Not found`.
  - An over-long id costs the same query.
  - `403` is returned only to live members who lack the role.
  - `userId` always comes from `locals.user`.
- **Route coverage**
  - Every load and action under `/ruang/[id]` goes through the gate on `params.id`, never `locals.space`.
  - `switchSpace` checks access before setting the cookie.
  - `memberId`, `inviteId` and `replaces` are always paired with the gated `spaceId` inside the SQL, so a
    cross-space id gives `gone` or `409` (no IDOR).
- **`locals.space`**
  - It is resolved only for `(app)` routes and is membership-filtered in one query.
  - A foreign or garbage cookie silently falls back to the personal space, so nothing leaks through
    `__data.json` or error pages: `+error.svelte` shows only a generic text for each status.
- **Invites**
  - Tokens are 256-bit (`randomToken(32)`) and checked against a format regex.
  - Only the SHA-256 is stored, under a unique index, and looked up by hash, so lookup timing reveals nothing
    useful.
  - Invalid, expired and revoked tokens give one answer.
  - There is a single live link per space (partial unique index plus a `not exists` guard in the batch).
  - Revocation and creation are owner-guarded inside each statement.
  - An expired invite gives `invalid` (probe P3).
- **Concurrency**
  - The 5-member cap is re-checked inside one `INSERT … SELECT` that brings back tombstoned rows instead of
    duplicating them.
  - The audit row is tied to `changes() = 1`.
  - Owner-only writes repeat `isSharedSpaceOwner` inside the statement.
- **Owner edge cases**
  - The owner cannot leave or be removed (`role = 'member'` guards).
  - A member cannot trigger a handover: it runs only inside `deleteAccount` behind the deleting user's
    password-hash proof.
  - The heir is the earliest live non-tombstoned member.
  - The handover audit row is written before the promotion.
  - The batch index of the credential delete (`[6]`) is correct.
- **`audit_events`**: it holds ids and a fixed action enum only (CHECK constraint), with no names, e-mails or
  free text. Actor and target are set to null on user delete. The table is write-only.
- **CSRF**: every mutation is a SvelteKit form action, with the default origin check left on.
- **Body cap**: every action reads its body through `readFormBody` (8 KiB cap, 415/400/408). The space name is
  cleaned and capped at 60 characters.
- **Open redirect**: `next` is built from `url.pathname` by FN-01's unchanged `signInLocation` and its
  validated reader. The invite flow adds no new redirect target: redirects go to `/`, `/ruang` or
  `/ruang/<uuid>`.
- **Output**: no `{@html}`, no logging of tokens or ids. The token never appears in page data after creation.
  Errors are fixed strings, translated through `tr()`.

## Engineering checklist

- "One access rule": met.
- "Concurrency: 20 concurrent at any invite": met by the tests.
- "Cross-space: crawled as a non-member and as a removed member": met for direct URLs. M1 shows that the
  removed-member crawl did not cover the invite route.
- "Success only after the write is confirmed": see L2.

## Commands run

- `npm ci`, then `npx svelte-kit sync`.
- `npx vitest run test/integration/spaces.test.ts test/integration/ruang-routes.test.ts`: 42 passed.
- Temporary probe `test/integration/zz-redteam-probe.test.ts` (P1 removed-member rejoin: **joined**; P2
  last-member deletion: space row kept with name, tombstoned; P3 expired accept: invalid). 3 passed. The file
  was deleted and not committed.

## Cycle 3 re-check (8910aec; diff 39ad808..8910aec)

### Verdict: PASS

All medium findings are fixed. No new medium or high issues. The remaining low items are tracked below.

| Finding | Status | Evidence |
| --- | --- | --- |
| M1 removed member rejoins | **FIXED** | See M1 below. |
| L1 tombstoned space outlives last member | **FIXED** | See L1 below. |
| L2 forgeable "you left" notice | **FIXED** | See L2 below. |
| L3 invite token in URLs | **FIXED (Referer); residual low** | See L3 below. |
| L4 `space` cookie prefix / sign-out | **FIXED; residual info** | See L4 below. |

**M1 (removed member rejoins): FIXED**

- `removeMember` (`spaces.ts:107-127`) revokes the live invite and writes `invite_revoked` in the same guarded
  batch.
- `notRemovedSince` (`invites.ts:32-36`) is applied both in `resolveInvite` and inside the guarded insert of
  `acceptInvite`.
- Probe results:
  - Old link after removal → `invalid`.
  - `liveInvite` → null.
  - A link the owner creates after the removal lets the person back in (intended).
  - A removal at the same millisecond as the invite creation is blocked (`>=`).
  - A member who left on their own can still rejoin.

**L1 (space outlives its last member): FIXED**

- `purgeSpaces` (`spaces.ts:219-243`) hard-deletes `audit_events`, `space_invites`, `space_members` and then
  `spaces`, limited to a JSON-bound id list.
- Each statement checks again that no other live member exists.
- Probe with bystander spaces present:
  - The purged space has 0 rows in every table, including a former member's tombstoned row.
  - The bystander space, its 2 live members and its audit rows are untouched. This rules out a column-scope bug
    in the correlated guard.
  - The heir becomes owner of a space that still has a live member.
  - A former member's account and personal space are unaffected.
- FN-04+ must add every new space-scoped table to `SPACE_SCOPED_TABLES`. This should become a checklist item, or
  a test that compares the list with every schema table that has `space_id`.

**L2 (forgeable "you left" notice): FIXED**

- The notice is now a one-shot HttpOnly cookie (`__Host-` prefixed on deployed hosts), set only after
  `leaveSpace` wrote.
- A leave that wrote nothing gets `409 CHANGED_MEANWHILE`.
- `?keluar=1` is no longer read.

**L3 (invite token in URLs): FIXED for Referer; residual low**

- `Referrer-Policy: strict-origin` is set on `/ruang/undangan/*` (page, `__data.json` and the action) and on
  `/masuk` and `/daftar` when `next` names an invite. A Referer therefore carries at most the origin.
- The choice of `strict-origin` over `no-referrer` is accepted. Under the Fetch spec, a request whose referrer
  policy is `no-referrer` sends `Origin: null` on a POST, which SvelteKit's origin check rejects. The
  `strict-origin` policy still never sends the path, which holds the secret.
- Residual (low, unchanged): `wrangler.jsonc` has `observability.enabled: true`, so Workers Logs record request
  URLs including invite tokens for the log retention period. Owner decision: accept this, or redact
  `/ruang/undangan/*` paths.

**L4 (`space` cookie prefix and sign-out): FIXED; residual info**

- The cookie is now `__Host-space` with Secure on deployed hosts, and a plain `space` cookie is ignored there.
- It is cleared on sign-out and on account deletion (`pengaturan/akun/+page.server.ts:25,46`).
- Residual (info): signing in as another user through `/masuk` or `/daftar` while already signed in, or an
  expired session, does not clear it. No impact, because membership is checked again on every request.

### New in this diff

- **N1 (info): race in the account-deletion pre-read.** `delete-account.ts` reads `lastMemberOf` before the
  batch. A shared space the same user creates between that read and the batch is not purged. The batch then
  removes the user's membership, which leaves a space with no members.
  - The window is a few milliseconds and needs the deleting user's own concurrent request.
  - No other user's data is exposed.
  - Fix later: purge with an in-batch subquery instead of the pre-read list, or add a sweep for spaces with no
    members.

No new authorization, IDOR, CSRF, injection or leakage issues were found in the cycle-3 diff:
- `json_each` binds the ids as one parameter.
- The cookie names are fixed strings.

### Commands (cycle 3)

- `npx vitest run test/integration/spaces.test.ts test/integration/ruang-routes.test.ts`: 50 passed.
- Temporary probe `test/integration/zz-redteam-probe.test.ts` (re-run of the M1 and L1 repros plus bystander
  and handover checks): 4 passed. The file was deleted and not committed.
