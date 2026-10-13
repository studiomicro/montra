# FN-14 Voice and quick text entry (Suara) — engineer report (cycle 1)

Branch `fn-14-voice` from `main` @ `8cecdc6`. Not pushed. No migration (PRD: no new table).

## What works

- `/riwayat/suara` (signed-in, current space via `currentSpaceScope` → `requireSpaceAccess`). Tambah sheet "Suara"
  and Beranda's Suara pill now link to `/riwayat/suara?mulai=1`; Otomatis/Struk/Mutasi and the Struk pill stay
  "Segera hadir".
- **Voice:** `SpeechRecognition`/`webkitSpeechRecognition` feature-detected on mount. With `?mulai=1` recording
  starts at once (`lang = 'id-ID'`); the ID/EN `Segmented` restarts it in `en-US`. The live transcript renders
  with every `findMoneyMentions` span in `<mark>` (ink on bg, both themes). `not-allowed` shows "Izin mikrofon
  ditolak. Aktifkan di pengaturan browser." and the typed field stays. Audio and transcripts never reach the
  server: parsing runs in the browser; only the reviewed rows are posted.
- **Typed sentence** always present ("Atau ketik satu kalimat"). With JS it is parsed locally (submission
  cancelled); without JS it posts to `?/parse`, which runs the same `parseVoiceSentence` and renders the rows on
  the server. Without a recogniser: "Pengenalan suara tidak tersedia di browser ini" once, no mic button.
- **Review rows:** type, amount (`AmountInput`), title, category and wallet — all editable, keyed by
  `crypto.randomUUID()`; category from the keyword hint, wallet from the hint else the favourite (IDR). A
  disabled "Periksa dengan AI" chip captioned "Belum dikonfigurasi" (inert: no env check, no network call).
  Zero amounts → "Tidak bisa membaca jumlahnya. Ketik manual." with one row whose amount is empty.
