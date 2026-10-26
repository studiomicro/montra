# FN-54 Greeting hero, calendar, daily greeting and feature icons — SUMMARY

Status: **complete** (2026-10-13), two cycles.

Goal (PRD): a warmer Beranda and quicker way around the app, mirroring the reference app's behaviour but never its
brand (Koko, Montra's own illustration style and words).

- Part A: every nav and feature item has its own icon on a coloured chip (category hues, AA in every theme); a
  "Fitur" tile grid on Beranda; placement in the sidebar and Jelajahi fitur.
- Part B: greeting hero by WIB time (pagi 04:00, siang 11:00, sore 15:00, malam 18:00), today's state,
  vs-last-month and budget-left chips from stored rows, a new illustrated scene in Montra's style (light, dark, mono;
  never cropped), an ask field that only prefills Tanya (the question leaves the URL after hydration; a note says
  nothing has been sent).
- Part C: `/kalender` from the header date badge: daily spending equal to Riwayat, closed days, bill and recurring
  marks; hidden amounts from the first render; Struk and Suara beside the badge on desktop.
- Part D: a once-a-day sheet from the user's own figures with an off switch in Pengaturan › Tampilan (device
  cookies); the "on this day" file ships empty with a validator (https sources only) and a review log.
- Migration: none. The home-screen icon waits for the owner's logo file.
- QA: FAIL cycle 1 (/kalender ignored hidden amounts; hero crop; two lows), PASS cycle 2. Red team: PASS cycles 1–2.
- Not verified: real-device checks, a screen-reader pass, staging.
