# FN-14 Voice and quick text entry (Suara) — PRD

Catalog entry: `docs/FEATURES.md` › FN-14 (line 123-138). Phase: 2 — Capture. Tracker: `docs/TASKS.md` › Phase 2 ›
"FN-14 Voice · FN-18 CSV (no AI, can start early)" (`docs/TASKS.md:67`) — this PRD closes the FN-14 half. Risk
tier: **Large** (money calculation via FN-14a's parser, a new external input — the browser's microphone/Web
Speech API — and a write path into FN-05's `transactions` table with `source = 'voice'`, per `/build-feature`'s
own risk table).

Owner decisions already fixed before this pass (do not re-litigate): server-first in D1, signed-in only — the
mirror's own "works without an account" promise (`docs/FEATURES.md:137`) is **not** built this pass; guest mode
and local-first storage remain FN-02's deferred scope exactly as every prior Phase 0/1 PRD states, so this feature
proves the *signed-in* equivalent of the required journey only (see Out of scope and Owner decision E). Depends
on **FN-14a** (`docs/features/fn-14a-money-parser/PRD.md`, `findMoneyMentions`) which must exist first — this is
not stubbed with a throwaway regex (same "wait for the real one" rule every prior PRD in this repo states, e.g.
`docs/features/fn-05-transactions/PRD.md:388-392`); FN-01 (`locals.user`), FN-03 (`requireSpaceAccess`/
`locals.space`), FN-04 (`wallets`), FN-05/06 (`createTransaction`, its zod schema, `transactions`/`categories`,
`src/lib/shared/dates.ts`). **No migration** — this feature adds no table; every write is a normal
`createTransaction` call with `source: 'voice'`, a value FN-05's own `transactions.source` check constraint
already reserves (`docs/features/fn-05-transactions/PRD.md:333-335`).

## Goal

The main journey's step 3 is literally "record by voice," and the required acceptance journey is explicit:
"Guest: add wallet → voice 'kopi 25rb dan parkir goceng' → 2 drafts → save → reload" (`docs/ACCEPTANCE.md:11`).
Today `/riwayat/baru` only ever creates one transaction per form submission (FN-05), and Beranda's and the Tambah
sheet's Suara entry points are permanently disabled placeholders (`src/routes/(app)/+page.svelte:15-17`,
`src/lib/ui/shell/AddSheet.svelte:11-26`). FN-14 is the first feature to turn one sentence — spoken or typed —
into several transactions at once, reusing FN-14a's deterministic parser so the result never depends on a
network call, and reusing FN-05's existing create-transaction path so a voice-saved row is validated, space-
scoped and WIB-bucketed exactly like a manually typed one, differing only in `source`.

## Scope

