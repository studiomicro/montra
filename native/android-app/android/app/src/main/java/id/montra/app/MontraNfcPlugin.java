package id.montra.app;

import android.app.Activity;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.IsoDep;
import android.nfc.tech.NfcA;
import android.nfc.tech.NfcF;
import android.nfc.tech.TagTechnology;
import android.os.Bundle;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * FN-58: the read-only NFC bridge for e-money cards. The web app (src/lib/shared/emoney) holds every issuer's reading
 * logic and sends commands one at a time through {@link #transceive}; this class only connects to the tapped card and
 * refuses any command {@link #isReadOnlyCommand} does not pass, so a page can never write to, top up or debit a card.
 * Never sent to the page: the card's UID (only its length) and nothing is stored on the device.
 *
 * <p>Threads: plugin methods run on Capacitor's plugin thread, {@link #onTag} on the NFC reader thread, and the
 * lifecycle hooks on the main thread. The connected tag lives in {@link #isoDep} / {@link #nfcF}, which are only read
 * or replaced under {@link #tagLock}; a blocking transceive runs outside the lock on its own snapshot, so closing the
 * tag from another thread makes it fail with "tag_lost" instead of blocking that thread.
 */
@CapacitorPlugin(name = "MontraNfc")
public class MontraNfcPlugin extends Plugin {

    /**
     * ISO 7816-4 instructions that only read: SELECT, READ BINARY, READ RECORD, GET DATA, GET RESPONSE. Same list as
     * READ_ONLY_INS in src/lib/shared/emoney/commands.ts (a test compares them). An issuer's own read instruction joins
     * this list only after its public source and a real-card log are reviewed (FN-58).
     */
    private static final Set<Integer> READ_ONLY_INS = new HashSet<>(Arrays.asList(0xA4, 0xB0, 0xB2, 0xCA, 0xC0));

    /**
     * FeliCa command codes that only read: Polling, Request Service, Request Response, Read Without Encryption, Request
     * System Code. Same list as READ_ONLY_FELICA in commands.ts.
     */
    private static final Set<Integer> READ_ONLY_FELICA = new HashSet<>(Arrays.asList(0x00, 0x02, 0x04, 0x06, 0x0C));

    private static final int TIMEOUT_MS = 2000;

    private final Object tagLock = new Object();
    /** The connected card, at most one of the two; guarded by {@link #tagLock}. */
    private IsoDep isoDep;
    private NfcF nfcF;
    /** The page asked for cards (startReading) and has not stopped; read on the NFC and main threads. */
    private volatile boolean reading;

    /**
     * The read-only guard, kept identical to isReadOnly in src/lib/shared/emoney/commands.ts; both are run against
     * src/lib/shared/emoney/read-only-vectors.txt. "nfcf": a FeliCa frame whose length byte equals its length and whose
     * command code is a read. "isodep": a well-formed short APDU (ISO 7816-3 cases 1–4, no extended length) with an
     * inter-industry class (ISO 7816-4: {@code 000x xxxx} or {@code 01xx xxxx}; under a proprietary class the same INS
     * may write or debit) and a read-only INS. Any other tech is refused.
     */
    static boolean isReadOnlyCommand(String tech, byte[] command) {
        int length = command.length;
        if ("nfcf".equals(tech)) {
            return length >= 2 && (command[0] & 0xFF) == length && READ_ONLY_FELICA.contains(command[1] & 0xFF);
        }
        if (!"isodep".equals(tech) || length < 4) return false;
        int cla = command[0] & 0xFF;
        boolean interIndustry = (cla & 0xE0) == 0x00 || (cla & 0xC0) == 0x40;
        if (!interIndustry || !READ_ONLY_INS.contains(command[1] & 0xFF)) return false;
        if (length == 4 || length == 5) return true;
        int lc = command[4] & 0xFF;
        return lc > 0 && (length == 5 + lc || length == 6 + lc);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(getContext());
        JSObject result = new JSObject();
        result.put("available", adapter != null);
        result.put("enabled", adapter != null && adapter.isEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void startReading(PluginCall call) {
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(getContext());
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("NFC is off or missing", "nfc_unavailable");
            return;
        }
        reading = true;
        enable(adapter);
        call.resolve();
    }

    @PluginMethod
    public void stopReading(PluginCall call) {
        reading = false;
        disable();
        closeTag();
        call.resolve();
    }

    /** Sends one command to the connected card. `tech` is "isodep" (an APDU) or "nfcf" (a FeliCa frame, length byte first). */
    @PluginMethod
    public void transceive(PluginCall call) {
        String tech = call.getString("tech", "isodep");
        byte[] command;
        try {
            command = fromHex(call.getString("hex", ""));
        } catch (IllegalArgumentException e) {
            call.reject("Command is not hex", "bad_command");
            return;
        }
        if (!"isodep".equals(tech) && !"nfcf".equals(tech)) {
            call.reject("Unknown card tech", "bad_command");
            return;
        }
        if (!isReadOnlyCommand(tech, command)) {
            call.reject("Only read commands are allowed", "not_read_only");
            return;
        }
        TagTechnology connected;
        synchronized (tagLock) {
            connected = "nfcf".equals(tech) ? nfcF : isoDep;
        }
        if (connected == null) {
            call.reject("nfcf".equals(tech) ? "No FeliCa card connected" : "No ISO-DEP card connected", "no_card");
            return;
        }
        try {
            byte[] response = connected instanceof NfcF
                ? ((NfcF) connected).transceive(command)
                : ((IsoDep) connected).transceive(command);
            resolveHex(call, response);
        } catch (IOException | IllegalStateException | SecurityException e) {
            // IOException: the card left or timed out. IllegalStateException: another thread closed this tag first.
            // SecurityException: Android refuses a tag object that a newer tap has replaced.
            closeTagIf(connected);
            call.reject("The card moved away", "tag_lost");
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(getContext());
        if (reading && adapter != null && adapter.isEnabled()) enable(adapter);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        // Reader mode only works while the activity is in front; `reading` stays, so onResume turns it back on.
        disable();
        closeTag();
    }

    private void enable(NfcAdapter adapter) {
        Activity activity = getActivity();
        if (activity == null) return;
        int flags = NfcAdapter.FLAG_READER_NFC_A
            | NfcAdapter.FLAG_READER_NFC_B
            | NfcAdapter.FLAG_READER_NFC_F
            | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK;
        Bundle extras = new Bundle();
        extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);
        adapter.enableReaderMode(activity, this::onTag, flags, extras);
    }

    private void disable() {
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(getContext());
        Activity activity = getActivity();
        if (adapter != null && activity != null) adapter.disableReaderMode(activity);
    }

    /** Runs on the NFC reader thread for each tapped card. */
    private void onTag(Tag tag) {
        // A new tap replaces the old card: release it first (its Tag object is stale now anyway).
        closeTag();
        JSObject info = new JSObject();
        JSArray techs = new JSArray();
        for (String t : tag.getTechList()) techs.put(t.substring(t.lastIndexOf('.') + 1));
        info.put("techs", techs);
        info.put("uidLength", tag.getId() == null ? 0 : tag.getId().length);
        NfcA a = NfcA.get(tag);
        if (a != null) {
            info.put("atqa", toHex(a.getAtqa()));
            info.put("sak", a.getSak());
        }
        // Connect outside the lock (it talks to the card), then publish the connection under it.
        IsoDep dep = IsoDep.get(tag);
        NfcF f = dep == null ? NfcF.get(tag) : null;
        TagTechnology connected = null;
        try {
            if (dep != null) {
                dep.connect();
                dep.setTimeout(TIMEOUT_MS);
                connected = dep;
                if (dep.getHistoricalBytes() != null) info.put("historicalBytes", toHex(dep.getHistoricalBytes()));
                if (dep.getHiLayerResponse() != null) info.put("hiLayerResponse", toHex(dep.getHiLayerResponse()));
            } else if (f != null) {
                f.connect();
                f.setTimeout(TIMEOUT_MS);
                connected = f;
                info.put("systemCode", toHex(f.getSystemCode()));
                info.put("manufacturer", toHex(f.getManufacturer()));
            }
        } catch (IOException | IllegalStateException | SecurityException e) {
            close(dep != null ? dep : f);
            connected = null;
            info.put("error", "connect_failed");
        }
        synchronized (tagLock) {
            if (!reading) {
                // stopReading came first: drop this card instead of keeping a connection nobody will close.
                close(connected);
                return;
            }
            closeTagLocked(); // Reader callbacks come one at a time, so this only guards against a stray connection.
            if (connected instanceof IsoDep) isoDep = (IsoDep) connected;
            else if (connected instanceof NfcF) nfcF = (NfcF) connected;
        }
        notifyListeners("card", info);
    }

    private void closeTag() {
        synchronized (tagLock) {
            closeTagLocked();
        }
    }

    /** Closes `tech` only if it is still the connected card, so a failure on an old tap never drops a newer one. */
    private void closeTagIf(TagTechnology tech) {
        synchronized (tagLock) {
            if (tech != isoDep && tech != nfcF) return;
            closeTagLocked();
        }
    }

    private void closeTagLocked() {
        close(isoDep);
        close(nfcF);
        isoDep = null;
        nfcF = null;
    }

    private static void close(TagTechnology tech) {
        if (tech == null) return;
        try {
            tech.close();
        } catch (IOException | RuntimeException ignored) {
            // The card is gone; nothing to release.
        }
    }

    private static void resolveHex(PluginCall call, byte[] response) {
        JSObject result = new JSObject();
        result.put("hex", toHex(response));
        call.resolve(result);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02X", b & 0xFF));
        return out.toString();
    }

    /** Whole bytes of hex, whitespace ignored; anything else (including an empty string) throws. */
    static byte[] fromHex(String hex) {
        String clean = hex.replaceAll("\\s", "");
        if (clean.isEmpty() || clean.length() % 2 != 0 || !clean.matches("[0-9a-fA-F]+")) {
            throw new IllegalArgumentException("not hex");
        }
        byte[] out = new byte[clean.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        return out;
    }
}
