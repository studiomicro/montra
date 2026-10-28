# Security report: fn-19b-gmail-followups (cycle 1, commit fb8939a on main a19d832)

**Verdict: FAIL** (1 medium finding, 3 low findings).

Scope: `git diff a19d832..fb8939a`, the PRD (Security notes and Owner answers) and `QA_REPORT.md`. Everything ran
locally with a local D1 and the fake Google. No push, no deploy, no remote D1 and no real-provider call.

## Findings

### M1 (medium): auto-save ignores sender authentication, so a spoofed `From` saves a confirmed expense

- **Where:** `src/lib/server/gmail/autosave.ts:46` (`staticRefusal` checks only scan kind, parser and registry
  domain) and `src/lib/server/gmail/read.ts:223` and `:257` (`afterCapture` receives no authentication result).
  The mail headers are parsed (`parseGmailMessage` returns `headers`), but auto-save never reads them.
- **Impact:** anyone who can send mail to the user can forge `From: noreply@<registry domain>`. A mail that Gmail
  marked `spf=fail; dmarc=fail` still lands in the inbox when the sender domain publishes DMARC `p=none`, and
  `isExcludedByLabel` only drops SPAM, TRASH, PROMOTIONS and SOCIAL. Such a mail with a bank-shaped body becomes
  a saved transaction in the chosen wallet: up to Rp 4.999.999 each and 20 per day, so about Rp 100 jt of fake
  expenses per day. Balances, budgets and safe-to-spend change, and the push says "Tersimpan otomatis". This
  breaks `docs/ENGINEERING_CHECKLIST.md` line 45 ("sender authentication failed: state Perlu ditinjau") and the
  PRD's first red-team probe ("forged From to a registry domain with a hostile amount"). The flaw is latent
  today, because `SENDER_DOMAINS` is empty. It goes live with the first registry entry the owner confirms.
  Undo and the chip limit the damage, but they do not prevent it.
- **Repro (temporary PoC, deleted after the run):** I appended two tests to
  `test/integration/gmail-followups.test.ts`, using the test registry with the fixture domain:
  1. A `qris()` mail with amount `Rp 4.999.999,00`, carrying the topmost header `Authentication-Results:
     mx.google.com; spf=fail ...; dmarc=fail (p=NONE ...) header.from=<domain>`. After one `hourly()` check, one
     `expense` transaction exists with `amount_minor = 499999900` in the auto-save wallet. Result: passed.
  2. 25 forged mails, each between Rp 4.900.000 and Rp 4.924.000, in one hourly check. 20 transactions were
     saved (about Rp 98 jt); the other 5 stayed drafts. Result: passed.

  Command: `npx vitest run test/integration/gmail-followups.test.ts -t "POC"` gave `Tests 2 passed | 32
  skipped (34)`. The file was then restored from a copy, and `git status` is clean apart from `QA_REPORT.md`.
- **Fix:** keep the capture's `trust = 'unverified'` label (owner decision L5 stands for review and labelling).
  Add one more static rule to auto-save only:
  1. Read the topmost `Authentication-Results` header with `trustedAuthResults(mail.headers, 'mx.google.com')`.
  2. Require `authenticatedFrom(auth, mail.fromAddress)`: DMARC pass and an aligned DKIM pass.
  3. Require the DMARC `header.from` to equal the registry domain.

  Pass the result into `afterCapture` and `AutoSaveInput` (for example `senderAuthenticated: boolean`), and refuse
  with `'auth'` in `staticRefusal`. A remote sender cannot place a header above the one Gmail prepends. The only
  way past the check is IMAP APPEND or the insert API, which needs mailbox access (outside this threat model).
  Regression tests: no header, `dmarc=fail`, `dmarc=pass` for another domain, and a forged `mx.google.com` header
  below a real top header must each stay a draft. A correct `dmarc=pass` + `dkim=pass` mail auto-saves. Before
  any domain enters `SENDER_DOMAINS`, confirm the real header shape from an owner sample.

### L1 (low): a push with attacker-chosen text fires for a "payment" from any sender

- **Where:** `src/lib/server/gmail/read.ts:251-264`. `afterCapture` runs for every draft of an hourly check,
  including AI reads of mail from unknown senders.
- **Impact:** an outside sender can make the user's phone show a lock-screen push. The push carries the
  merchant text and amount from the attacker's mail (for example "Pembayaran Rp 9.999.000 di <text of choice>").
  The text is cleaned and length-limited, so this is a phishing lure only: no data leaks and nothing is saved.
  Within the PRD (push per capture), but it widens the reach of a spoofed mail from Kotak masuk to the lock screen.
