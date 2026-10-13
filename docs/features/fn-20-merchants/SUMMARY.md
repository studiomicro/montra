# FN-20 Merchant recognition and auto-categorisation — Summary

**Status: complete** (2026-10-10, branch `feat/fn-20-merchants`, not merged, not deployed).

## Goal (from PRD)

Recognise and clean merchant names on every capture path and assign a category with a visible reason, changeable in
one tap; resolve in the order user rule → space history → cache → curated dictionary → AI, and learn from corrections
per space.

## What was built

- Shared cleaner and generic merchant dictionary (`src/lib/shared/merchants/{clean,dictionary,resolve}.ts`); the
  existing `category-keywords.ts` reads the dictionary (no second keyword table).
- Server resolver, repo, learning, drafts wiring and AI step (`src/lib/server/merchants/*`). AI: user's own key via the
  AI Gateway, batched, zod-validated, only the space's existing categories, never amounts, cached per space, 20/hour,
  off without a key.
- Wired into voice, CSV, statement import, forwarding drafts (`workers/inbound`) and manual-entry suggestions
  (`/riwayat/saran`, `TransactionForm` chip). Draft review shows reason chips and a per-row "Ubah kategori".
- Settings page `/pengaturan/pedagang` to list, search and delete learned rules.
- Migration **0035** `merchant_rules`, `merchant_cache` (+ Drizzle schema, export and space-scoped table lists, RUNBOOK
  note).

## Verification

- QA: FAIL in cycle 1 (AC-16 per-row change missing), fixed in cycle 2 (1317ef1), re-check PASS.
- Red team: PASS; lows L1–L4 open (see `SECURITY_REPORT.md`, tracked in `docs/TASKS.md`).
- Orchestrator end of cycle 2: check 0 errors 0 warnings; lint exit 0; Vitest 270 files / 4029 tests passed; build
  exit 0; `e2e/fn20-merchants-qa.spec.ts` 9 passed.
- **NOT verified:** a real Anthropic call for the AI step (tests use a stubbed model; mocked AI does not count as
  working). Gmail path not built (applies later through the same resolver).

## Decisions

Owner said proceed: all PRD "Owner decisions" defaults adopted. Orchestrator decision: the reason chip and one-tap
change apply to drafts only, because CSV and statement imports write transactions directly and have no review rows.
