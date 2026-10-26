# Indonesian e-money cards: public sources for read-only NFC balance reading

Research date: 2026-10-26. Read-only research. No code was changed in any repo.
Third-party repos were shallow-cloned into
`/private<scratchpad>`
for reading only.

## 0. Headline findings

1. **KMT (KAI Commuter) is the only card with a high-quality, clearly clean public source.**
   Metrodroid (GPL-3.0) decodes it with plain FeliCa Read Without Encryption. The service
   attributes say the data is readable without a key.
2. **Mandiri e-Money: medium confidence.** The same 3 APDUs (`SELECT 0000000000000001`,
   `00 B5 00 00 0A` balance, `00 B3 00 00 3F` card number) appear in several independent hobby
   repos from 2023 to 2026. None of those repos explains where the bytes came from. The oldest copy
   that has a licence (agusibrahim/prepaidcard_reader, MIT) is **plainly decompiled from a
   commercial app**. No reading key is needed.
3. **TapCash: medium-low.** The only public command source is osp-kue-reader. Its commands are the
   **CEPAS** (Singapore SS 518) purse read, `90 32 03 00 00`, which Metrodroid also uses for
   EZ-Link. No public source says TapCash is CEPAS. The candidate AIDs disagree between sources,
   and the Proxmark AIDs come from a decompiled app.
4. **Flazz Gen 2: low, and provenance is tainted.** Every public trail leads back to decompiling
   BCA's app. The 2015 sybond blog says so outright. osp-kue-reader's Flazz code has
   obfuscated-looking variable names (`uuuu`, `bbbb`, `dddd`, `cccc`). **Flazz Gen 1 is NOT
   FEASIBLE**: every source says it needs a key or SAM.
5. **Brizzi: treat as NOT FEASIBLE** unless a real-card log shows an unauthenticated read
   succeeding. One public repo (dwierwink/scannertest, no licence) reads the balance only after
   DESFire 3DES authentication with a **hard-coded leaked master key**. Never use or copy that
   repo. osp-kue-reader claims an unauthenticated DESFire GetValue works, but only synthetic test
   fixtures back that claim.
6. **JakCard / JakLingko (Bank DKI): low.** Sources give two different AIDs. The balance command
   comes from one source only (osp-kue-reader). There is no public transaction-log format.
7. **MegaCash (Bank Mega): nothing public.** No AID, no command, no repo. A 2019 consumer article
   only says some third-party reader apps listed MegaCash.
8. **None of the open-source repos ships real-card APDU logs.** osp-kue-reader's tests use
   synthetic fixtures only. Every non-KMT format below must be confirmed on a real card before
   we trust it.
9. Most "open-source" repos for these cards are **days to weeks old (Sep–Oct 2026)**, look
   AI-generated, and copy from each other. Their confidence comes from repetition, not
   independence.

## 1. Source register (provenance and licence)