- **Fix (optional):** name the merchant and amount only for deterministic captures from a registry or fixture
  domain. Any other capture gets the generic "Pembayaran baru dari Gmail" with body "Perlu ditinjau".

### L2 (low): QA F2, the "Baca ulang" flag lives only on the queue message

- **Where:** `src/routes/(app)/pengaturan/aplikasi/gmail/+page.server.ts:392` and `read.ts:255`.
- **Real impact assessed:** when the enqueue fails, or the hourly sweep picks the `listed` rows first, the
  re-read runs without `reread`. If the mail's scan was `hourly`, it then pushes once and may auto-save once
  (with M1 fixed, only an authenticated, registry-domain, under-cap expense). Duplicates are impossible:
  - a rereadable row never inserted a draft before (`inserted.length === 1` is required);
  - the notification key is `gmail:<draftId>`;
  - the draft dedupe key blocks a second capture.

  So the worst case is that a late mail behaves like the hourly read it originally was. That is a small policy
  deviation from AC 3, not an exploit.
- **Fix (optional):** store the flag on the `gmail_mail` row in `requeueRereadable`, for example a
  `reread_at` column checked in `processGmailRead`. Alternatively, skip `afterCapture` when the row's `reason`
  was a rereadable failure.

### L3 (low): the `notify` action has no throttle and no stale-form check

- **Where:** `src/routes/(app)/pengaturan/aplikasi/gmail/+page.server.ts:304`.
- **Impact:** the user's own preference toggle can be written without limit, and a stale tab overwrites a newer
  choice. The action is session-scoped, idempotent and CSRF-guarded (`hooks.server.ts` `isCrossSiteForm`), so
  this is hygiene only.
- **Fix:** reuse the `gmail-autosave-setting` bucket, or document that the toggle is last-write-wins like
  `/pengaturan/notifikasi`.

## Probes that held

- **AI reading reaching auto-save:** `staticRefusal` refuses `parser === 'ai'`. A registry domain whose mail does
  not fit its parser falls to the AI path (`parser='ai'`) and stays a draft.
- **Look-alike domains:** exact lower-case match only. `evil-<d>`, `<d>.evil.tld` and subdomains match nothing.
  `addressOf` takes the angle-bracket address, so a display name that looks like a bank does not count.
- **Income and other refusals:** the guarded `draftOk` requires `type='expense'`, IDR, an amount between 1 and
  5.000.000,00, not `duplicate` and a category.
- **Caps under races and day rollover:** the per-day counter is claimed in the same guarded UPDATE
  (`auto_save_day is not today or auto_saves < 20`). D1 serialises writes, and QA's 20-concurrent test holds.
  The WIB day rolls over through `wibDateString(now)`. A refused save does not refund its slot, which only makes
  the cap stricter.
- **`setAutoSave` with another space's wallet:** the wallet must be live, IDR and in `gmail_connections.space_id`
  (`repo.ts`). After a later "Dicatat ke" change, the old wallet fails `walletOk` at capture time. The settings
  loader lists wallets only while the user is a member.
- **Review route, undo and "Simpan semua" across users or spaces:**
  - every statement is keyed by the session `user_id` plus the connection owner;
  - `liveMemberOf` drops spaces the user left;
  - another user's scan id answers 404;
  - no space or connection id is taken from the client.

  CSRF: Kit's own check is disabled (`csrf.trustedOrigins ['*']`), and `hooks.server.ts` applies the same Origin
  check to these form POSTs.
- **Undo reverting user-edited rows or another scan's rows:**
  - `transactions.updated_at = transactions.created_at` is required, and `bumpedUpdatedAt` always moves strictly
    forward, so any edit is skipped;
  - photos, transfers and live transfer links are skipped too;
  - `gmail_mail.scan_id` is set once at listing (`onConflictDoNothing`), so a later scan never takes over an
    earlier scan's mail;
  - the claim (`undone_at is null`) and every deletion run in one batch, gated on `undone_at = now`.
- **Push content and removed members:** the parameters hold the cleaned title, amount, currency, category,
  direction, draft id and transaction id (no sender, subject or Gmail id), and are zod-like validated in
  `parseParams`. `pushTarget` requires live membership and a live space. `deliverPush` returns `gone` for a
  discarded draft or a deleted transaction. Quiet hours and the preference are kept. Push text is plain text.
