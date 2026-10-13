# FN-10 Savings goals (Tabungan) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** migration `0005_goals.sql` (goals, append-only goal_contributions with content-free deletion CHECK);
  goals section on `/kekayaan` + `/kekayaan/tabungan/[id]`; progress = SQL sum of live contributions (no mutable
  column, never linked to wallets/transactions); reversal; 50 goals per space; 10.000 live contributions per goal;
  archive/restore; `ProgressBar.svelte` (SVG, CSP-safe); shared strict `wholeAmountMinor` in `src/lib/server/forms.ts`;
  goal tables in `SPACE_SCOPED_TABLES`; `created_by_user_id` nulled on account deletion (history kept for the space);
  e2e `tabungan.spec.ts`.
- **QA:** PASS 26/26. **Red team:** PASS; Lows (content-free contribution tombstones, contribution cap) fixed and
  re-reviewed.