- **Simpan N transaksi** (`?/save`): every row through FN-05's compose-form schema (`parseTransactionForm` +
  `resolveTransactionInput`, ids looked up in the space only), then one all-or-nothing `db.batch` through FN-05's
  `insertTransactions` with `source = 'voice'`. ≤ 20 rows per submission; extra rows wait in the list ("{n}
  transaksi lagi menunggu…") or, without JS, are reported. Success ("{n} transaksi tersimpan.") only after the
  server confirms.
- **Catat lagi:** up to 5 chips from `frequentManualTransactions` (last 90 WIB days, manual/voice, real rows,
  live wallet + visible category). A tap records a copy dated today via `createTransaction(…, { source: 'voice' })`;
  the "Dicatat · Urungkan" toast (8 s with JS) deletes exactly that row via FN-05's `deleteTransaction`
  (`updated_at`-guarded).

## Files

- New: `src/lib/shared/voice-parse.ts`, `src/lib/server/transactions/voice.ts`, `src/lib/ui/voice/recognition.ts`,
  `src/routes/(app)/riwayat/suara/+page.server.ts`, `+page.svelte`.
- Changed: `src/lib/server/transactions/aggregate.ts` (+`frequentManualTransactions`), `transactions/messages.ts`
  (+3), `src/lib/server/forms.ts` (`readFormBody(request, max = FORM_BODY_MAX_BYTES)` — optional cap, same guard),
  `src/lib/ui/shell/nav.ts`, `src/routes/(app)/+page.svelte` (Suara pill), `src/lib/shared/i18n-en.ts` (+30).
- Tests: `src/lib/shared/voice-parse.test.ts` (53), `src/lib/ui/voice/recognition.test.ts` (7),
  `test/integration/suara-routes.test.ts` (24), `forms.test.ts` (+1), `nav.test.ts` (+1); e2e `e2e/suara.spec.ts`
  (6 × 2 projects), `e2e/shell.spec.ts` (Suara is now a link).

## Decisions taken (beyond the PRD's A–F)

- **G. One atomic batch instead of N `createTransaction` calls.** `createTransaction` is one `insertTransactions`
  in a batch; the save runs the same insert for all rows plus a `batchAssert`, so a gone wallet/category or the
  space cap writes nothing instead of a partial save. "Catat lagi" calls `createTransaction` itself.
- **H. Submission key as dedupe key.** Each review list carries a UUID; rows get `dedupe_key = <key>:<i>` (the
  "Catat lagi" tap its own key), so a double-sent form (no-JS double click, network retry) hits
  `transactions_dedupe_uq` and writes nothing ("Sudah disimpan sebelumnya…"). PRD said `dedupeKey: null`.
- **I. Native `<select>` for category and wallet, not picker Sheets** — works without JS (PRD requires no-JS
  typed entry) and follows `TransactionForm`'s wallet select; no Sheet → no focus-return concern.
- **J. "Tanpa kategori" is the empty option**: FN-05's schema requires a category, so the row is refused with
  "Pilih kategori." until one is chosen (schema not changed, per PRD).
- **K. Default wallet**: favourite if IDR, else first IDR wallet (spoken amounts are rupiah). Sen in a spoken
  amount are dropped by `AmountInput` (whole units, as in the manual form); the user sees the figure before saving.
- **L. `?mulai=1`** marks entry from the Tambah sheet / Beranda pill (auto-start), then is removed with
  `replaceState`; opening `/riwayat/suara` directly waits for a tap.
- **M. Wallet words**: own wallet names (whole words, longest first) plus `tunai`/`cash` → first `tunai` wallet and
  `kartu kredit` → first `kartu_kredit` wallet; the matched phrase (and a leading `pakai/pake/via/dengan/dari`)
  leaves the title. Words after the last amount join it up to a separator. Category hints only on expense items.
- **N. Body cap** for `?/save` is 24 KiB (20 rows × 80-char multi-byte titles fit; tested); other actions keep 8 KiB.

## Gates and e2e

- `npm run gates` exit 0: svelte-check 1141 files 0 errors 0 warnings; prettier + eslint clean; Vitest 78 files /
  1160 tests passed; build ✓.
- Full e2e (`E2E_PORT=8841`): 166 passed, 15 skipped (existing phone/desktop-only skips), 0 failed.
  An earlier run of `suara.spec.ts` + `shell.spec.ts` together had 6 phone tests time out in `freshUser` sign-up
  plus 2 real assertion bugs in the spec (fixed: `EN` radio needed `exact`, a zero-width assertion was a no-op);
  rerun of `suara.spec.ts` alone: 13/13 passed; then the full run above.

## Fail-before proof (mutation runs, each reverted)

- batch cap removed (`n = posted`) → 2 fail; dedupe key `null` → 2 fail; wallet looked up outside the space → 2
  fail; gap separator split disabled → 2 fail; "Catat lagi" source filter removed → 1 fail.

## Pre-handoff probes (ad-hoc `wrangler dev` :8821, local D1, plain form posts; server stopped after)

- ACCEPTANCE journey: wallet → no-JS parse "kopi 25rb dan parkir goceng" → 2 rows → save → `/riwayat` shows both:
  PASS (also e2e typed + fake-voice + no-JS, both projects). Replayed save → 409, nothing new: PASS.
- Money/slang vectors through the sentence path: cepek 100, gopek 500, seceng 1.000, noceng 2.000, goceng 5.000,
  ceban 10.000, goban 50.000, "2 ceban" 20.000, 25k, "1,5 jt", "Rp 1.250.000": 11/11 PASS (unit: 14 more).
- Hostile transcript: `<img onerror>`/`<script>` + ZWSP + RLO → escaped, invisible chars stripped, no dialog, no
  CSP violation: PASS. Oversized body → 400; JSON body → 415: PASS.
- Cross-space: B saving with A's wallet+category → 400 "Dompet tidak ditemukan."; B "Catat lagi"/"Urungkan" on
  A's row → 404; B's Riwayat has none of A's rows; signed out → 303 /masuk (POST 401): PASS. Removed member and
  forged `locals.space` (load + all 4 actions → 404): integration test PASS.
- No-JS forms: parse, refused save (row error, edits kept) and success, all without JavaScript: e2e PASS.
- 360 px: no horizontal scroll on the review list; "Catat lagi" chip ≥ 44 px: e2e PASS.
- User copy: errors are `msg()` phrases only — no path, stack or id.
- Not applicable: concurrency counters (single guarded batch; dedupe index covers resends), two-device sync
  (no local-first this pass), month boundaries (dates are `wibTodayString()`, no bucketing added).

## Gaps / not done

- Guest/local-first half of the ACCEPTANCE row (owner decision E, FN-02). AI double-check (no key) and Whisper
  fallback: out of scope. A real microphone was never exercised (Playwright uses a fake recogniser).

## Cycle 2 (red-team Lows; rebased onto `main` 0c30d13)

- **L1** `recordAgain` answers `missing` (404, same as unknown) for a `Data demo` row: `TransactionDetail` gains
  `isDemo` (`transactions/repo.ts`). Test `a "Data demo" row is not found` failed before the fix (200), passes now.
- **L2** `?mulai=1` auto-starts only after an in-app navigation from our origin (`shouldAutoStart(from, url)` in
  `src/lib/ui/voice/recognition.ts`, read in `afterNavigate`); a full page load (another site's link, reload,
  bookmark) strips the flag and waits for a tap. Unit tests (3) failed before (not a function), pass now; e2e
  covers both: Beranda pill → records at once; direct load with a foreign referer → nothing starts until tapped.
- **L3** One muted line on Suara and a "Pencatatan dengan suara" section on the `/privasi` draft: the browser's
  own recogniser may send audio to its vendor; typing sends nothing (EN entries added; e2e on both).
- Rebase: one conflict in `i18n-en.ts` (FN-13 entries kept; the duplicate `Belum dikonfigurasi` now uses FN-13's
  "Not configured"). QA's `qa-extra-fn14.test.ts` needed an `as unknown as` cast to pass svelte-check.
- `npm run db:reset:local` exit 0. `npm run gates` exit 0: svelte-check 1175 files 0/0; lint clean; Vitest 89
  files / 1255 tests; build ✓. Full e2e (`E2E_PORT=8841`): 186 passed, 15 skipped (existing), 0 failed.
