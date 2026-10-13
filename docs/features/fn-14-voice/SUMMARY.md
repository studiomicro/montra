# FN-14 Voice and quick text entry (Suara) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted). AI double-check and Whisper fallback out of
scope (Anthropic key on hold) — the AI control shows "Belum dikonfigurasi".

- **Built:** `/riwayat/suara` — Web Speech API (`id-ID`) with progressive enhancement; typed sentence entry everywhere
  incl. no-JS; one sentence → several rows via the shared money parser (slang, number words, `cleanMoneyText`
  positions); keyword category guess confirmed by the user; review with native selects; atomic save through FN-05's
  `insertTransactions` with `source='voice'` and a per-submission dedupe key (resubmission 409); "Catat lagi" and
  "Urungkan"; Tambah "Suara" row and Beranda Suara pill enabled; mic auto-start only after in-app navigation; disclosure
  that browser speech may go to the browser maker (Suara screen + `/privasi` draft); e2e `suara.spec.ts` with a fake
  `SpeechRecognition`.
- **QA:** PASS 35/35. **Red team:** PASS; Lows (demo row copy, cross-site mic auto-start, disclosure) fixed in cycle 2.
- **Not verified:** a real microphone and real Chrome recognition output; guest/local-first half of the ACCEPTANCE
  journey (FN-02 deferred).