| # | Source | Author / date | Licence | Provenance flags |
|---|---|---|---|---|
| S1 | https://github.com/metrodroid/metrodroid (`transit/kmt/KMTTransitData.kt`, `KMTTrip.kt`; `card/cepas/*`; `transit/ezlink/CEPASPurse.kt`, `CEPASTransaction.kt`) | KMT by Bondan Sumbodo (2018); CEPAS by Sean Cross 2011, Eric Butler 2013-14, Michael Farrell 2018. HEAD b910c18, 2026-10-02 | **GPL-3.0-or-later** (file headers). Can be combined with AGPL-3.0 under GPLv3 §13 | Established project, about 10 years old. Clean. |
| S2 | https://github.com/metrodroid/metrodroid/wiki/FeliCa | Metrodroid wiki | wiki text | Lists KMT system code 0x90B7 |
| S3 | Sony "FeliCa Card User's Manual Excerpted Edition" (public), https://www.sony.co.jp/en/Products/felica/business/tech-support/ | Sony, v2.31 | Public spec document (not code) | Authoritative for the FeliCa command frames (Polling 0x00, Read Without Encryption 0x06) and service-attribute meaning |
| S4 | https://github.com/muhakmal/osp-kue-reader | Akmal M. (@muhakmal), created 2026-10-16, 4 commits | **Apache-2.0** (can be used one-way in AGPL-3.0) | 10 days old, 1 star, has an AGENTS.md (AI-assisted). Tests use synthetic fixtures only. Flazz code variable names (`cmdUuuu`, `cmdBbbb`, `cmdDddd`, `cmdCccc`, `cmdFlh4`) look copied from obfuscated or decompiled code. It powers the author's own commercial Play Store app "Pembaca KUE". Its KMT parser reads Suica service 0x090F, which is **wrong for KMT** (see S1). |
| S5 | https://github.com/dwierwink/scannertest | ErwinDwiK, 2026-10-16 → 10-24 | **None** (all rights reserved) | Says it copies from S4 and S6. `src/services/brizziAuth.js` **hard-codes a Brizzi DESFire master key** (leaked key). Do not use, do not copy, do not cite as a command source. |
| S6 | https://github.com/agusibrahim/prepaidcard_reader | Agus Ibrahim, 2025-08-08 | MIT on paper | **Plainly decompiled from a commercial app**: packages `a/a.java…a/j.java`, `utils/FmssRequestEncryptor`, `CastleCrypt`, `SBFExceptionHandler`, `Appirater`, and signed-byte decompiler arrays (`{ 0, -92, 4, 0, 8, ... }`). The MIT label cannot be valid for decompiled third-party code. Do not use. |
| S7 | https://github.com/felixtandian/emoneyReader (`lib/emoneyUtils.dart`) | felixtandian, 2023-05-10 | **None** | Hobby Flutter code, Mandiri only. Origin of the bytes not stated. |
| S8 | https://github.com/agusibrahim/emoney_reader_demo (`src/main.cpp`) | Agus Ibrahim, 2026-04-03 | README shows an MIT badge but there is **no LICENSE file** | ESP32 + PN532, Mandiri only. Same author as S6, so it may inherit S6's origin. |
| S9 | https://github.com/rukys/emoneychecker | Ruky Sektiawan, 2026-09-17/30 | README shows an MIT badge but there is **no LICENSE file** (GitHub reports none) | Several of its AIDs look guessed: `D2760000850101` is the NFC Forum NDEF AID, `A0000000030000` is the Visa card-manager AID. Low value. |
| S10 | https://github.com/RfidResearchGroup/proxmark3 `client/resources/aidlist.json` | entries added by kormax, 2026 | GPL-3.0 | The Indonesian AID entries are tagged `"Sources": ["android://com.jaklingkoindonesia.app"]`, so they were **extracted from the JakLingko app**. Flag as decompiled-app-derived. |
| S11 | https://sybond.web.id/blog/2015/10/03/hack-kartu-flazz-bca/ "Membedah Kartu Flazz BCA" | Bondan Sumbodo (sybond), 2015-10-03 | No licence (blog) | **The author states he decrypted and analysed BCA's app dex**, so this is derived from decompilation. It gives one decoded Flazz log record. |
| S12 | https://sybond.web.id/blog/2015/02/27/e-money-hack/ | sybond, 2015-02-27 | blog | Analysis of the Mandiri top-up app flow. No usable read commands. Derived from the app. |
| S13 | https://github.com/haonlabs/CheckSaldo | Haon, 2025-03-05 | None | Mandiri only. Commit note: "jaklingko mandiri belum bisa". Not inspected in depth. |
| S14 | https://parkirsoftware.com/mengapa-tidak-ada-reader-umum-yang-bisa-membaca-saldo-dan-nomor-kartu-e-tol-indonesia/ | "Redaksi", 2025-12-14 | blog | Vendor blog. Claims BI and the banks "melarang akses terbuka" (forbid open access) but cites no regulation. |

Not usable: `saucedbeacon/bongkardana` turned up in GitHub code search for the Mandiri SELECT
bytes. It is a decompiled DANA app (commercial), so ignore it.

## 2. Per-card findings

### 2.1 KMT — Kartu Multi Trip (KAI Commuter)

