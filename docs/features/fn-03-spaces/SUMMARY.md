# FN-03 Spaces and sharing — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (owner accepted all defaults).

- **Built:** migration `0002_spaces.sql` (space_invites, audit_events); `requireSpaceAccess(db, userId, spaceId, opts?)`
  + `isLiveMember` in `src/lib/server/spaces/access.ts` (uniform 404, 403 only on role mismatch) — the access gate
  every later feature uses; invites (256-bit token stored as SHA-256, one live link, 7-day expiry, revoke), 5-member
  cap enforced by guarded statements, space switcher (`__Host-space` cookie on deployed hosts), member remove/leave,
  `/ruang` routes, owner-deletion handover with `ownership_transferred` audit row, hard purge of spaces nobody
  inherits via `SPACE_SCOPED_TABLES` (**every FN-04+ space-scoped table must be added there**), e2e `ruang.spec.ts`.
- **QA:** PASS, 34/34 criteria.
- **Red team:** cycle 1 FAIL (M1 removed member rejoins via same link; L1–L4) → cycle 3 re-check PASS. L3 uses
  `Referrer-Policy: strict-origin` (no-referrer breaks no-JS CSRF Origin). Open info items: invite tokens appear in
  Workers request logs (auto-accepted: acceptable for internal staging; redact before public launch — TASKS item);
  N1 deletion-window race (a space created during account deletion could survive memberless; info).
