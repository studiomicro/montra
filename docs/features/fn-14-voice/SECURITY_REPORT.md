# FN-14 Suara — Security report

Reviewed: `git diff 8cecdc6..d90759c` (detached worktree at d90759c). Tier: Large (untrusted speech/typed text
becomes money rows).

## Verdict: PASS

No critical, high or medium findings. Three low items are listed so they are tracked.

## Scope checked

| Area | Result |
| --- | --- |
| Hostile transcript / typed text | `parseVoiceSentence` runs `cleanMoneyText` first (control, zero-width, bidi, line separators stripped; 2000-char cap, raw input cut at 4x). Probe: `<script>`/`<img onerror>`, U+202E/U+2066/U+200B, NUL/BEL/U+2028, 5000 mentions, 500x number-word runs, 100 000 digits, 200 000 zero-width chars, 20 000 separators, `__proto__`/`constructor`, negative and 10^21 amounts, 300-word wallet runs against 50 wallets: no throw, at most 20 ms, at most 200 candidates (UI keeps 20 rows plus a queue), amounts positive and within the money parser's caps. Keyword maps use `Object.hasOwn`. No `{@html}` anywhere in `src/`; the parse action echoes the sentence as data (`<img …` in the devalue payload), titles stored raw with bidi/zero-width removed and rendered as Svelte text. |
| Tampered review form | `checkVoiceRows` (`src/lib/server/transactions/voice.ts:72-134`) rebuilds each row from five named fields only and runs FN-05's `parseTransactionForm` + `resolveTransactionInput`; `occurredOn` is forced to WIB today, `transferToWalletId`/`note` blank, `source='voice'` and `is_demo=0` set server-side. Live: another space's wallet or category 400; transfer type 400; income with an expense category 400; 10^16, negative and zero amounts 400; extra `source`, `isDemo`, `occurredOn.0`, `dedupeKey.0`, `spaceId` fields ignored (row stored `voice`, `is_demo=0`, today). Archived wallets and hidden categories are excluded by `listWallets`/`listCategories` defaults and re-checked inside the insert by `refsHold`. Choosing a USD wallet stores the row in USD (currency always from the wallet, same as FN-05). |
| Dedupe keys | Key must be a UUID (`voice.ts:38-45`); `"' or 1=1--"` and `<uuid>:0` refused 400. Stored as `<key>:<i>`; the unique index is `(space_id, source, dedupe_key)` (`migrations/0004…:52`), so user B posting user A's exact key saved normally in B's space — no cross-space blocking. Catat lagi keys have no `:` suffix, so they cannot collide with save keys. Tombstones keep the dedupe key (`repo.ts:317`), so an undone row is not recreated by a replay. Keys are `crypto.randomUUID()`/`newId()`, never derived from text. |
| Catat lagi / Urungkan IDOR and races | Both go through `currentSpaceScope`; `getTransaction`/`deleteTransaction` filter by space and live membership. Live: B's catatLagi and urungkan on A's row → 404 (same answer as unknown id). 20 concurrent catatLagi with one key → 1x200, 19x409; 20 concurrent two-row saves with one key → 1x200, 19x409, exactly 2 rows stored. Undo requires the exact `updatedAt` (`1e309` → 409). Urungkan deletes only what FN-05's delete already allows a member to delete. |
| Body caps / content type | Save capped at 24 KiB (`VOICE_FORM_MAX_BYTES`), other actions keep the 8 KiB default: 30 KB save and 9 KB parse → 400 "Invalid form"; JSON body → 415; `count=9999` reads 20 rows, `count=-1` reads none; never 500. Wrangler log showed no errors. |
| CSRF / auth | SvelteKit origin check active: cross-origin POST → 403. Signed-out POST → 401. `form-action 'self'`, `frame-ancestors 'none'`. |
| Microphone / speech | `Permissions-Policy: microphone=(self), camera=(self), geolocation=()` (`src/lib/server/security-headers.ts:8`); `connect-src 'self'`. Only the browser's built-in `SpeechRecognition` is used (feature-detected); no third-party speech endpoint, no Whisper call, no audio upload. Only reviewed rows (or, without JavaScript, the typed sentence) are posted. |
| Page data | Load returns wallet id/name/type/currency, category fields, frequent groups (title, amount, wallet and category names) of the current space only and a fresh tap key — no secrets, no other-space data, no card numbers. |

