package id.montra.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import org.junit.Test;

/**
 * FN-58: the bridge's read-only guard against the same vectors as the web app's guard
 * (src/lib/shared/emoney/read-only-vectors.txt, also run by commands.test.ts), so the two cannot drift apart.
 * Run with `./gradlew testDebugUnitTest` from native/android-app/android.
 */
public class MontraNfcPluginGuardTest {

    /** Gradle runs unit tests from the module directory, native/android-app/android/app. */
    private static final Path VECTORS = Paths.get("../../../../src/lib/shared/emoney/read-only-vectors.txt");

    @Test
    public void guardMatchesTheSharedVectors() throws IOException {
        List<String> lines = Files.readAllLines(VECTORS, StandardCharsets.UTF_8);
        int checked = 0;
        for (String raw : lines) {
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            String[] parts = line.split("\\s+", 4);
            String tech = parts[0];
            String hex = parts[1];
            String verdict = parts[2];
            assertTrue(line, verdict.equals("allow") || verdict.equals("refuse"));
            assertEquals(line, verdict.equals("allow"), allowed(tech, hex));
            checked++;
        }
        assertTrue("too few vectors: " + checked, checked > 30);
    }

    /** What transceive does before it reaches the card: parse the hex (bad hex is refused), then the guard. */
    private static boolean allowed(String tech, String hex) {
        byte[] command;
        try {
            command = MontraNfcPlugin.fromHex(hex);
        } catch (IllegalArgumentException e) {
            return false;
        }
        return MontraNfcPlugin.isReadOnlyCommand(tech, command);
    }
}
