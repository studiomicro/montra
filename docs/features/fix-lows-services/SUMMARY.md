# Fix: open lows outside import before going public — SUMMARY

Status: **complete** (2026-10-13), two fix cycles.

Owner decision 2026-10-13: fix the open low findings before the repository is published. Every open low of FN-13b,
FN-19 Gmail, FN-19 forwarding, FN-20, FN-22, FN-23, FN-25b, FN-30, FN-34b, FN-45, FN-47 and FN-51 is FIXED with a
regression test, ACCEPTED with its report's rationale or an owner decision, or left OWNER; each report carries a
"Resolution (2026-10-13)" note.

- Owner decisions applied: Gmail captures are never verified; an AI-recognised merchant name is only a "Pakai nama"
  suggestion; hiding amounts also hides trend lines and allocation shares; FN-30 lookalike addresses and the
  deleted-account oracle wait for e-mail verification.
- Main changes: Gmail AI reads capped per connection on a sliding window, token re-seal on key rotation plus an hourly
  sweep, forwarding masking, Tanya answer guard and agent-report lure filter normalised, agent run deletion and
  status scoping, report CSP by hash, Pro-claim address normalisation, streak reminders only for users due, photo
  drop handling, FN-47 guard and copy fixes, account-number masking, hidden amounts applied before any figure renders,
  merchant AI cap on a sliding hour.
- Migration: `0045_lows_services.sql` (gmail_mail reason `ai_limit`, gmail_connections AI window columns,
  agent_runs.deleted_at).
- QA: PASS (cycles 1 and 2). Red team: PASS cycle 1 with N1–N5, PASS cycle 2 with low leftovers logged in
  `docs/TASKS.md`.
- Still OWNER: FN-13b (payment provider), FN-23 S7 (delete agent reports without the plan), FN-30 L4
  (`CLAIM_HASH_KEY` before a real provider).
