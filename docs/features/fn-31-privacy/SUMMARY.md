# FN-31 Privacy — summary

**Status: complete** (2026-10-08, main d465e97). PRD: `PRD.md` (defaults auto-accepted). Legal copy is draft.

- **Built:** `/pengaturan/privasi` (usage-statistics switch, account export, consent list, links to deletion and the
  legal pages); a single Analytics Engine writer with a closed vocabulary (screen, action, device type, language,
  country) and the opt-out checked in one place; `/api/v1/track` beacon (form-encoded, same-origin, 256-byte cap);
  `consent_records` written in the sign-up batch with a required checkbox refused server-side, append-only by trigger;
  full-account zip export across the user's live spaces (FN-18 CSV reused, belongings/collectibles photos, plan,
  credit and voucher-redemption history; tokens, hashes and shared voucher definitions excluded), throttled
  5 per 10 minutes. Migration `0019_privacy.sql`. Account deletion also removes the new rows.
- **QA:** PASS 12/12. **Red team:** PASS with three lows, deferred in `docs/TASKS.md`: a running export can still
  carry a shared space's photos and member names after the member is removed (L1); the export throttle fails open on
  a D1 error (L2); the beacon has no per-user rate limit (L3). Info: notification `params` are exported unmasked
  (no account numbers in them today).
- **Not yet:** real Analytics Engine writes on staging; export size against staging subrequest/CPU limits; legal review.
