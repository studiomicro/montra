# FN-22 Assistant "Tanya": summary

Status: **complete** (2026-10-10, branch `feat/fn-22-tanya`; not merged, not deployed).

- Goal (PRD): answer questions about the user's own money from stored rows only, with server-computed figures,
  read-only tools scoped to the current space, and a clear reason when the assistant is unavailable.
- `/tanya` replaces the "Segera hadir" stub (`STUBS`, `[stub=stub]`, `src/params/stub.ts` and its test removed; the
  sidebar "Tanya" entry is now a link). Suggested-question chips, a chat form action that works without JavaScript,
  "Percakapan baru", disclaimer line, pending/error/unavailable states. Unavailable when the AI Gateway ids
  (`AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`) or the user's own Anthropic key (FN-41) is missing, with a link to
  `/pengaturan/integrasi`.
- Server `src/lib/server/tanya/`: one Messages call per round built on the FN-15/FN-41 Anthropic plumbing
  (`TANYA_MODEL = RECEIPT_MODEL`), a tool-use loop (max 4 rounds, 30 s per call, 55 s per question), 8 read-only tools
  over a read-only DB facade (allowlist) with the space id from the session, reusing the existing aggregates. Figures
  reach the page only as server-formatted `[[f:id]]` placeholders with random ids; an allowlist answer guard drops
  model prose to figure cards when it carries any unverified money-like text.
- Limits: 30 questions per 10 minutes per user (`tanya-ask` throttle), one in flight per user (`src/lib/server/lane.ts`,
  now shared with receipts), 500-character questions, 6 history turns.
- Retention: messages expire after 30 days (filtered on read, lazily purged); `/pengaturan/ingatan` ("Ingatan
  asisten") deletes them. Account delete and the data export (unexpired own rows) cover the table.
- Migration `0030_tanya_messages.sql` (new table only). The parallel FN-19 branch may also claim 0030: whichever
  merges second renumbers it and fixes the journal idx and snapshot.
- Tests: answer guard (incl. a seeded 20,000-run Unicode insertion test and QA false-positive cases), anthropic, loop
  (MOCKED), tools, lane, shared/tanya, `scripts/compat-tanya.test.ts`, `test/integration/tanya.test.ts` (27),
  `e2e/tanya.spec.ts` (5); `npm run compat:tanya` for an owner-run real-provider check.
- QA PASS (cycle 4); red team PASS (cycle 3). Fix cycles: (1) S1 zero-width bypass of the guard plus lows S2–S6;
  (2) S8 invisible-mark bypass, guard rewritten as an allowlist; (3) a load-sensitive concurrency test (test-only).
  Open lows (red team cycle 3): S11 look-alike letters for digits next to a figure (`[[f:ID]].OOO`), S12 a figure
  re-signed or scaled by words or brackets (`minus [[f:ID]]`, `[[f:ID]] x 10`), S13 an amount split across lines,
  S14 standalone years/times/slang. Earlier accepted: S7 injected merchant text can steer prose (plain text only) and
  cost on the user's own key. Removed-member chat rows stay in the shared space until deleted (follow-up).
- Owner decisions (defaults used): plain tool loop in the app Worker with history in D1, no Agents SDK / Durable
  Object this pass (deviation from CLAUDE.md; adapter-cloudflare emits only a default export); gateway AND own key
  required; free, no credit debit, tokens recorded per message; non-streaming; one conversation per user and space;
  plaintext chat rows in D1.
- Not verified: any real Anthropic call (`compat:tanya` not run, no key here); the `thinking: {type: 'between_tools'}`
  request field is checked against the API reference only; browser happy path, asking and clearing in a browser (no
  stub backend); the jobs-worker retention sweep is not built.
