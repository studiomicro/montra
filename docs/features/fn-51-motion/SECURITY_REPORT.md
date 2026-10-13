# FN-51 Motion — Security Report

- Scope: `git diff main...HEAD` (base a45585f, head 80e0fce), Medium risk tier. Read-only review; no commands run
  other than git and grep. Not run: npm, vitest, playwright, build.
- Checked against `docs/ENGINEERING_CHECKLIST.md`. Relevant items are CSP ("never `'unsafe-inline'`") and masking. No
  issue found.

## Verdict: PASS

There are no medium or high findings.

## Checks

1. **`/impor` batch ids** (`src/routes/(app)/impor/+page.server.ts:586,613,641`).
   - `undo` and `move` echo `id`, the value the client posted. The echo happens only after
     `undoImportBatch` / `moveImportBatch` succeed against `currentSpaceScope(event.locals)`.
   - `missing`, `stale` and refusals return `fail()` without the id. A foreign or unknown id therefore never comes
     back as a success.
   - `import` returns `result.batchId`, the id of the batch `importCsv` just created in the caller's scope.
   - No cross-space data leaks. The client uses the id only to compare against rows already loaded
     (`highlightedBatchId`, `src/lib/ui/motion.ts`).
2. **CSP.** `src/lib/server/csp.ts` is unchanged.
   - The diff adds no `style=` attribute, no `{@html}`, no injected `<style>` and no new script or fetch source.
   - The kotak-masuk `rowOut` transition runs through Svelte 5's `element.animate()`. It does not use a stylesheet.
   - The page enter, streak hop and pull indicator use `element.animate()` or component CSS.
3. **Pull-to-refresh** (`src/lib/ui/shell/PullToRefresh.svelte`, `pull-to-refresh.ts`).
   - It runs only in the installed app, and only when scrolled to the top, the tab is visible and no `dialog[open]`
     exists.
   - The only effect is `onrefresh`, which is `invalidateAll()` (GET loaders) on Beranda and Riwayat. It submits no
     form and fires no action.
   - A `refreshing` flag blocks re-entry, and `finally` resets it. No loop is possible.
   - Listeners are passive and removed on destroy.
4. **Storage** (`src/routes/(app)/+page.svelte` `onMount`).
   - Only the key `montra-welcome-wib-date` is stored, and its value is a WIB date string. No user data or ids are
     stored.
   - Both `getItem` and `setItem` sit inside try/catch. The diff uses no sessionStorage.
5. **Reduced motion and mis-taps.**
   - Every new animation is gated by `prefers-reduced-motion: no-preference`, or by `motionAllowed` / `rowOut`
     with a duration of 0.
   - Svelte sets `inert` on an outroing element. During the 150 ms exit, the removed Kotak masuk row's buttons
     cannot be tapped.
   - Errors and confirmations are not hidden: the page enter uses fill `none` and changes no pointer-events.

## Findings

- **LOW — sibling rows shift 150 ms later in Kotak masuk**
  (`src/routes/(app)/kotak-masuk/+page.svelte:162`).
  - Scenario: a user taps the row below a just-confirmed draft. The exit transition delays the upward shift of the
    following rows by 150 ms. A tap aimed at row N+1 during the shift can land on a different row's `?/discard`.
  - The same risk existed before this diff, with an instant shift.
  - Mitigation: the outroing row is `inert`, and the outro is short.
  - Suggestion (optional): keep the discard confirmation or undo path in place.
  - **Resolution (2026-10-13):** ACCEPTED. The report's suggested safeguard is already in place: "Abaikan" only opens a
    confirmation, and the discard needs a second tap on "Ya, abaikan" inside that row, so a mis-tap during the shift
    opens the wrong row's confirmation at worst and discards nothing. The risk predates FN-51 and the outroing row
    is `inert`.
- **LOW / informational — page enter moves `<main>` by 8 px for 200 ms** (`src/routes/+layout.svelte:66`).
  - Tap targets can be up to 8 px off their final place during the animation.
  - The page stays interactive (an existing e2e test covers this), and no destructive action sits within 8 px by
    layout.
  - No action needed.
  - **Resolution (2026-10-13):** ACCEPTED, as the report says ("No action needed"): the page stays interactive, nothing
    destructive sits within 8 px, and reduced motion turns the slide off.