## Findings

1. **Low — Catat lagi copies a `Data demo` row into a real row.**
   `src/lib/server/transactions/voice.ts:206` checks `type` and `source` but not `is_demo`; `getTransaction` does not
   return it. Demo rows are `source='manual'` with predictable ids `demo-<n>-<spaceId>` (`scripts/demo-seed.ts`).
   Reproduction (local, after `db:seed:local`): `POST /riwayat/suara?/catatLagi id=demo-1-<ownSpaceId>&key=<uuid>`
   → 200, a new `is_demo=0` voice row with the fictional amount, counted in real totals. Only in the caller's own
   space and only where demo data exists (never remote), but it breaks "demo excluded from real totals". The
   button list already excludes demo rows, so only a forged post reaches it. Fix: add `isDemo` to the detail
   columns (or a dedicated query) and answer `missing` when `is_demo = 1`; add a regression test.
2. **Low — `?mulai=1` lets any site start the microphone on a top-level navigation.**
   `src/routes/(app)/riwayat/suara/+page.svelte:211`. A cross-site link to `/riwayat/suara?mulai=1` (SameSite=Lax
   session cookie travels) starts recognition without a user gesture once the origin has microphone permission.
   Impact is limited: framing is blocked, the transcript only fills review rows on the device, nothing is saved
   without a tap, and the browser shows its recording indicator. Fix (optional): only auto-start when
   `document.referrer`/navigation is same-origin (e.g. pass the flag through SvelteKit navigation state instead
   of the URL).
3. **Low (informational) — browser speech engines may process audio off-device.**
   `src/lib/ui/voice/recognition.ts:3`. Chrome/Edge `SpeechRecognition` sends audio to the browser vendor's
   speech service. MONTRA itself sends nothing, and the comment is accurate as worded, but the privacy page and
   the Suara screen should say that the browser's own recogniser may use its vendor's servers (typed input is the
   on-device alternative).

## ENGINEERING_CHECKLIST

One access rule (`currentSpaceScope` on load and every action); bounded work (20 rows per save, 2000-char text,
90-day `frequentManualTransactions` scan through `filterWhere`, `limit` clamped to 5); one validator (FN-05 schema
reused, no second schema); guarded batch write (`refsHold`, cap, membership, trailing `batchAssert`); idempotent
capture via dedupe key per space; shared parser in `src/lib/shared`; form bodies through `readFormBody` (400/415,
never 500); keyed `{#each}` by generated row key, not by text; no `{@html}`, no LIKE/GLOB, no `inArray` growth
(ids bound once as JSON); no secrets in page data.

## Commands run

- `git switch --detach d90759c`, `npm ci`, `npx svelte-kit sync`, `npm run db:reset:local` — OK.
- `npx vitest run test/integration/suara-routes.test.ts src/lib/shared/voice-parse.test.ts src/lib/ui/voice/recognition.test.ts` — 3 files, 84 tests passed.
- Temporary parser fuzz test (12 hostile inputs) — passed, no throw, max 20 ms; file removed afterwards.
- `npm run build` — done. `wrangler dev --port 8823 --local`: two fictional users; 31 tampered/forged/cross-space/oversize/CSRF requests with the results above; 20-way concurrency on save and catatLagi; `npm run db:seed:local` then the demo-row Catat lagi reproduction (finding 1). No errors in the Worker log. Server stopped. No `--remote`, login or deploy.
