# MONTRA — Product Requirements

Version 0.2, 2026-10-07. Feature details: `docs/FEATURES.md` (FN-00 – FN-33). Design: `docs/design/DESIGN_SYSTEM.md`.
Open work: `docs/TASKS.md`.

## 1. Problem

Indonesians pay through many channels: QRIS, bank transfer, GoPay, OVO, DANA, ShopeePay, cards and cash. Most
payments leave a trace (an e-mail receipt, a paper receipt, a statement line), but nobody types them all in. Manual
trackers are abandoned in the second week; bank apps show one account. People do not know where the month went,
what they can still spend today, or what they are worth.

## 2. Goal

A money tracker that fills itself. Capture almost every payment from what the user already receives, starting with
the most automatic path (Gmail), then answer at a glance: _How much did I spend this month compared with last? How
much can I still spend per day? What am I worth?_ Families can share one space.

**Feature scope:** the catalogue in `docs/FEATURES.md`. We match common behaviour and quality of comparable
money apps, not brand.

## 3. Users

- **QRIS-first young professional (primary):** 22–35, city, 2–4 bank and e-wallet accounts, Gmail, Android or
  iPhone; pays small and often (coffee, parking, ojek).
- **Spreadsheet switcher:** has years of records in Excel or Money Manager and wants them in.
- **Household manager:** shares a space with a partner; budgets per category.
- **Wealth tracker:** savings, stocks, crypto, gold, debt, belongings and collectibles in one net-worth number.

## 4. Success metrics (first 90 days after public launch)

- ≥ 70 % of a weekly-active user's transactions captured without typing amounts.
- Capture accuracy (amount, date, merchant, direction) ≥ 98 % for Gmail, ≥ 95 % for receipts and statements on the
  golden set.
- Voice text-to-drafts ≤ 0.5 s after speech ends; receipt ≤ 8 s; statement 10–60 s; 3,000-row sheet totals exact.
- D30 retention ≥ 25 %; free → paid conversion ≥ 3 % once billing opens.

## 5. Phases

| Phase | Features | Outcome |
| --- | --- | --- |
| 0 Foundation | FN-00 – FN-03 | App shell, design system, accounts, guest mode + sync, spaces |
| 1 Core ledger | FN-04 – FN-13 | Wallets, history, categories, budgets, Beranda, reports, goals, drafts inbox, feature toggles, installable PWA with push |
| 2 Capture | FN-14 – FN-21 | Voice, receipt, statement, spreadsheet, CSV, Gmail, merchant recognition, encrypted upload results |
| 3 Intelligence | FN-22 – FN-24 | Assistant, Agent (beta), notifications and reminders |
| 4 Wealth | FN-25 – FN-28 | Net worth, subscriptions, belongings, collectibles |
| 5 Connect, plans, trust | FN-29 – FN-32 | Sheets/Calendar/Notion/Slack, plans + credits + vouchers + billing, privacy and usage statistics, public site and legal pages |
| Later | FN-33 | Native apps |

Public launch after Phase 2 with the free plan (a common pattern: launch with paid plans "coming soon"). FN-32 (site and
legal pages) ships before public launch; billing (FN-30) before AI costs grow.

## 6. Functional summary

- **Capture paths, most automatic first:** Gmail (hourly 06–23 WIB, look-back up to 12 months with review), statement
  import (PDF incl. password, Excel, CSV, screenshots; balance check; duplicates; undo), spreadsheet import (AI maps
  layout, code copies numbers), CSV import/export (template + Money Manager; on device), receipt photo (items, tax,
  service; one or split), voice or one typed sentence (slang amounts, several drafts, AI double-check, "Catat lagi").
- **Ledger:** wallets with a favourite, transactions with full fields and source, history grouped by day, 15 editable
  categories, budgets with safe-to-spend, savings goals, drafts inbox with bulk edits.
- **Insight:** Beranda (one number, rupiah comparison, average per day, chart picker), Laporan, assistant over own
  records (free, unlimited), Agent reports (annual recap, monthly report, SPT asset list).
- **Wealth:** net worth with prices and 30-day change; subscriptions from 200+ services; belongings by photo with
  value; collectibles with market prices.
- **Sharing and sync:** guest mode on the device, account sync across devices, shared spaces of up to 5.
- **Trust:** uploads never stored and results sealed to the account key, mail text deleted after reading, no ads or
  trackers, self-hosted opt-out statistics, delete account anywhere, export any time.
- **Plans:** Free / Pro / Agent, weekly or monthly; credits for Gmail look-back; vouchers.

## 7. Non-functional requirements

- Phone first from 360 px; installable PWA; light and dark; Bahasa Indonesia default, English option.
- p75 page load ≤ 2.5 s on a mid-range Android over 4G; authenticated shell JS ≤ 150 KB gzip (lazy routes excluded).
- Offline: guest mode and signed-in use keep working offline; sync resumes when online.
- Security: hashed passwords and sessions, space isolation on every query, sealed upload results, masked account
  numbers, private R2, audit log for sharing, billing and connected apps.
- Sign-in (FN-01, FN-50): e-mail + password stays the primary credential; passkeys (WebAuthn, attestation `none`)
  are a second way in; a Cloudflare Turnstile bot check guards sign-in and sign-up when both of its keys are set.
- Privacy: UU PDP (Law 27/2022) consent and cross-border notice (Cloudflare, AI and connection partners process
  outside Indonesia; some apps run servers in Jakarta, which Cloudflare storage cannot match).
- Reliability: captures idempotent; a failed AI read leaves a reviewable draft or a clear error, never a silent loss.
- Cost: AI through AI Gateway with caching; per-plan limits and credits enforced server-side.

## 8. Out of scope

Bank APIs and open banking; reading bank apps or SMS; moving money; trading; loans or credit scoring; financial,
investment, tax or legal advice.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Gmail restricted scope (CASA assessment, partner logs holding mail content) | Owner picks partner vs own app; forwarding fallback; store only extracted fields |
| Local-first sync conflicts and data loss | Per-record last-writer-wins with tombstones, sync tests across two devices, export any time |
| Losing the password loses sealed upload results | Explain at sign-up; results are re-creatable by re-uploading; transactions themselves are not sealed |
| Bank e-mail and statement formats change | Golden set per institution, parser health alert, AI fallback |
| Prompt injection via mail, receipts, statements, Slack | Schema-validated output, read-only space-scoped assistant tools |
| AI cost per user above plan price | Credits, caching, small model for classification, upload limits on Free |
| Looking like another product | Own brand hue, logo, copy and names (design system § Source and limits) |