- **`src/lib/shared/voice-parse.ts`** (new, pure — built on FN-14a's `findMoneyMentions`, never a second amount
  tokenizer): `parseVoiceSentence(text: string, context: VoiceContext): VoiceDraftCandidate[]`, where
  `VoiceContext = { wallets: { id: string; name: string; type: WalletType }[] }` (the space's own wallets, for
  wallet-word matching only — this module never resolves "the favourite wallet," that is the save action's job,
  server-side, from FN-04's own contract). For each `MoneyMention` `findMoneyMentions` returns, builds one
  `VoiceDraftCandidate = { title: string; amountMinor: number; type: 'expense' | 'income'; walletHint?: string;
  categoryHint?: CategoryKey }`:
  - **Segmentation:** item boundaries are the money-mention spans themselves; the words between the end of one
    mention (or the start of the sentence) and the start of the next belong to the *preceding* item's title,
    minus any of the five separator words `dan`, `terus`, `lalu`, `plus`, or a literal comma, which are stripped
    rather than kept in the title. Two mentions with no separator word between them (`docs/FEATURES.md:131`,
    "two amounts with no separator") still split into two items purely from the mention boundaries.
  - **Quantities:** a bare number immediately before a non-slang noun (`"beli 2 kopi 50rb"`) stays inside the
    title verbatim ("beli 2 kopi"); it is never read as a second amount or a multiplier — multipliers only ever
    attach to one of FN-14a's seven slang words, exactly as `findMoneyMentions`' own span already reflects
    (`docs/features/fn-14a-money-parser/PRD.md` criterion 16).
  - **Wallet words:** `"pakai gopay"`, `"tunai"`, `"kartu kredit"`, or a case-insensitive substring match against
    any name in `context.wallets`, attaches `walletHint` to the nearest item in the same clause; an item with no
    wallet word gets no hint at all (never a guess at this layer — the save action falls back to the space's
    favourite wallet, FN-04's own contract, `docs/features/fn-04-wallets/PRD.md:37-39`).
  - **Income words:** `gaji`, `bonus`, `THR`, `refund`, `cashback`, `jual` set that item's `type: 'income'`;
    every other item defaults to `type: 'expense'`.
  - **Category hint:** a small, fixed keyword map scoped to `docs/FEATURES.md:75`'s own named examples (`kopi` →
    `kopi`, `makan` → `makan`, `parkir`/`bensin` → `transportasi`) — not a general merchant-recognition engine
    (FN-20's job); an item matching none of these gets no `categoryHint` and defaults to "Tanpa kategori" in the
    review sheet.
  - Strips control/zero-width characters and caps input length before parsing (checklist › Access and privacy ›
    "Untrusted text"); never throws; a sentence with zero money mentions returns `[]`.
- **`src/lib/server/transactions/aggregate.ts`** (touched, additive — the **only** module permitted to query
  `transactions`, per FN-05's own rule, `docs/features/fn-05-transactions/PRD.md:380-381`): one new export,
  `frequentManualTransactions(db, spaceId, { limit })` → the top `limit` (an)(title, categoryId, walletId,
  amountMinor, type) groups over non-deleted `transactions` with `source IN ('manual', 'voice')`, ordered by
  occurrence count then recency, each with the count and the most recent matching transaction's fields — the
  "Catat lagi" data source (`docs/FEATURES.md:136`).
- **Route:** `src/routes/(app)/riwayat/suara/+page.server.ts` + `+page.svelte` (new, nested under Riwayat's
  compose tree alongside `/riwayat/baru`, per Owner decision A):
  - `load`: `requireSpaceAccess`-resolved space; lists wallets (FN-04), visible categories (FN-06), the space's
    favourite wallet, and `frequentManualTransactions(..., { limit: 5 })` for the "Catat lagi" row.
  - Client-side only (no server round-trip to parse): on tapping the mic, if `window.SpeechRecognition ||
    window.webkitSpeechRecognition` exists, recording starts immediately with `lang = 'id-ID'` (an ID/EN
    `Segmented` toggle re-starts recognition with `lang = 'en-US'`); the live interim transcript renders with
    every `findMoneyMentions` span wrapped in `<mark>`; on a final result, `parseVoiceSentence(transcript,
    { wallets })` runs and populates the review list. If the API is absent, the mic button is replaced by a
    `TextInput` for typed-sentence entry (FEATURES.md's own "or one typed sentence,"
    `docs/FEATURES.md:58`); the same `parseVoiceSentence` call processes its value on submit, proving
    "typing the same sentence gives the same result" (`docs/FEATURES.md:127`) by construction — one function,
    two input methods.
  - **Review list/sheet:** each `VoiceDraftCandidate` renders as an editable row — `Segmented` (Pengeluaran/
    Pemasukan), `AmountInput`, `TextInput` title, a category picker `Sheet` (defaults to `categoryHint` or
    "Tanpa kategori"), a wallet picker `Sheet` (defaults to the wallet matching `walletHint`, else the space's
    favourite) — every field editable before saving (`docs/FEATURES.md:144`: "every field editable"). A disabled
    "Periksa dengan AI" chip per row, captioned "Belum dikonfigurasi" (and English) — see Scope item below.
  - **Zero mentions:** if `parseVoiceSentence` returns `[]` for the transcript/typed text, shows "Tidak bisa
    membaca jumlahnya. Ketik manual." (and English) with a manual `AmountInput` fallback field instead of a
    review list — never a guessed amount.
  - Action `save`: re-validates each posted item through FN-05's existing create-transaction zod schema (never a
    second schema) and calls `createTransaction(db, spaceId, input, { source: 'voice', dedupeKey: null })` once
    per item, `occurredOn` defaulting to `wibTodayString()`; bounded at 20 items per submission (Owner decision
    B); returns to `/riwayat` (or a save-summary state) only once the server confirms every write.
  - Action `catatLagi`: given one `frequentManualTransactions` entry's id, calls `createTransaction(...,
    { source: 'voice' })` once, immediately, `occurredOn = wibTodayString()`; the response carries the new
    transaction's id for the client's toast-scoped "Urungkan" (see Scope item below).
- **"Belum dikonfigurasi" AI-check control (deferred, per the brief):** since no `ANTHROPIC_API_KEY`/AI Gateway
  secret is named in `.dev.vars.example` or `src/app.d.ts`'s `Env` yet (`docs/TASKS.md:42`: "Anthropic API key and
  an AI Gateway" is still a **You** item), each review row shows one disabled control captioned "Belum
  dikonfigurasi" — the same established pattern as the PWA push toggle
  (`docs/features/fn-13-pwa/PRD.md:84,189,299`) — rather than hiding the affordance entirely; no network call, no
  AI Gateway binding, no "AI setuju dengan draf ini"/"Pakai versi AI" behaviour ships this pass (see criteria
  24–25).
- **"Catat lagi" one-tap row + undo:** up to 5 buttons under the sentence field, each from
  `frequentManualTransactions`; tapping one saves immediately (action `catatLagi` above) and shows a toast
  "Dicatat · Urungkan" (and English) for a short, visible window; tapping "Urungkan" within that window calls
  FN-05's existing delete action on that exact transaction id — the only undo in this feature, scoped to the one
  row just created, never a general undo log (Owner decision C).
- **Enable the entry points:** `src/lib/ui/shell/AddSheet.svelte:11-26` / `nav.ts:45` — the `'suara'` `ADD_PATHS`
  row's `disabled` attribute is removed and it becomes `<a href="/riwayat/suara">`; `'otomatis'`/`'struk'`/
  `'mutasi'` stay disabled/"Segera hadir." Beranda's Suara pill (today's stub,
  `src/routes/(app)/+page.svelte:15-17`, or FN-08's rewritten hero if FN-07/08 lands first) is enabled and links
  to `/riwayat/suara`; the Struk pill stays disabled (FN-15).
- **i18n:** every new Indonesian phrase ("Ucapkan transaksimu", "Ketuk mikrofon untuk mulai",
  "Pengenalan suara tidak tersedia di browser ini", "Izin mikrofon ditolak. Aktifkan di pengaturan browser.",
  "Tidak bisa membaca jumlahnya. Ketik manual.", "Periksa dengan AI", "Belum dikonfigurasi", "Catat lagi",
  "Dicatat · Urungkan", "Urungkan", a `trf()` save-summary template) added to `src/lib/shared/i18n.ts` call sites
  with an English entry in `i18n-en.ts`; the coverage test fails the build if one is missing.
- **UI states:** loading (skeleton review rows while `load` runs), empty (no "Catat lagi" row when
  `frequentManualTransactions` returns none — not a placeholder row), error (`ErrorState` with retry on a failed
  load; a recognition `onerror` with `not-allowed` shows the microphone-permission message, not a generic error),
  saving (mic button shows a recording indicator; "Simpan N transaksi"/"Catat lagi" buttons disabled/spinner
  while their action runs), success (review list clears / toast shows only after the server confirms — no
  optimistic row, matching `CLAUDE.md` › UI and routes).
- **No CSP change needed:** `Permissions-Policy: microphone=(self)` already present
  (`src/lib/server/security-headers.ts:8`); the Web Speech API is a browser capability, not a page-initiated
  fetch, so `connect-src`/`script-src` are unaffected (`vite.config.ts:13-30`).

## Out of scope

- **Guest/local-first capture.** The required journey's literal "Guest:" prefix (`docs/ACCEPTANCE.md:11`) is not
  built this pass — see Owner decision E; this PRD proves the signed-in equivalent only.
- **The AI double-check** (`docs/FEATURES.md:133-135`) beyond the one disabled, captioned control — no AI Gateway
  call, no re-read, no "AI setuju"/"Pakai versi AI" ships now.
- **Workers AI Whisper fallback** (`docs/FEATURES.md:138`) for browsers without `SpeechRecognition` — this pass's
  fallback is the typed-text field, not a server-side transcription call.
- **Wallet matching beyond name/word hints.** "GoPay → e-wallet type, debit → bank account" generic type-based
  inference (`docs/FEATURES.md:57`) is FN-04/FN-19's deeper matching rule; this feature only matches the space's
  own wallet *names* and the four fixed wallet words listed in Scope.
- **Full merchant/category recognition.** FN-20's job; this feature's category hint is the small fixed keyword
  map named in Scope, nothing broader.
- **Drafts-inbox persistence.** Voice items are reviewed client-side, in the same session, and saved directly via
  `createTransaction` — they never become a `drafts` row (FN-11's table is for asynchronous, multi-day capture
  review; voice's review is synchronous, per the brief's own framing: "review sheet, save... via
  createTransaction").
- **Any change to FN-05's create-transaction zod schema or `createTransaction` signature.** Both are reused
  verbatim; FN-14 is a caller, not a modifier (same rule FN-11 already followed for its own extension,
  `docs/features/fn-11-inbox/PRD.md:237-239`).

## Acceptance criteria

**Parsing and segmentation (built on FN-14a)**

1. `parseVoiceSentence("kopi 25rb dan parkir goceng", { wallets: [] })` returns exactly two candidates: `{ title:
   'kopi', amountMinor: 2_500_000, type: 'expense' }` and `{ title: 'parkir', amountMinor: 500_000, type:
   'expense' }` — the exact fixture from the required acceptance journey (`docs/ACCEPTANCE.md:11`), proven at
   this layer once FN-14a's own criterion 20 proves the underlying mentions.
2. Typing the identical sentence into the no-JS/no-SpeechRecognition fallback field and submitting it produces
   byte-identical candidates to the voice path, because both call the exact same `parseVoiceSentence` — never two
   code paths (`docs/FEATURES.md:127`).
3. Each separator word (`dan`, `terus`, `lalu`, `plus`) and a literal comma, tested individually, correctly
   splits a two-amount sentence into two candidates with the separator stripped from both titles.
4. `"kopi 25rb parkir goceng"` (no separator word at all) still splits into two candidates purely from the money-
   mention boundaries (`docs/FEATURES.md:131`: "two amounts with no separator").
5. `"beli 2 kopi 50rb"` → one candidate, `{ title: 'beli 2 kopi', amountMinor: 5_000_000 }` (quantity stays in the
   title); `"beli 2 ceban kopi"` → one candidate with `amountMinor: 2_000_000` (the multiplier attaches to the
   slang word, per FN-14a's own criterion 14), proving the two cases are told apart correctly.
6. Given `context.wallets = [{ id: 'w1', name: 'GoPay', type: 'e_wallet' }]`, `"bayar kopi pakai gopay 25rb"` →
   `walletHint` matching `'w1'` on that candidate; a candidate with no wallet word has `walletHint === undefined`.
7. `"dapat gaji 5 jt"` → `{ type: 'income', amountMinor: 500_000_000 }`; every other income word (`bonus`, `THR`,
   `refund`, `cashback`, `jual`) tested individually sets `type: 'income'` on its own candidate; an item with none
   of them defaults to `type: 'expense'`.
8. `"kopi 25rb"` → the candidate's `categoryHint === 'kopi'`; `"parkir 5rb"`/`"bensin 50rb"` →
   `categoryHint === 'transportasi'`; an item naming none of the fixed keywords has `categoryHint === undefined`.
9. A sentence with zero money mentions (e.g. `"beli kopi"` with no amount at all) returns `[]`; `parseVoiceSentence`
   never throws on arbitrary punctuation, emoji or zero-width-character input (checklist › "Untrusted text").

**Web Speech capture**

10. Given a browser exposing `SpeechRecognition`/`webkitSpeechRecognition`, tapping "Suara" starts recording
    immediately (`docs/FEATURES.md:125`: "recording starts at once") with `lang = 'id-ID'`; the ID/EN toggle sets
    `lang = 'en-US'` and restarts recognition.
11. While recording, the live interim transcript renders with every `findMoneyMentions` span visually marked
    (`docs/FEATURES.md:125`: "words appear live with amounts highlighted") — no new colour token beyond the
    existing ink/`--cat-*` system.
12. Given a browser without `SpeechRecognition`/`webkitSpeechRecognition` (feature-detected, not user-agent
    sniffed), `/riwayat/suara` renders the typed-text fallback field instead of a mic button, with
    "Pengenalan suara tidak tersedia di browser ini" (and English) shown once, not as a repeated error.
13. Given the browser's permission prompt is denied (`onerror` with `error === 'not-allowed'`),
    "Izin mikrofon ditolak. Aktifkan di pengaturan browser." (and English) shows and the typed-text fallback is
    offered in the same view — never a silent failure or a generic crash state.
14. No audio or raw transcript bytes are ever sent to the MONTRA server as part of parsing — recognition and
    `parseVoiceSentence` both run entirely in the browser; only the final, already-parsed (and possibly user-
    edited) candidate list is POSTed on "Simpan" (`docs/FEATURES.md:125`: "the server never receives audio").

**Review and save**

15. Given at least one candidate, the review list shows every field editable (type, amount, title, category,
    wallet) pre-filled from the parser's output (`docs/FEATURES.md:144`).
16. Editing any field before submitting "Simpan N transaksi" saves the edited value, not the originally parsed
    one.
17. Given N candidates (N ≤ 20), "Simpan N transaksi" validates each through FN-05's existing create-transaction
    zod schema and calls `createTransaction(db, spaceId, input, { source: 'voice', dedupeKey: null })` once per
    item, `occurredOn` defaulting to `wibTodayString()`; the UI reflects success only once the server confirms
    every write.
18. Given the exact required-journey fixture sentence, saving, then reloading `/riwayat`, both transactions are
    present with `source = 'voice'` — "save → reload" proven for the signed-in path (see Owner decision E for the
    guest half).
19. Given more than 20 candidates in one submission (a pathological, very long typed sentence), "Simpan" processes
    at most 20 and states how many remain — never one unbounded batch (checklist › Data access › "Bounded work").
20. Given a wallet or category id in a posted item that does not belong to the current space (crafted request),
    "Simpan" is refused with the uniform not-found/forbidden response FN-05's own validation already gives
    (`requireSpaceAccess` / wallet-category space checks) — never a 500, never a row against another space.

**"Catat lagi"**

21. Given at least one prior `transactions` row with `source IN ('manual', 'voice')` in the current space,
    `/riwayat/suara` renders up to 5 "Catat lagi" buttons from `frequentManualTransactions(db, spaceId, { limit:
    5 })`, grouped by identical (title, categoryId, walletId, amountMinor, type), ordered by frequency then
    recency.
22. Tapping a "Catat lagi" button calls `createTransaction(..., { source: 'voice' })` once immediately with
    `occurredOn = wibTodayString()` and shows "Dicatat · Urungkan" (and English); tapping "Urungkan" within the
    toast's visible window deletes that exact transaction via FN-05's existing delete action — no other row is
    ever affected.
23. Given no qualifying prior transaction exists, no "Catat lagi" row renders at all (not an empty placeholder).

**AI double-check (deferred)**

24. Given no AI Gateway/Anthropic secret is configured in any environment (true for this pass everywhere), every
    review row's "Periksa dengan AI" control renders disabled, captioned "Belum dikonfigurasi" (and English); no
    network request to any AI provider is made by this feature under any circumstance.
25. No partial AI-check behaviour exists — the control is fully inert, never half-wired, so a later feature that
    adds the real AI Gateway binding does not have to first find and remove a broken stub.

**Entry points**

26. The Tambah sheet's `'suara'` row (`src/lib/ui/shell/AddSheet.svelte:11-26`) is enabled and links to
    `/riwayat/suara`; `'otomatis'`/`'struk'`/`'mutasi'` remain disabled/"Segera hadir."
27. Beranda's Suara pill (whichever shape exists at merge time) is enabled and links to `/riwayat/suara`; the
    Struk pill stays disabled.

**Cross-cutting (engineering checklist, every item that applies to this feature)**

28. Every load and action under `/riwayat/suara` resolves the space through `requireSpaceAccess` using
    `event.locals.user` — never a client-supplied `spaceId`.
29. A pre-handoff cross-space probe (crawl `/riwayat/suara` and its actions as a non-member and as a removed
    member of a space owning a wallet/category id referenced in a crafted request) returns nothing and never
    200s.
30. Every form body on every action in this feature is read within a size cap and answers 400 or 415, never 500,
    on a malformed or oversized body (reuse FN-01's `src/lib/server/forms.ts` guard, not a new one).
31. `{#each}` review-row lists are keyed by a client-generated id (`crypto.randomUUID()` per parsed candidate,
    assigned once when the list is built), never by title or merchant text.
32. Every Indonesian phrase added for this feature has an English entry in `i18n-en.ts`; `npm run test`
    (`src/lib/shared/i18n.test.ts`) fails if one is missing.
33. Focus returns to the opener when any `Sheet` in this feature closes; touch targets ≥ 44 px (mic button,
    "Catat lagi" chips); WCAG AA contrast in both themes, including the interim-transcript highlight.
34. User-facing error text in this feature never contains a file path, stack trace, row id or internal
    identifier.
35. `npm run gates` (check, lint, test, build) is clean on the branch before hand-off; every new regression test
    (segmentation vectors, bounded-batch cap, "Catat lagi" undo, cross-space probe) is shown failing on the
    unfixed code first (checklist › Tests › "Fail-before proof").

## Architecture notes

**Modules touched / added**

- `src/lib/shared/voice-parse.ts` (new) — as described in Scope; imports only
  `src/lib/shared/money-parse.ts` (FN-14a) and the `CategoryKey` type (`src/lib/ui/kit/category.ts:3-19`,
  read-only, no change to that file or its locked 15-key test).
- `src/lib/server/transactions/aggregate.ts` (touched, additive) — `frequentManualTransactions`, as described.
- `src/routes/(app)/riwayat/suara/` (new tree) — `+page.server.ts`, `+page.svelte`.
- `src/lib/ui/shell/AddSheet.svelte` / `nav.ts` — the `'suara'` row's `disabled` attribute removed.
- Beranda route (today's stub at `src/routes/(app)/+page.svelte:15-17`, or FN-08's rewrite) — Suara pill enabled.
- `src/lib/shared/i18n.ts`/`i18n-en.ts` — add every new phrase.
- No `migrations/*.sql` file; no `workers/jobs`/`workers/inbound` involvement — app Worker only, entirely
  client-side parsing with a server-side save.

**Reuse / do not duplicate**

- `createTransaction` and FN-05's existing create-transaction zod schema are the **only** way a voice item becomes
  a transaction — no second `INSERT INTO transactions`.
- `requireSpaceAccess`, FN-01's `forms.ts` guard, one money formatter, one WIB date module — none reimplemented.
- `findMoneyMentions` (FN-14a) is the **only** amount tokenizer this feature calls; `voice-parse.ts` adds
  segmentation logic only, never a second number parser.

## Prerequisites

- **No new external credentials required to ship this pass.** The Web Speech API is a browser capability, not a
  provider secret; no `.dev.vars.example` entry is needed for it.
- **AI double-check is explicitly deferred** until `docs/TASKS.md`'s "Anthropic API key and an AI Gateway" owner
  item (`docs/TASKS.md:42`) is resolved and a secret name is chosen and added to `.dev.vars.example`/
  `src/app.d.ts`'s `Env` — this PRD names no specific var because none exists yet; the disabled control's
  "Belum dikonfigurasi" caption is static this pass (no env check), and a later feature wires the real check
  using the same established pattern (`docs/features/fn-13-pwa/PRD.md:84`).
- **Build-order dependency:** FN-14a (`src/lib/shared/money-parse.ts`'s `findMoneyMentions`) and FN-01/03/04/05/06
  must exist before this feature's implementation starts — do not stub a throwaway parser or a throwaway
  `createTransaction`; wait for the real ones.

## Tracker impact

- Closes the FN-14 half of `docs/TASKS.md` › Phase 2: "`- [ ] **Claude** — FN-14 Voice · FN-18 CSV (no AI, can
  start early).`" (`docs/TASKS.md:67`) — recommend splitting that line once this and FN-18 both land.
- Moves `docs/ACCEPTANCE.md` rows:
  - "Guest: add wallet → voice 'kopi 25rb dan parkir goceng' → 2 drafts → save → reload" → the **signed-in**
    half (add a wallet via FN-04 → voice → 2 drafts → save → reload) moves toward **Browser**/**Automated** once
    criteria 1, 17, 18 pass; recommend the qa-tester note "signed-in path verified; guest half blocked on FN-02"
    rather than marking the row fully done, the same convention FN-05 used for its own deferred offline-queue gap.
  - "Integer minor units; slang and locale vectors parse exactly" → this feature is a second caller proving
    FN-14a's module is used correctly in a real save path (criteria 1, 17), not a new vector set.

## Owner decisions

**Every decision below is auto-accepted per owner instruction 2026-10-08 ("just auto accept your recomm"). No
open questions remain.**

- **A. Route home: `/riwayat/suara`**, nested under Riwayat's compose tree, matching FN-05's `/riwayat/baru`
  precedent, rather than a top-level `/suara`. *Trade-off:* a slightly longer URL; the benefit is one place for
  every "create a transaction" entry point, consistent with the Tambah sheet's own destination pattern.
- **B. Per-submission candidate cap: 20.** *Trade-off:* a pathological, very long typed sentence needs a second
  submission; real spoken/typed sentences realistically produce 2–5 items, so 20 is a generous, never-unbounded
  bound (checklist › "Bounded work").
- **C. "Catat lagi" undo is a client-side, toast-scoped delete of the just-created row — no persistent undo log.**
  *Trade-off:* once the toast is dismissed or times out, recovering a mis-tap requires the normal Riwayat edit/
  delete flow; a persistent, import-batch-style undo is unnecessary machinery for a single one-tap row.
- **D. AI double-check ships only as one disabled, captioned control, not hidden entirely.** *Trade-off:* a
  signed-in user sees no real AI benefit yet even though the mirror describes one; this is explicitly deferred per
  the brief's own instruction, not silently dropped, and the control is ready to be wired live the moment an AI
  Gateway key exists.
- **E. The guest/local-first half of the required journey is not built this pass** (FN-02 remains deferred).
  *Trade-off:* the literal "Guest: add wallet → voice..." acceptance row cannot move to a full Pass until FN-02
  ships local-first storage; this PRD proves the signed-in equivalent and flags the gap rather than claiming the
  row done.
- **F. Category/wallet hints bounded to the fixed keyword/word sets named in Scope.** *Trade-off:* an item naming
  neither a fixed keyword nor a wallet word/name defaults to "Tanpa kategori" and the favourite wallet rather than
  a broader guess; FN-20's merchant-recognition engine is the right place to grow this later, with real usage
  data instead of a guessed keyword list.
