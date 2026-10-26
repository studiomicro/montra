package id.montra.app;

import android.app.Activity;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.IsoDep;
import android.nfc.tech.NfcA;
import android.nfc.tech.NfcF;
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
 * refuses any command that is not on the read-only lists below, so a page can never write to, top up or debit a card.
 * Never sent to the page: the card's UID (only its length) and nothing is stored on the device.
 */
@CapacitorPlugin(name = "MontraNfc")
public class MontraNfcPlugin extends Plugin {

    /**
     * ISO 7816-4 instructions that only read: SELECT, READ BINARY, READ RECORD, GET DATA, GET RESPONSE. An issuer's own
     * read instruction joins this list only after its public source and a real-card log are reviewed (FN-58).
     */
    private static final Set<Integer> READ_ONLY_INS = new HashSet<>(Arrays.asList(0xA4, 0xB0, 0xB2, 0xCA, 0xC0));

    /** FeliCa command codes that only read: Polling, Request Service, Request Response, Read Without Encryption, Request System Code. */
    private static final Set<Integer> READ_ONLY_FELICA = new HashSet<>(Arrays.asList(0x00, 0x02, 0x04, 0x06, 0x0C));

    private static final int TIMEOUT_MS = 2000;

    private IsoDep isoDep;
    private NfcF nfcF;
    private boolean reading;

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
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(getContext());
        Activity activity = getActivity();
        if (adapter != null && activity != null) adapter.disableReaderMode(activity);
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
        try {
            if ("nfcf".equals(tech)) {
                if (nfcF == null) {
                    call.reject("No FeliCa card connected", "no_card");
                    return;
                }
                if (command.length < 2 || !READ_ONLY_FELICA.contains(command[1] & 0xFF)) {
                    call.reject("Only read commands are allowed", "not_read_only");
                    return;
                }
                resolveHex(call, nfcF.transceive(command));
            } else {
                if (isoDep == null) {
                    call.reject("No ISO-DEP card connected", "no_card");
                    return;
                }
                if (command.length < 4 || !READ_ONLY_INS.contains(command[1] & 0xFF)) {
                    call.reject("Only read commands are allowed", "not_read_only");
                    return;
                }
                resolveHex(call, isoDep.transceive(command));
            }
        } catch (IOException e) {
            closeTag();
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
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(getContext());
        Activity activity = getActivity();
        if (adapter != null && activity != null) adapter.disableReaderMode(activity);
        closeTag();
    }

    private void enable(NfcAdapter adapter) {
        int flags = NfcAdapter.FLAG_READER_NFC_A
            | NfcAdapter.FLAG_READER_NFC_B
            | NfcAdapter.FLAG_READER_NFC_F
            | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK;
        Bundle extras = new Bundle();
        extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);
        adapter.enableReaderMode(getActivity(), this::onTag, flags, extras);
    }

    private void onTag(Tag tag) {
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
        try {
            IsoDep dep = IsoDep.get(tag);
            if (dep != null) {
                dep.connect();
                dep.setTimeout(TIMEOUT_MS);
                isoDep = dep;
                if (dep.getHistoricalBytes() != null) info.put("historicalBytes", toHex(dep.getHistoricalBytes()));
                if (dep.getHiLayerResponse() != null) info.put("hiLayerResponse", toHex(dep.getHiLayerResponse()));
            } else {
                NfcF f = NfcF.get(tag);
                if (f != null) {
                    f.connect();
                    f.setTimeout(TIMEOUT_MS);
                    nfcF = f;
                    info.put("systemCode", toHex(f.getSystemCode()));
                    info.put("manufacturer", toHex(f.getManufacturer()));
                }
            }
        } catch (IOException e) {
            closeTag();
            info.put("error", "connect_failed");
        }
        notifyListeners("card", info);
    }

    private void closeTag() {
        try {
            if (isoDep != null) isoDep.close();
            if (nfcF != null) nfcF.close();
        } catch (IOException ignored) {
            // The card is gone; nothing to release.
        }
        isoDep = null;
        nfcF = null;
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

    private static byte[] fromHex(String hex) {
        String clean = hex.replaceAll("\\s", "");
        if (clean.isEmpty() || clean.length() % 2 != 0 || !clean.matches("[0-9a-fA-F]+")) {
            throw new IllegalArgumentException("not hex");
        }
        byte[] out = new byte[clean.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        return out;
    }
}
