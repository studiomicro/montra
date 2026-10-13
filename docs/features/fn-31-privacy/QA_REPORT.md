# FN-31 Privacy — QA report

**Verdict: PASS**

Worktree `<repo>`, branch `fn-31-privacy`,
head `079d7f3` (rebased on `main` `780f1cb`). Reviewed PRD `docs/features/fn-31-privacy/PRD.md`, engineer
report (cycles 1-3), and the diff `git diff main...HEAD` (91 files, +8666/-100).

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` — svelte-check 1385 FILES 0 ERRORS 0 WARNINGS — exit 0 — static analysis, no provider.
- `flock /tmp/montra-heavy.lock npm run lint` — prettier clean, eslint clean — exit 0 — static analysis, no provider.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` — Test Files 138 passed, Tests 2077 passed — exit 0 — local D1/miniflare fixtures, no real provider.
- `flock /tmp/montra-heavy.lock npm run build` — vite client+server+service-worker build done — exit 0 — no provider.
- `FIN_PERSIST_TO=<fresh tmp dir> flock /tmp/montra-heavy.lock npm run db:migrate:local` — all 20 migrations incl. `0019_privacy.sql` applied ✅ on a fresh local D1 — exit 0 — local D1 (Miniflare), no remote provider.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8871 flock /tmp/montra-heavy.lock npx playwright test e2e/privasi.spec.ts e2e/paket.spec.ts --workers=2` — 9 passed, 0 failed — exit 0 — real Chromium against local `wrangler dev`/Miniflare, no real external provider.
- No dev server left running (`pgrep wrangler/vite` empty after the run).

`npm run gates` was run as its four constituent steps individually (check, lint, test with `--maxWorkers=2`,
build) to honour the RAM cap; all four were clean, equivalent to a clean `npm run gates`.

## Checked criteria (PRD `docs/features/fn-31-privacy/PRD.md`)

1. PASS — `statsDataPoint`'s blobs are exactly `screen, action, deviceType, language, country`; `track.test.ts` / `privacy.test.ts` assert the shape at runtime (type-level via `StatsFields`).
2. PASS — `/api/v1/track` no-ops when opted out (`usageStatsEnabled` checked before any write); `privacy.test.ts` asserts zero `writeDataPoint` calls; the preference is a DB row (`usage_stats_prefs`), confirmed to survive via `privasiLoad` after `setStats`.
3. PASS — `trackEvent`'s `TrackContext`/`StatsFields` types admit only the five named fields; `statsDataPoint` throws on an extra key (tested with `userId`, `email`, `amountMinor`, `ip`, `text`, `sessionId` plus a `@ts-expect-error`); only `track.ts` calls `writeDataPoint` (asserted by grep-style test).
4. PASS — `consentInserts` writes exactly 3 rows (`terms`, `privacy_policy`, `cross_border_notice`) in `signUp`'s `db.batch`; sign-up without the new checkbox is refused server-side (`errors.consent`), matching the existing "adult" checkbox pattern; e2e `paket.spec.ts`/`privasi.spec.ts` exercise `tickSignUpBoxes`.
5. PASS — `/pengaturan/privasi` shows stored consent kind/version/date (`Persetujuan` section) with an explicit empty state for pre-FN-31 accounts; both `/privasi` and `/ketentuan` keep "Draf. Isi lengkap menunggu tinjauan hukum." unchanged, with the new cross-border/statistics sections added only inside that same draft page.
6. PASS — `exportAccount` reuses `exportTransactionsCsvRanges`/`exportTransactionsCsv` (one implementation); `privacy.test.ts` asserts byte-identical output vs. FN-18's own endpoint for a one-year space and header+years concatenation for multi-year; `account.json` scanned for absence of secret column names (password hash, token, salt, nonce, key material) in a dedicated test.
7. PASS — `liveSpaceIds` subquery scopes every space table and the CSV list to live membership; test "never a space the user left or was removed from, never another account's space" confirms a removed member's former space, its CSV and its JSON folder all disappear.
8. PASS — `ACCOUNT_EXPORT_MAX_PER_WINDOW = 5` per 10-minute window; test "two exports in a row both succeed and are byte-identical" plus a 20-concurrent-request test (`overUserAttemptLimit` holds exactly 5).
9. PASS — `delete-account.ts` deletes `consentRecords` and `usageStatsPrefs` in its guarded batch; `privacy.test.ts` "account deletion removes the consent records and the statistics switch with the account" confirms removal for the deleted account and preservation for another account.
10. PASS — every new load/action/endpoint reads `locals.user.id` only (`+page.server.ts`, `ekspor/+server.ts`, `track/+server.ts`); no request-supplied id parameter exists on any FN-31 route; cross-account isolation re-confirmed by the removed-member and other-account tests above.
11. PASS — `/pengaturan/privasi` has Skeleton (retry path), ErrorState (`loadError`), saving (`savingStats`/`exporting` disabled states), and success states ("Perubahan disimpan.", "Ekspor selesai. File sudah diunduh.") shown only after server confirmation; e2e confirms no-JS fallback (plain form POST) works for both the switch and the export.
12. PASS — `test/i18n-coverage.test.ts` (part of the full vitest run) scans all of `src`/`workers` for `tr/trf/msg` calls and fails on a missing English entry; it passed with all new FN-31 strings. The statistics explanation text lists exactly the five collected blobs (screen/action, device type, language, country) and explicitly excludes account, e-mail, amount, typed text and IP — matching `statsDataPoint`'s actual fields, no overstatement.

Additional checklist/spec items verified:
- WIB month boundary: `dates.test.ts` new case `wibIsoString` at 23:30 WIB / 00:30 WIB across the day/month boundary (2026-10-31 → 2026-11-01), passed.
- Migration numbering: `0019_privacy.sql` correctly follows main's `0018_billing.sql`; applied cleanly on a fresh local D1 (see command above).
- Consent append-only: DB trigger rejects `UPDATE consent_records`, tested directly (`append-only` error).
- CSV export double-write safety (formula injection, masking) preserved — `csv-export.ts` change only restructures streaming into multi-range, reusing the same `exportLine`/`exportCells` escaping logic; no new implementation.
- No stray dev artifacts, no debug files, no edits outside the feature's own files in the diff.

## Findings

None. No FAIL criteria, no ENGINEERING_CHECKLIST violations found in this diff (D1 bounded queries via `liveSpaceIds` subqueries and capped pagination; money untouched by this feature; WIB dates tested at the boundary; access scoped to `locals.user.id`/live membership throughout; CSV export reuses the existing escaping; i18n coverage automated; gates clean).

## Notes (carried from engineer report, not blocking)

- Real Analytics Engine write to the `STATS` dataset is unverified on staging (local binding is a no-op by design; cannot be read back in tests) — consistent with PRD's own acknowledgement.
- Legal review of consent/cross-border/privacy copy remains a tracked **You** item, unchanged by this feature.
- R2 subrequest volume for the export's photo step is conservative but unmeasured against the Workers plan limit on staging (engineer-reported gap, not re-verified here since it requires a real Cloudflare account).
