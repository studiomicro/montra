# SECURITY_REPORT — FN-16i Impor layout

Scope: `git diff 75824e9..7fa5e59` (Medium tier, UI-only). Reviewer: red-team-pentester, 2026-10-11.
Server-side change in the diff: only `load` in `src/routes/(app)/impor/+page.server.ts` (adds `statementCatalogue`).
No action, validation, repo or API file changed.

## Verdict: PASS

No medium or high findings. One low finding, tracked below.

## Checked

- **PickerSheet `disabled`** (`src/lib/ui/kit/PickerSheet.svelte:63-75`): the disabled branch is a native
  `<button type="button" disabled tabindex="-1" aria-disabled="true">` with no `onclick`, so neither click,
  keyboard nor assistive tech can call `choose()`. It holds no form field. The no-JS `<select name="institution">`
  lists only `selectableInstitutions` (disabled rows filtered out, `+page.svelte:389`). A crafted POST of a disabled
  id (e.g. `institution=bri`) is still refused server-side by `parseStatementFields`
  (`src/lib/server/statements/validation.ts:65`, allowlist = `STATEMENT_PARSERS`), as QA also proved.
- **XSS via catalogue labels/hints**: `INSTITUTIONS` in `src/lib/shared/statements/catalogue.ts` is static
  constants; hints are static `tr()` strings keyed by a closed enum; parser labels come from the static
  `STATEMENT_PARSERS`. All rendered as text interpolation; no `{@html}` in PickerSheet, GroupRow, the Impor page,
  SpreadsheetImport or OcrImport. Wallet `brand` comes from `matchBrand()` over a static brand list, rendered as a
  `BrandBadgeById` id, never as markup.
- **Unified wallet picker**: the removed per-panel pickers were client UI only. Every format still posts the
  shared `walletId`, and every server path still checks it against the caller's space through
  `fallbackWalletOf(db, scope.spaceId, id)` -> `getWallet` (`wallets.spaceId = spaceId`, not deleted):
  CSV `csv-import.ts:352`, statement `statement-import.ts:163`, spreadsheet `spreadsheet/import.ts` `importSheet`,
  OCR `ocr-import.ts:220`. Another space's wallet id answers `wallet_not_found` (404).
- **`statementCatalogue` in `load`**: module-level constant derived from public parser ids/labels; no space data,
  secrets or user input. No leak.
- **"Pindai struk"** links to `/riwayat/struk`, an existing signed-in route scoped by `currentSpaceScope`.
  **"Pintasan"** row has no `href`, so `GroupRow` renders a plain `<div>`: no link, no form, no post.

## Findings

1. **Low — component API footgun.** `src/lib/ui/kit/PickerSheet.svelte:56-63`: the `href` branch is tested before
   `disabled`, so an option with both `href` and `disabled: true` would render as a live link. No caller sets both
   today (catalogue rows have no `href`). Scenario: a future picker marks a link option disabled and it stays
   navigable. Fix later: check `disabled` first or type the two as exclusive.

## Commands run

- `npx vitest run src/lib/ui/kit/PickerSheet.test.ts src/lib/shared/statements/catalogue.test.ts` -> 2 files, 6 tests passed.
- `npx vitest run test/integration/impor.test.ts test/integration/impor-statements.test.ts -t "wallet|space"` -> 12 passed, 57 skipped.
- `npx vitest run test/integration/impor-spreadsheet.test.ts test/integration/impor-ocr.test.ts test/integration/impor-ocr-qa.test.ts -t "wallet"` -> 4 passed, 30 skipped (incl. cross-space wallet 404 for spreadsheet and OCR).

No PoC files created; no source edited.

## ENGINEERING_CHECKLIST

Space access unchanged and still enforced server-side for every import format; no secrets in loaders; no new SQL,
R2, AI or logging paths; disabled state is not relied on for authorization (server allowlist remains).
