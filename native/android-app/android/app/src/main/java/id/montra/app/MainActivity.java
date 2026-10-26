package id.montra.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // FN-58: the read-only NFC bridge, registered before the bridge starts.
        registerPlugin(MontraNfcPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
