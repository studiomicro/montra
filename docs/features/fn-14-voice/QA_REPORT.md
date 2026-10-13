# FN-14 Voice and quick text entry (Suara) — QA report

## Verdict: PASS

Reviewed at `d90759c` (wip(fn-14-voice): cycle 1), parent `8cecdc6`. No migration (PRD: none required; confirmed
by `npm run db:reset:local` applying cleanly with zero new migration files in the diff).

## Commands run

- `npm ci` — exit 0, installed deps, `prepare` ran `svelte-kit sync` — local, no provider.
- `npx svelte-kit sync` — exit 0 — local.
- `npm run db:reset:local` — exit 0, all migrations applied to local D1 (fixture, no new migration in diff) — local.
- `npm run gates` (1st run) — 6 tests failed with `UND_ERR_SOCKET`/`fetch failed` in unrelated files (accounts,
  goals, laporan, ruang-routes, tabungan-routes — none touched by this diff) — miniflare socket flakiness under
  load, not a code fault — local, mocked D1/miniflare.
- `npm run test` (rerun alone) — exit 0, 78 files / 1160 tests passed — local, mocked D1/miniflare.
- `npm run gates` (2nd full run) — exit 0, check/lint/test/build all clean (svelte-check 0 errors 0 warnings;
  prettier+eslint clean; 1160/1160 tests; build succeeded) — local, mocked D1/miniflare.
- `npx vitest run test/integration/qa-extra-fn14.test.ts` (QA-authored) — exit 0, 1/1 passed — local, mocked D1.
- `npm run test` (with QA test added) — exit 0, 79 files / 1161 tests passed — local, mocked D1/miniflare.
- `E2E_PORT=8843 LD_LIBRARY_PATH=... npx playwright test` (full suite) — exit 0, 166 passed, 15 skipped
  (pre-existing phone/desktop-only skips), 0 failed — local `wrangler dev`/miniflare, fake SpeechRecognition (no
  real microphone/provider).

`npm run gates`'s first-run failures were reproduced only under full parallel load and disappeared on an isolated
`npm run test` run and on a clean second full `npm run gates` run; none of the 6 failing test files touch this
feature's diff, so this is pre-existing environment flakiness, not a regression — recorded per instructions
("Rerun failing files alone once if a full run fails; report both").

## Checked criteria

**Parsing and segmentation**
1. PASS — `voice-parse.test.ts` "kopi 25rb dan parkir goceng" → exact two-candidate fixture.
2. PASS — `parse` server action proven byte-identical to the client call (`suara-routes.test.ts`); same function.
3. PASS — each of `dan`/`terus`/`lalu`/`plus`/comma tested individually, separator stripped.
4. PASS — "kopi 25rb parkir goceng" (no separator) splits on mention boundaries alone.
5. PASS — "beli 2 kopi 50rb" keeps quantity in title; "beli 2 ceban kopi" multiplies the slang word; both
   distinguished.
6. PASS — `walletHint` matches a `context.wallets` entry; absent when no wallet word; longest-name-wins and
   fixed-word (`tunai`/`kartu kredit`) cases also tested.
7. PASS — "dapat gaji 5 jt" → income; `bonus`/`THR`/`refund`/`cashback`/`jual` each individually tested; default
   expense confirmed.
8. PASS — `kopi`→kopi, `parkir`/`bensin`→transportasi; no-keyword → undefined; income items never get a hint.
9. PASS — zero mentions → `[]`; never throws on punctuation/emoji/zero-width/odd-type input.
   Money/slang vectors confirmed via `voice-parse.test.ts` and FN-14a's `money-parse.test.ts`: cepek, gopek,
   seceng, noceng, goceng, ceban, goban, "2 ceban", "dua goban", "25k", "25 ribu", "1,5 juta"/"1,5 jt" (FN-14a
   line 84), "Rp 1.250.000", "dua puluh lima ribu", "seribu" (money-parse.test.ts:441-490) — all exact.

**Web Speech capture**
10. PASS — e2e `suara.spec.ts`: Beranda Suara pill with `?mulai=1` starts recording at once in `id-ID`; EN toggle
    restarts in `en-US`.
11. PASS — live transcript renders with `findMoneyMentions` spans in `<mark>` (code review + e2e visible-marked
    assertion).
12. PASS — e2e typed-sentence (no recogniser) test; "Pengenalan suara tidak tersedia di browser ini" shown once.
13. PASS — e2e "a refused microphone shows the permission message and keeps the typed field" — fake `onerror`
    with `not-allowed`.
14. PASS — code review: `parseVoiceSentence`/recognition run entirely client-side (`src/lib/ui/voice/recognition.ts`,
    `voice-parse.ts`); only reviewed rows are POSTed in `?/save`; no transcript field in the save form schema.

**Review and save**
15. PASS — review rows render type/amount/title/category/wallet, pre-filled, all editable (code review of
    `+page.svelte` fields; native `<select>` for category/wallet — documented deviation I, reasonable given no-JS
    requirement).
16. PASS — e2e save tests edit fields before submit and verify edited values persist, not the parsed originals.
17. PASS — `insertTransactions`/`createTransaction` reuse confirmed (`voice.ts`); `source: 'voice'`,
    `occurredOn = wibTodayString()`; success only after server confirmation (atomic `db.batch` + `batchAssert`).