- **Tech:** FeliCa (JIS X 6319-4), Android `NfcF`. KCI moved to Sony FeliCa in 2015
  (Sony case study https://www.sony.co.jp/en/Products/felica/casestudy/article/kci.html). Per the
  FareBot/Metrodroid listing, only the newer FeliCa cards are readable.
- **Identify:** FeliCa **system code `0x90B7`** (S1 `SYSTEMCODE_KMT = 0x90b7`; S2).
- **Services (S1):**
  - `0x300B` = card ID, block 0. ASCII if printable, else hex. Attribute 0x0B means random service, read-only, no key (S3).
  - `0x1017` = balance, block 0. Attribute 0x17 means purse service, read-only, no key (S3).
  - `0x200F` = history. Attribute 0x0F means cyclic service, read-only, no key (S3).
- **Command (S3 frame format, used by S1's reader):**
  1. Polling (cmd `0x00`) with system code `90 B7` gets the IDm for that system.
  2. Read Without Encryption (cmd `0x06`): `[len] 06 [IDm 8] 01 [service code LE: 17 10] [n blocks] 80 00 …`.
     On Android, `NfcF.transceive` takes the frame including the leading length byte.
- **Balance block 0 of 0x1017 (S1):**
  - balance = bytes 0..3, **little-endian** (`byteArrayToIntReversed(0,4)`), in rupiah (`TransitCurrency.IDR`)
  - last transaction amount = bytes 4..7, LE
  - transaction counter = bytes 13..15, big-endian
- **History block of 0x200F (S1 `KMTTrip.parse`):**
  - timestamp = bytes 0..3, BE, seconds since 2000-01-01 Jakarta time. Before 2019 there is a −6 h epoch quirk; Metrodroid itself marks the switch point as a guess (PR #522).
  - amount = bytes 4..7, BE
  - gate/station code = bytes 8..9, BE
  - process type = byte 12 (0 ticket machine, 1 train, 2 POS)
  - sequence = bytes 13..15
  - Skip a block when byte 0 == 0 or the gate code == 0.
- **Keys:** none (the attribute codes say no-key read-only).
- **Licence note:** S1 is GPL-3.0. Write our own code; using it as a reference is fine.
- **Confidence: HIGH** for the system and service codes and the balance offset. **MEDIUM** for
  the history field meanings and the timestamp epoch.
- **Real-card log must confirm:**
  - Polling `90B7` answers.
  - `0x1017` block 0 bytes 0..3 LE equal the balance shown at the station or in the KAI Access app.
  - The history timestamps make sense with the 2000-epoch rule.

### 2.2 Mandiri e-Money

- **Tech:** ISO 14443-4, Android `IsoDep` (all sources). Chip family is not publicly documented.
  S10 says `"mifare_plus"`, sourced from a decompiled app.
- **Identify:** `SELECT` AID `00 00 00 00 00 00 00 01`:
  `00 A4 04 00 08 00 00 00 00 00 00 00 01` (S7, S8, S4; S6 too, but it is decompiled).
  S4 first tries `A0 00 00 00 18 30 00 01`, but no other source has that AID.
- **Balance:** `00 B5 00 00 0A`. Response bytes 0..3 = balance, **little-endian**, in rupiah,
  then SW `90 00`.
  - S7 reverses the first 4 bytes. S8 does the same.
  - S4 (fallback path) reads it little-endian too, and its fixture `50C30000` = 50,000.
- **Card number:** `00 B3 00 00 3F`. The first 8 bytes (16 hex digits) are the card number
  (S7, S8). S7 also sends `00 F2 10 00 0B` "card attribute" but never decodes it, so skip it.
- **Alternative balance path (S4 only):** `00 B2 01 04 00` (READ RECORD 1, P2=04).
  S4 takes bytes 12..15 as big-endian.
  - No other source has this. Its fixture is synthetic.
  - P2=0x04 means "record 1 of the current EF", not "SFI 4" as S4's comment claims.
  - Confidence: LOW.
- **Transaction log (S4 only):**
  - Command `00 D1 <i> 00 00` for i = 0..31, with 24-byte records.
  - Fields: date DDMMYY and time HHMMSS (BCD-like), terminal ID bytes 7..13, type at hex offset 28..31 (`0100` = top-up), amount bytes 16..19 LE.
  - The fallback is a legacy `00 B2 <i> 00 00` layout.
  - Single source, synthetic fixtures. Confidence: **LOW**.
  - Context: Bank Mandiri on X says newer cards keep up to 20 history entries (https://x.com/bankmandiri/status/1892866550161690684).
- **Keys:** none for balance or number in any source.
- **Provenance warning:**
  - The oldest licensed copy (S6) is decompiled.
  - S7 and S8 do not say where the bytes came from.
  - No primary write-up (paper, blog with a derivation) was found. The 2015 sybond Mandiri post (S12) does not give read commands.
  - The owner should decide whether "widely repeated in hobby repos" is acceptable provenance.
- **Confidence:** **MEDIUM** for SELECT + `00B5` + LE balance (3 independent-looking repos agree).
  **LOW** for the history.
- **Real-card log must confirm:**
  - The SELECT returns `90 00`.
  - The `00B5` response is ≥ 4 bytes + `9000`, and its LE value matches the Livin'/ATM balance.
  - The 8-byte `00B3` prefix matches the 16-digit number printed on the card.
  - Whether `00 D1` returns records at all.

### 2.3 BNI TapCash

- **Tech:** ISO 14443-4 `IsoDep` (S4, S9). S4 implies a CEPAS-style application. CEPAS is
  ISO 14443-B in Singapore, and Metrodroid notes that some Android devices cannot detect
  CEPAS / 14443-B cards (https://github.com/metrodroid/metrodroid README). For TapCash, check
  NfcB vs NfcA in the real log.
- **Identify (conflicting):**
  - S4: `SELECT` AID `11 22 33 44 55 66` → `00 A4 04 00 06 11 22 33 44 55 66 00`.
  - S9 and S10: AIDs `A0 00 42 4E 49 10 00 01` and `A0 00 42 4E 49 99 99 99`. `42 4E 49` is ASCII "BNI". S10 got them from the JakLingko app, so they are decompiled-derived.
  - Metrodroid's CEPAS reader selects file `0x4000` (`00 A4 00 00 02 40 00`) instead of an AID (S1 `CEPASApplication.dumpTag`).
- **Balance:** `90 32 03 00 00` (S4). This is exactly the CEPAS "read purse" command,
  `CLA 90, INS 32, P1 = purse id` (S1 `CEPASProtocol.getPurse`).
  - S4: balance = response bytes 2..4, 24-bit big-endian, in rupiah.
  - This matches the CEPAS purse layout in S1 `CEPASPurse.purseBalance` = bits 16..39 (bytes 2..4), signed 24-bit.
  - The CEPAS purse also holds the CAN at bytes 8..15 and the CSN at bytes 16..23 (S1). These could serve as the card number, but that is **unconfirmed** for TapCash.
- **Transaction log:**
  - S4 sends `90 32 01 00 01 <i> 00` for i = 1..10 and expects 16-byte records.
  - Record layout = CEPAS transaction (S1 `CEPASTransaction`): type byte 0; amount bytes 1..3, signed 24-bit BE; time bytes 4..7 = seconds since 1995-01-01 (CEPAS/SGT epoch); 8 bytes user data.
  - S4 uses P1=01 for history but P1=03 for the purse. That is inconsistent with Metrodroid, which uses the same purse id for both: `90 32 <purse> 00 01 00`, then a second call with Le = count.
  - Confidence: LOW.
- **Keys:** none in any source (the CEPAS purse read is unauthenticated).
- **Confidence:** **MEDIUM-LOW**. The command is a public-standard CEPAS command, but no public
  source links TapCash to CEPAS. The source for AID `112233445566` is unknown.
- **Real-card log must confirm:**
  - Which identification works (AID `112233445566`, the BNI AIDs, or file `4000`).
  - That `90 32 03 00 00` returns `9000` and bytes 2..4 equal the BNI app balance.
  - Whether the epoch is 1995.

### 2.4 BCA Flazz

- **Gen 1:**
  - S9 says Gen 1 is MIFARE Classic (Crypto-1).
  - S4 says it is IsoDep with AID `A0 00 00 00 03 86 98 07 01`, balance "requires proprietary bank SAM".
  - **NOT FEASIBLE** (key or SAM needed, and the sources disagree on the tech).
- **Gen 2 (S4 only for commands; S10 confirms the AID, S10 got it from the JakLingko app):**
  1. `00 A4 04 00 0B A0 00 00 00 18 0F 00 00 01 80 01 00` (SELECT AID).
  2. `00 A4 01 00 02 02 00` (select file 0200).
  3. `00 B0 81 00 8E` (READ BINARY with SFI 1, 0x8E bytes). S4 uses response byte 3 == 00 as its "Gen 2" test.
  4. Balance: `80 32 00 03 04 00 00 00 00` (proprietary CLA 80). Balance = response bytes 1..3, 24-bit BE, in rupiah.
- **History (S4):**
  - First `00 00 40 0B 00 00 04 02 00 00`. This is a non-standard command with CLA 00 INS 00. Do **not** send it: its effect is unknown and it may not be read-only.
  - Then `00 B0 84 <off> 3C` / `00 B0 85 <off> 3C` (READ BINARY SFI 4/5).
  - 60-byte records: type bytes 0..1 (`0400` = payment); amount bytes 6..8 BE; terminal bytes 30..37 ASCII; time bytes 38..41 = Unix seconds.
  - This partly agrees with the one record in S11: `04 00 | 00 17 cc | ff | 00 0d ac …`. S11 decodes balance-after = `0017cc` (Rp 6,092) and amount = `000dac` (Rp 3,500), both BE. S11 could not decode the date.
- **Keys:** S4 says none for Gen 2 reads.
- **Provenance: TAINTED.**
  - S11 openly decompiled BCA's app.
  - S4's Flazz code style suggests it was copied from obfuscated code.
  - S10's AID came from the JakLingko app.
  - No clean public source exists.
  - Under the owner's rule ("never from any app's decompiled bundle"), Flazz probably needs an owner decision before implementation.
- **Confidence: LOW.**
- **Real-card log must confirm:** each step returns `9000`; bytes 1..3 of the `8032` response
  match the BCA mobile / ATM balance; Gen 1 vs Gen 2 tech list.

### 2.5 BRI Brizzi

- **Tech:** MIFARE DESFire (EV1), wrapped native commands over IsoDep (S4, S5). There is no
  official BRI statement on the chip.
- **Identify:** DESFire SelectApplication AID `0x000001`: `90 5A 00 00 03 01 00 00 00` → SW
  `91 00` (S4, S5). This is the standard NXP DESFire wrapped-command format.
  S9's ISO AIDs (`D2760000850101`, `A0000000030000`) are wrong or generic. Ignore them.
- **Balance (S4):** DESFire GetValue file 0: `90 6C 00 00 01 00 00`. Bytes 0..3 = LE value,
  SW `91 00`.
- **Log (S4):** DESFire ReadRecords `90 BB 00 00 07 01 00 00 00 00 00 00 00` + `90 AF 00 00 00`
  chaining. 32-byte records.
- **Keys:**
  - S5's history says GetValue returned nothing useful until it added 3DES authentication. Its commit is "fix(brizzi): fix 0 balance by executing 3DES session auth".
  - S5 does that authentication with a **leaked, hard-coded master key**.
  - S4's own test also models the `91 AE` (authentication error) case.
  - If GetValue needs authentication on real cards, Brizzi is **NOT FEASIBLE**.
  - A safe, key-free probe is possible: send unauthenticated `90 6C …` once. On `91 AE`, show "Brizzi not supported".
- **Confidence: LOW**, and likely NOT FEASIBLE.
- **Real-card log must confirm:** the SW of unauthenticated GetValue (`9100` vs `91AE`).

### 2.6 JakCard / JakLingko (Bank DKI)

- **Tech:** IsoDep (S4).
- **Identify (conflicting):**
  - S4: `00 A4 04 00 0E 31 54 49 43 2E 49 43 41 53 48 30 31 01 01 00`. The AID is ASCII "1TIC.ICASH01" + `01 01`.
  - S10: AID `A0 00 00 05 71 4E 4A 43`, extracted from the JakLingko app.
- **Balance (S4 only):** `90 4C 00 00 04`. Bytes 0..3 BE, SW `90 00`.
- **Log:** none public.
- **JakLingko cards:** JakLingko-branded cards are also issued by other banks, e.g. Mandiri JakLingko; S13 says Mandiri JakLingko did not work. Detect the issuer applet; do not assume from branding.
- **Keys:** none stated.
- **Confidence: LOW** (single source, no fixtures from a real card).
- **Real-card log must confirm:** which AID selects; the `904C` response and how its value relates
  to the JakOne Mobile balance.

### 2.7 MegaCash (Bank Mega)

- **Nothing public found:** no AID, no command, no repo, no paper. It launched in 2014
  (https://keuangan.kontan.co.id/news/uang-elektronik-bank-mega-bernama-mega-cash). A 2019 article
  says some generic reader apps listed it (https://gizmologi.id/apps/cek-saldo-kartu-uang-elektronik/).
- **Status: NOT SUPPORTABLE from public sources.** At most, show "card detected, unsupported" when
  no parser matches.

## 3. Generic identification notes

- No source gives trustworthy per-card ATQA/SAK values. S8 checks only SAK `0x20/0x28/0x38` as a
  generic "ISO-DEP capable" test. Identify by tech list + SELECT/Polling response, not by UID or
  ATQA/SAK. S9's README is right on this point: never claim a brand from the UID alone.
- Suggested probe order:
  1. `NfcF` → Polling `90B7` (KMT).
  2. `IsoDep` → each SELECT in turn. Treat `6A 82` / `6D 00` as "not this card" (S7 does this).
  3. DESFire select last, because it changes card state only by selecting an application. It is still read-only.
- **Read-only:**
  - Every command listed is SELECT, READ BINARY/RECORD, a proprietary GET, or a DESFire GetValue/ReadRecords.
  - The Flazz `00 00 40 0B …` and Mandiri `00 F2 10 00 0B` commands are unexplained. Leave them out.

## 4. Licence summary

- Apache-2.0 (S4) and GPL-3.0 (S1, S10) can be combined with AGPL-3.0 if code were reused. MIT
  (S6) is not valid for decompiled code.
- No-licence repos (S5, S7, S9, S13; S8 has a badge only) give no right to copy code. Byte values
  are facts, but under the owner's provenance policy these repos should count only as
  corroboration.
- Plan stays: write our own code. Cite S1/S3 for KMT. Cite S4 + S7 + S8 for Mandiri, with the
  provenance caveat.

## 5. Legal context (not legal advice)

- E-money is governed by PBI 20/6/PBI/2018 on Uang Elektronik (cited in S4 README and Pegadaian
  articles). I did **not** find a BI provision that addresses third parties reading a card's
  balance.
- The only explicit claim that this is forbidden (S14) is an unsourced vendor blog.
- Third-party NFC balance checks are common: Tokopedia, Shopee and LinkAja do it, but they are
  issuer partners.
- From general knowledge, not verified in this session: UU ITE (UU 11/2008 jo. UU 19/2016)
  Pasal 30(3) criminalises access that "melanggar, menerobos, melampaui, atau menjebol sistem
  pengamanan" (breaches or breaks a security system). Our rule (no keys, no auth bypass, read only
  what the card serves unauthenticated) stays clear of that. Using a leaked key, as S5 does, would
  not.
- Recommend a short legal review before release, plus a trademark/non-affiliation notice like S4's.

## 6. Recommended scope for Montra v1

- **Ship:** KMT (high) and Mandiri balance + card number (medium). Gate both on real-card logs.
- **Behind a debug flag until logs confirm:** TapCash balance (CEPAS purse) and JakCard balance.
- **Owner decision needed:** Flazz Gen 2, because of tainted provenance.
- **Unsupported:** Flazz Gen 1, Brizzi (unless unauthenticated GetValue succeeds), MegaCash.
- **Collect per card:** tech list, the SELECT/Polling SW, the raw balance response, and the
  balance the issuer shows. Store hex logs in test fixtures so the parsers are tested against
  real data.