- **Gmail query from the registry:** domains come from a code constant (not user input). They are validated by
  `isRegistrableHost` in the registry test (letters, digits and hyphens, at most 40 characters, at most 30
  entries), so no quote, parenthesis or space can reach the `from:` term. `GMAIL_QUERY_MAX` still throws.
- **"Buka di Gmail" link:** built only from the stored Google address (`encodeURIComponent`) and a hex-checked
  Gmail id. The anchor uses `rel="noopener noreferrer"` (checked by QA in e2e).
- **Migration 0050:**
  - both rebuilds copy every column by name;
  - the CHECKs are the 0038 and 0013 lists plus `gmail_payment` (the hour CHECK is kept);
  - all 5 indexes are recreated, matching 0012 and 0013;
  - no table references the rebuilt tables;
  - the ALTERs are last, and `auto_save_wallet_id` is `ON DELETE SET NULL`.

  QA ran a fresh apply and a no-op re-run.
- **Logs:** error names only. No amounts, titles or addresses.

## Engineering checklist

Line 45 (failed sender authentication must stay "Perlu ditinjau") is violated for auto-save (M1). No other
violated item was found in the diff: guarded single statements, the shared form-body guard, the throttles for
`gmail-undo`, `gmail-autosave-setting` and `gmail-scan`, keyed lists, and the i18n entries are all in place.

## Commands run

- `npx vitest run test/integration/gmail-followups.test.ts -t "POC"` (first run): `Tests 1 failed | 1 passed |
  32 skipped (34)`. The burst PoC used identical amounts, so the duplicate flag held 19 of them back (only 1 saved).
- Same command after varying the amounts: `Tests 2 passed | 32 skipped (34)` (M1 confirmed).
- PoC removed by restoring the file from a scratchpad copy. `git status --short` shows only
  `?? docs/features/fn-19b-gmail-followups/QA_REPORT.md`, plus this report.
- No regression test kept: the role file does not ask for one, and the engineer adds it with the fix.

## Cycle 2 (commits 633085f + 9df7046, `git diff fb8939a..9df7046`)

**Verdict: FAIL** (1 new medium finding, 1 new low finding). L1, L2 and L3 are fixed. M1 is fixed for the
headers it targets, but M2 below bypasses it through the shared header parser.

### Re-check of cycle 1

- **M1: fixed as specified, but bypassable (see M2).** `gmailSenderAuthenticated` (`auth-results.ts:160`) reads
  only the topmost `Authentication-Results` and requires:
  - authserv-id `mx.google.com`;
  - `dmarc=pass`, with `header.from` equal to the registry domain;
  - a From domain equal to the registry domain;
  - an aligned DKIM pass.

  `staticRefusal` returns `'auth'` before any counter is claimed. These probes stay false (temporary unit PoC):
  - real `dmarc=fail`;
  - a forged `mx.google.com` header below Gmail's;
  - an upper-case authserv-id with a `header.from` of `<domain>.evil.test`.

  Header names are lower-cased by `parseGmailMessage`, and folding is unfolded before parsing.
- **L1: fixed.** AI reads and unconfirmed senders get "Pembayaran baru dari Gmail" / "Perlu ditinjau".
  `parseParams` accepts null merchant, amount and category only together. Residual: see L4.
- **L2: fixed.** `gmail_mail.reread_at` is set by `requeueRereadable` and checked in `processGmailRead`, so a
  re-read never notifies or auto-saves, whatever path re-sends it. The queue flag is gone. The ALTER is appended
  last in 0050.
- **L3: fixed.** The `notify` action is throttled (`gmail-autosave-setting` bucket). It now writes only through
  one guarded statement on the preference row's `updated_at` (0 means insert-if-absent): a stale tab gets 409,
  and an unparsable version is treated as stale.
- **New "Simpan semua" pickers: hold.**
  - Draft refs come only from `gmail_mail` rows with `user_id` = the session user and the connection's current
    space, so other users' drafts are never selected.
  - `setDraftsWallet` and `setDraftsCategory` re-check, inside the guarded UPDATE: live membership, a wallet in
    that space that is not deleted (archived = deleted) with a matching currency, and a category in that space
    that is not deleted and not hidden, of the drafts' kind. Another space's wallet or category answers 400.
  - Every step is guarded on the versions just read (a change elsewhere answers stale), and `saveDrafts` is still
    the only insert path.

