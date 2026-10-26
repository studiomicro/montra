# Montra for Android (FN-58)

A Capacitor 8 shell that loads the Montra web app from its own host, plus a read-only NFC bridge for e-money cards
(`android/app/src/main/java/id/montra/app/MontraNfcPlugin.java`). Every issuer's reading logic lives in the web app
(`src/lib/shared/emoney`), so a reader is fixed or added with a web deploy; the bridge only connects to the tapped card
and refuses any command that is not a read (ISO 7816-4 SELECT, READ BINARY, READ RECORD, GET DATA, GET RESPONSE,
only as a well-formed short APDU with an inter-industry class byte; FeliCa Polling, Request Service, Request Response,
Read Without Encryption, Request System Code, with a correct length byte). The web app applies the same rule before it
sends; both guards run against `src/lib/shared/emoney/read-only-vectors.txt`.

The bridge never reports the card's UID, only its length. A FeliCa card's IDm (its UID) is part of every Polling answer,
so the page does see it; Diagnosa kartu keeps only its last 2 bytes in the log, and long digit runs only their last 4.

## Test the guard

```sh
cd native/android-app/android
JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew testDebugUnitTest --rerun
```

`--rerun` matters: Gradle does not know the vector file is a test input, so without it a changed vector can leave the
task "up to date" and untested.

The web side runs in `npx vitest run src/lib/shared/emoney`.

## Build a debug APK

Needs JDK 21 (`brew install openjdk@21`) and the Android SDK (`~/Library/Android/sdk`, written to
`android/local.properties` as `sdk.dir=...`, which is git-ignored).

```sh
cd native/android-app
npm install
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
MONTRA_APP_URL=https://<staging host> npm run build:debug
# android/app/build/outputs/apk/debug/app-debug.apk
```

Install it on an Android phone with NFC (`adb install`, or copy the APK and allow the install). Then sign in and
open Dompet › Diagnosa kartu (`/dompet/diagnosa-kartu`), tap a card, and send the copied log.

## Status

- KMT (KAI Commuter, FeliCa): balance reader written from public sources, not yet checked on a real card.
- Mandiri e-Money, Flazz, Brizzi, TapCash, JakCard, MegaCash: not read yet; see
  `docs/features/fn-58-emoney/RESEARCH.md` for why (provenance, keys, no public source).
- No release signing, no Play Store listing, no iPhone app yet.