18. PASS — acceptance-journey integration test: save then query rows; both present with `source = 'voice'`,
    `occurred_on = wibTodayString()`; e2e also reloads `/riwayat` after save.
19. PASS — `VOICE_BATCH_MAX = 20` enforced in `checkVoiceRows`; "a huge count reads only 20 rows and never errors"
    and ">20 candidates → 20 + remaining" tests pass.
20. PASS — cross-space wallet/category id refused `WALLET_NOT_FOUND`/`CATEGORY_NOT_FOUND` (400, uniform message),
    nothing written to either space (`suara-routes.test.ts` "cross-space").

**Dedupe / resubmission (QA focus)**
- PASS — resent submission (same key) → 409 `VOICE_DUPLICATE`, nothing new written (existing test).
- PASS (QA-authored `test/integration/qa-extra-fn14.test.ts`) — two genuinely separate submissions of identical
  content, each with its own `crypto.randomUUID()` key, both save: 2 rows exist after both calls. Confirms
  deviation H (`dedupe_key = <key>:<i>`) only guards against resend of the *same* key, not legitimate repeats —
  matching the PRD's dedupe intent.

**"Catat lagi"**
21–23. PASS — `frequentManualTransactions` grouping/ordering/visibility rules tested (`suara-routes.test.ts`
   "groups identical rows..."); no row when none qualify ("no qualifying row → no buttons"); tap→undo round trip
   verified in both integration and e2e tests, scoped to exactly the one created row.

**AI double-check (deferred)**
24–25. PASS — code review: `+page.svelte` renders a `disabled` button captioned "Belum dikonfigurasi"/"Not
   configured yet" per row; no AI Gateway import, no env check, no network call anywhere in the diff
   (`grep` for AI/gateway/anthropic in the new files returns nothing).

**Entry points**
26. PASS — `AddSheet.svelte` (unchanged, already supports `path.href`) + `nav.ts`'s `suara` row now carries
    `href: '/riwayat/suara?mulai=1'`; Otomatis/Struk/Mutasi untouched, still disabled.
27. PASS — Beranda's Suara pill is now an `<a href="/riwayat/suara?mulai=1">`; Struk pill stays `disabled`.

**Cross-cutting**
28. PASS — every load/action calls `currentSpaceScope(locals)` → `requireSpaceAccess`; no client-supplied
    `spaceId` read anywhere in `+page.server.ts`/`voice.ts`.
29. PASS — "a removed member reads and writes nothing of the shared space; a forged space is a 404" test covers
    load + all four actions (`parse`, `save`, `catatLagi`, `urungkan`) both via natural cookie fallback and via a
    forged `locals.space` — all 404, nothing written.
30. PASS — `readFormBody(request, max)` reused (not a new guard) for all four actions; oversized body → 400,
    non-form body → 415 (test: "a body over the voice cap is refused with 400, a non-form body with 415"); 24
    KiB cap on `save` justified and tested with 20 rows of 80-char multi-byte titles fitting.
31. PASS — code review: review rows keyed by `crypto.randomUUID()` assigned once per candidate (`row.key` in
    `+page.svelte`), never by title/merchant text.
32. PASS — `npm run test` includes `i18n.test.ts`; full gates run green; every new string in `i18n-en.ts` has an
    Indonesian call-site counterpart (spot-checked the +41 lines diff).
33. PASS (with a documented, reasonable scope note) — no `Sheet` component is used in this feature (deviation I:
    native `<select>`s instead, specifically to avoid the focus-return concern for a no-JS-compatible form), so
    the "Sheet closes → focus returns" clause does not apply here; touch targets ≥44px verified for the mic
    button (72×72 css) and the "Catat lagi" chip (e2e boundingBox ≥44 assertion, phone project).
34. PASS — reviewed `messages.ts` additions (`VOICE_NOTHING`, `VOICE_ROWS_INVALID`, `VOICE_DUPLICATE`) and all
    error paths in `+page.server.ts`: no file path, stack, row id or internal identifier in any user-facing string.
35. PASS — `npm run gates` clean (see Commands run); fail-before mutation proof recorded in ENGINEER_REPORT.md for
    batch cap, dedupe-key, wallet-space-lookup, gap-separator-split and Catat-lagi source-filter regressions.

## Findings

None. All 35 acceptance criteria verified PASS. No ENGINEERING_CHECKLIST.md violations found in the diff (space
access via the shared helper on every route; form-body guard reused; money parser reused with no second
tokenizer; WIB dates via the shared `wibTodayString()`; `{#each}` keyed by generated id; i18n coverage intact;
no upload/AI persistence added; idempotent capture via per-submission dedupe key).

## Notes for the tracker

- Confirms Owner decision E (guest/local-first half of the ACCEPTANCE row) remains out of scope — the signed-in
  half of "add wallet → voice 'kopi 25rb dan parkir goceng' → 2 drafts → save → reload" is fully verified here
  (criteria 1, 17, 18), both with JS (fake recogniser + typed) and without JS.
- `npm run gates`'s first pass showed 6 unrelated integration-test files failing on miniflare socket errors under
  load; a second full `npm run gates` run and an isolated `npm run test` run were both 100% clean. Recorded both
  per instructions; not attributable to this diff.