### M2 (medium): one `;` in an attacker-controlled value forges `dmarc=pass` / `dkim=pass` inside Gmail's own header

- **Where:** `src/lib/shared/inbound/auth-results.ts:70-93` (`parseAuthResults`).
  1. It splits the header on every `;`, even inside a quoted string (`stripComments` keeps quoted strings, then
     `.split(';')` ignores them).
  2. It keeps the FIRST `dmarc=` result it sees.
  3. It accepts any `dkim=pass` result.

  Gmail writes the envelope sender into its own topmost header (`spf=... smtp.mailfrom=<MAIL FROM>`) before its
  `dmarc=` result. RFC 5321 allows a quoted local part, which may contain `;`, `=` and `,`.
- **Exploit:** send a forged `From: noreply@<registry domain>` with
  `MAIL FROM:<"x;dmarc=pass,header.from=<domain>;dkim=pass,header.d=<domain>;y"@attacker.tld>`.
  Gmail's real header ends `dmarc=fail ... header.from=<domain>`. The parser sees the injected `dmarc=pass` first,
  plus a `dkim=pass` for the domain, so `gmailSenderAuthenticated` returns true and the M1 attack (a confirmed
  expense up to Rp 4.999.999, 20 per day) works again. This depends on Gmail accepting and copying such a local
  part into `smtp.mailfrom`. That cannot be verified without real Gmail, and RFC 8601 lets the value be a quoted
  string, so Gmail copying it unescaped is plausible.
- **Repro (temporary unit PoC `test/tmp-redteam/poc.test.ts`, deleted after the run):** the call was
  `gmailSenderAuthenticated([{key:'authentication-results', value: 'mx.google.com; spf=pass (google.com: domain of
  <q> designates 203.0.113.9 as permitted sender) smtp.mailfrom=<q>; dmarc=fail (p=NONE sp=NONE dis=NONE)
  header.from=bank-contoh.co.id'}], 'noreply@bank-contoh.co.id', 'bank-contoh.co.id')`, where
  `<q> = "x;dmarc=pass,header.from=bank-contoh.co.id;dkim=pass,header.d=bank-contoh.co.id;y"@evil.test`. It
  returned `true`. Command: `npx vitest run test/tmp-redteam/poc.test.ts` gave `Tests 4 passed (4)`.
- **Fix:**
  1. Tokenise per RFC 8601: split on `;` only outside quoted strings and comments.
  2. Refuse the header (treat it as absent) when it carries more than one `dmarc` result or a quoted string
     containing `;`.
  3. Read `dkim` only as `header.d` / `header.i` tokens of a `dkim=` resinfo that the tokeniser produced.

  Add regression tests: the vector above, the same with `dkim=pass` injected through `header.s` / `header.i`, and
  a quoted `)` that closes a comment early. All must return false. The same parser drives the inbound `verified`
  label and the forwarding confirmation gate (`authenticatedFrom`), so the fix hardens those too.

### L4 (low): a lock-screen push still names attacker text for a spoofed registry-domain mail

- **Where:** `src/lib/server/gmail/read.ts:103` (`detail` = deterministic parser and confirmed domain).
- **Impact:** a forged `From` on a registry domain that fails Gmail authentication stays a draft (M1), but its
  push still shows the attacker's merchant text and amount. This is the L1 lure, limited to registry domains.
- **Fix:** use `detail = parser !== 'ai' && senderAuthenticated` (the value auto-save already computes).

### Cycle 2 commands

- `npx vitest run test/tmp-redteam/poc.test.ts`: `Tests 4 passed (4)` (the baseline and forged-lower-header
  probes hold; M2 bypass confirmed). The file was deleted afterwards.
- `npx vitest run test/integration/gmail-followups.test.ts src/lib/shared/notifications-gmail.test.ts
  test/integration/migration-0050.test.ts`: `Test Files 3 passed (3)`, `Tests 52 passed (52)`.
- `git status --short`: only `QA_REPORT.md` and `SECURITY_REPORT.md` untracked. No commit.

## Cycle 3 (commit 32a2ef8, `git diff 9df7046..32a2ef8`, reviewed in the detached worktree `fn-19b-redteam`)

**Verdict: PASS.** M2 and L4 are fixed. No new medium or high finding. Two informational notes follow.

### Re-check

- **M2 fixed.** `auth-results.ts` now splits the header with an RFC 8601 / RFC 5322 tokenizer: `;` and
  whitespace separate parts only outside quoted strings (with escapes) and nested comments. Unbalanced quoting
  returns null. `gmailSenderAuthenticated` reads the strict parse and requires all of these:
  - the authserv-id written exactly `mx.google.com`;
  - no result-like text or `;` inside any quoted string or comment;
  - no stray word and no repeated property;
  - exactly one `dmarc` result, and it is `pass`;
  - `header.from` equal to the registry domain;
  - the From domain equal to the registry domain;
  - an aligned DKIM pass in its own resinfo.

  A temporary probe file (24 cases, deleted) found every requested vector refused:
  - the cycle 2 quoted `;` vector;
  - a backslash-quote vector that Gmail would render unescaped (refused by the two-dmarc rule);
  - an unquoted `=` local part;
  - an RFC 2047 encoded word in `smtp.mailfrom` (header values are never decoded: only `From` and `Subject` are);
  - authserv-id in upper case, or a look-alike authserv-id;
  - `header.from` with a trailing dot, punycode, or a Cyrillic look-alike;
  - `header.i=@sub.D` (a child domain is not a parent, so it fails closed);
  - DKIM for another domain;
  - two dmarc results;
  - `reason=` and `policy.` properties carrying `;dmarc=pass`;
  - an escaped `\)` that tries to close a comment early;
  - an empty or whitespace-only header, and `dmarc=none`;
  - a passing header below a failing `MX.Google.com` topmost header;
  - a From on a subdomain.

  The real Gmail shape still passes, also when folded with CRLF and tabs.
- **Inbound regression check: none.** The shared `parseAuthResults` keeps the first-dmarc reading but now splits
  quote- and comment-aware, so the cycle 2 injection no longer makes an inbound mail `verified`. A
  Cloudflare-shaped passing header still gives `verified`. `auth-results.test.ts` (6) and
  `workers/inbound/src/process.test.ts` (25) pass.
- **L4 fixed.** The push names merchant and amount only when the reading is deterministic, the domain confirmed
  and Gmail authenticated the sender (`read.ts`).
- **F6.** The notify toggle has its own `gmail-notify-setting` bucket.

### Notes (informational, not findings)

- **I1 (residual, theoretical).** `mx.google.com; spf=pass smtp.mailfrom="a";dmarc=pass header.from=D;dkim=pass
  header.d=D;spf=none smtp.helo="b"@evil.test` returns true. Reaching it needs three things at once:
  - Gmail renders a quoted local part with its backslash escapes removed;
  - Gmail writes no SPF comment echoing the address (the `;` in such a comment trips the suspicious check);
  - Gmail writes no dmarc result of its own (the two-dmarc rule).

  Gmail always writes the SPF comment, so this is not reachable as far as can be checked offline. To re-check
  against the owner's real samples before the first registry entry: Gmail always writes `dmarc=` for the bank
  domains.
- **I2 (availability, fail-closed).** A legitimate header carrying Gmail's `arc=pass (i=1 ... dmarc=pass ...)`
  comment counts as suspicious, so mail that arrives through a forwarder never auto-saves. This is acceptable (it
  stays a draft). Worth knowing when reading the owner's samples.
- **CPU.** The worst 4,096-character header (all spaces, O(n²) lookahead) parses in about 8.5 ms; the other
  shapes take 0.1–1 ms. Values above 4,096 characters return null. No ReDoS.

### Cycle 3 commands

- Temporary probes `test/tmp-redteam/poc3.test.ts`, `poc4.test.ts`, `poc5.test.ts` (deleted):
  - `Tests 24 passed (24)`: all bypass vectors refused, real shape passes, inbound OK;
  - `Tests 1 passed (1)`: residual I1 `A true`, with the SPF comment `B false`, ARC comment `ARC false`;
  - CPU worst case `spaces 8.46 ms`.
- `npx vitest run src/lib/shared/inbound/gmail-auth.test.ts`: `Tests 19 passed (19)`.
- `npx vitest run src/lib/shared/inbound/auth-results.test.ts`: `Tests 6 passed (6)`.
- `npx vitest run test/integration/gmail.test.ts`: `Tests 51 passed (51)`.
- `npx vitest run workers/inbound/src/process.test.ts`: `Tests 25 passed (25)`.
- `npx vitest run` over 5 files including `test/integration/gmail-followups.test.ts`: `Test Files 1 passed (1)`,
  `Tests 46 passed (46)`. That run reported one file only, and it was not checked which one ran.
- `git status --short` in `fn-19b-redteam`: clean. No commit.
