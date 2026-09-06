package app.siyue.uihost;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.graphics.Rect;
import android.content.Context;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityWindowInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.Configurator;
import androidx.test.uiautomator.StaleObjectException;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TestWatcher;
import org.junit.runner.Description;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/** Only drives the separate QA app. No database deletion, production-package actions, or network changes. */
@RunWith(AndroidJUnit4.class)
public final class NativeRecoveryTest {
    private static final String APP = "app.siyue.mobile.qa";
    private static final String HOST = "app.siyue.uihost";
    private static final long TIMEOUT = 30_000;
    private UiDevice device;
    private Instrumentation instrumentation;
    private File evidence;

    @Rule public final TestWatcher diagnostics = new TestWatcher() {
        @Override protected void failed(Throwable failure, Description description) {
            capture("failure");
            Log.e("SiyueNativeRecovery", description.getMethodName(), failure);
        }
    };

    @Before public void start() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        assertEquals("Instrumentation must target the separate host", HOST, context.getPackageName());
        device = UiDevice.getInstance(instrumentation);
        Configurator.getInstance().setWaitForIdleTimeout(500);
        evidence = new File(context.getExternalFilesDir(null), "native-recovery-" + UUID.randomUUID());
        assertTrue(evidence.mkdirs());
        Bundle status = new Bundle();
        status.putString("stream", "\nNative recovery evidence: " + evidence.getAbsolutePath() + "\n");
        instrumentation.sendStatus(0, status);
        stopQa(); // A previous failed run may be open. Its data is preserved.
        launchQa();
    }

    @Test public void lostReceiptRecoversAcrossForceStop() throws Exception {
        String caseId = UUID.randomUUID().toString();
        enterCase(caseId);
        click("siyue-qa-inject");
        JSONObject injected = result("injected", caseId);
        assertCommon(injected, caseId);
        assertEquals(1, injected.getInt("executeCalls"));
        assertEquals(1, injected.getInt("receiptCalls"));
        assertEquals(0, injected.getInt("cleanupCalls"));
        assertFalse(injected.getBoolean("receiptValidated"));
        JSONObject initialJournal = injected.getJSONObject("journal");
        assertTrue(initialJournal.getBoolean("beforeExecute"));
        assertEquals(1, initialJournal.getInt("pendingCount"));
        assertFalse(initialJournal.getBoolean("cleanupAfterReceiptValidation"));
        assertTrace(injected, "journal_present_before_execute", "sqlite_commit_observed", "response_lost",
                "journal_present_before_receipt", "receipt_temporarily_unavailable");
        capture("committed-with-pending-response");

        String previousPid = device.executeShellCommand("pidof app.siyue.mobile.qa").trim();
        assertFalse("QA process must actually exist before the recovery boundary", previousPid.isEmpty());
        stopQa();
        assertEquals("The independent instrumentation host must remain alive", HOST,
                instrumentation.getTargetContext().getPackageName());
        launchQa();
        assertTrue("Case input is intentionally re-entered, not automatically restored",
                required("siyue-qa-case").getText() == null || required("siyue-qa-case").getText().isEmpty());
        enterCase(caseId);
        click("siyue-qa-recover");
        JSONObject recovered = result("recovered", caseId);
        assertCommon(recovered, caseId);
        assertNotEquals("A new JavaScript process session must execute the recovery phase",
                injected.getString("processSession"), recovered.getString("processSession"));
        for (String key : new String[]{"commandId", "issuedAt", "spaceId", "goalId", "projectId", "taskId", "stateDigest"}) {
            assertEquals("Recovery changed original " + key, injected.getString(key), recovered.getString(key));
        }
        assertEquals("Receipt reconciliation must not call execute again", 0, recovered.getInt("executeCalls"));
        assertEquals(1, recovered.getInt("receiptCalls"));
        assertEquals(1, recovered.getInt("cleanupCalls"));
        assertTrue(recovered.getBoolean("receiptValidated"));
        JSONObject recoveredJournal = recovered.getJSONObject("journal");
        assertFalse(recoveredJournal.getBoolean("beforeExecute"));
        assertEquals(0, recoveredJournal.getInt("pendingCount"));
        assertTrue(recoveredJournal.getBoolean("cleanupAfterReceiptValidation"));
        assertTrace(recovered, "journal_present_before_receipt", "original_receipt_validated",
                "journal_present_until_validated", "journal_cleared");
        capture("original-receipt-reconciled-after-relaunch");
    }

    @Test public void storageFaultsPreserveData() throws Exception {
        String caseId = UUID.randomUUID().toString();
        enterCase(caseId);
        click("siyue-qa-storage");
        JSONObject output = result("storage", caseId);
        assertEquals(1, output.getInt("schemaVersion"));
        assertEquals("storage-faults", output.getString("kind"));
        assertEquals("passed", output.getString("status"));
        JSONObject cases = output.getJSONObject("cases");
        assertEquals(3, cases.length());
        JSONObject rollback = cases.getJSONObject("rollback");
        String rollbackName = rollback.getString("databaseName");
        String corruptName = cases.getJSONObject("corrupt").getString("databaseName");
        String futureName = cases.getJSONObject("future").getString("databaseName");
        assertNotEquals(rollbackName, corruptName);
        assertNotEquals(rollbackName, futureName);
        assertNotEquals(corruptName, futureName);
        for (String name : new String[]{rollbackName, corruptName, futureName}) {
            assertTrue(name.startsWith("siyue-native-storage-" + caseId + "-") && name.endsWith(".db") && !name.contains("/"));
        }
        assertEquals(rollback.getString("commandId"), UUID.fromString(rollback.getString("commandId")).toString());
        for (String stage : new String[]{"baselineCounts", "afterRollbackCounts", "afterReopenCounts"}) {
            assertStorageCounts(rollback.getJSONObject(stage), 1);
        }
        for (String stage : new String[]{"insideCounts", "afterRetryCounts", "afterDuplicateCounts"}) {
            assertStorageCounts(rollback.getJSONObject(stage), 2);
        }
        for (String flag : new String[]{"insideWriteObserved", "observerSawBaseline", "rollbackRawEqual", "reopenRawEqual", "retryReceiptEqual"}) {
            assertTrue("Native observation must hold: " + flag, rollback.getBoolean(flag));
        }
        for (String key : new String[]{"baselineDigest", "rollbackDigest", "reopenDigest", "finalDigest"}) {
            assertTrue(rollback.getString(key).matches("[a-f0-9]{64}"));
        }
        assertEquals(rollback.getString("baselineDigest"), rollback.getString("rollbackDigest"));
        assertEquals(rollback.getString("baselineDigest"), rollback.getString("reopenDigest"));
        assertNotEquals("The successful retry must change persisted data", rollback.getString("baselineDigest"), rollback.getString("finalDigest"));
        for (String kind : new String[]{"corrupt", "future"}) {
            JSONObject rejected = cases.getJSONObject(kind);
            assertEquals(kind.equals("corrupt") ? "corrupt_data" : "unsupported_schema", rejected.getString("errorCode"));
            assertTrue(rejected.getBoolean("rawPreserved"));
            for (String key : new String[]{"beforeDigest", "afterDigest", "reopenDigest"}) {
                assertTrue(rejected.getString(key).matches("[a-f0-9]{64}"));
            }
            assertEquals(rejected.getString("beforeDigest"), rejected.getString("afterDigest"));
            assertEquals(rejected.getString("beforeDigest"), rejected.getString("reopenDigest"));
        }
        capture("storage-rollback-and-rejected-data-preserved");
    }

    private void assertStorageCounts(JSONObject counts, int expected) throws Exception {
        assertEquals(5, counts.length());
        for (String kind : new String[]{"goals", "projects", "tasks", "events", "receipts"}) {
            assertEquals("Unexpected real SQL count for " + kind, expected, counts.getInt(kind));
        }
    }

    @Test public void normalUiCancellationAndGenerationRestart() throws Exception {
        String caseId = UUID.randomUUID().toString();
        openRunUi(caseId);
        runField("Native cancellation");
        click("siyue-generate");
        JSONObject running = observeRun("running-before-cancel", caseId);
        assertEmptyFormal(running);
        assertRun(running, 0, "running", 1);
        click("siyue-qa-run-back");
        scanRun("siyue-cancel-generation").click();
        scanRun("siyue-error-message");
        assertEquals("生成已取消，输入仍然保留。", required("siyue-error-message").getText());
        assertEquals("Native cancellation", scanRun("siyue-goal-input").getText());
        assertTrue(scanRun("siyue-manual-create").isEnabled());
        JSONObject cancelled = observeRun("cancelled", caseId);
        assertEmptyFormal(cancelled);
        assertRun(cancelled, 0, "cancelled", 2);
        assertEquals(running.getJSONArray("runs").getJSONObject(0).getString("id"),
                cancelled.getJSONArray("runs").getJSONObject(0).getString("id"));
        // Beyond the original 20-second provider delay: cancellation must prevent late writes.
        SystemClock.sleep(21_000);
        JSONObject late = observeRun("cancelled-after-provider-deadline", caseId);
        assertEquals(cancelled.toString(), late.toString());
        click("siyue-qa-run-back");
        runField("Native interruption");
        click("siyue-generate");
        JSONObject beforeKill = observeRun("running-before-kill", caseId);
        assertEmptyFormal(beforeKill);
        assertRun(beforeKill, 1, "running", 1);
        assertEquals(2, beforeKill.getJSONArray("runs").length());
        String oldId = beforeKill.getJSONArray("runs").getJSONObject(1).getString("id");
        String oldSession = beforeKill.getString("processSession");
        assertFalse(device.executeShellCommand("pidof app.siyue.mobile.qa").trim().isEmpty());
        stopQa();
        launchQa();
        openRunUi(caseId);
        JSONObject recovered = observeRun("interrupted-after-kill", caseId);
        assertNotEquals(oldSession, recovered.getString("processSession"));
        assertEmptyFormal(recovered);
        assertEquals(2, recovered.getJSONArray("runs").length());
        assertRun(recovered, 0, "cancelled", 2);
        assertRun(recovered, 1, "interrupted", 2);
        assertEquals(oldId, recovered.getJSONArray("runs").getJSONObject(1).getString("id"));
        click("siyue-qa-run-back");
        assertTrue(scanRun("siyue-run-status").getText().contains("上次生成已中断，没有自动重试"));
        assertTrue(scanRun("siyue-manual-create").isEnabled());
        stopQa();
        launchQa();
        openRunUi(caseId);
        JSONObject again = observeRun("interrupted-second-restart", caseId);
        assertNotEquals(recovered.getString("processSession"), again.getString("processSession"));
        assertEquals(recovered.getJSONArray("runs").toString(), again.getJSONArray("runs").toString());
        assertEmptyFormal(again);
    }

    private void openRunUi(String caseId) throws Exception {
        enterCase(caseId);
        click("siyue-qa-run-ui");
        awaitElement("siyue-local-state");
        long deadline = SystemClock.uptimeMillis() + TIMEOUT;
        while (!"本机空间 · 离线可用".equals(required("siyue-local-state").getText()) && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100);
        assertEquals("本机空间 · 离线可用", required("siyue-local-state").getText());
    }

    private UiObject2 scanRun(String id) {
        UiObject2 current = unique(id);
        if (current != null && current.getVisibleBounds().height() > 0) return current;
        // Errors appear above the form; search from the verified top when not visible.
        for (int i = 0; i < 15 && unique("siyue-page-start") == null; i++) {
            Rect b = required("siyue-main-scroll").getVisibleBounds();
            assertTrue(b.height() > 100);
            assertTrue(device.swipe(b.right - 12, b.top + b.height() / 4, b.right - 12, b.top + b.height() * 3 / 4, 20));
        }
        for (int i = 0; i < 15; i++) {
            UiObject2 found = unique(id);
            if (found != null && found.getVisibleBounds().height() > 0) return found;
            UiObject2 scroll = required("siyue-main-scroll");
            Rect b = scroll.getVisibleBounds();
            assertTrue(b.height() > 100);
            int x = b.right - 12;
            assertTrue(device.swipe(x, b.top + b.height() * 3 / 4, x, b.top + b.height() / 4, 20));
        }
        fail("Normal UI control not found: " + id); return null;
    }

    private void runField(String value) {
        scanRun("siyue-goal-input").setText(value);
        boolean keyboard = false;
        for (AccessibilityWindowInfo window : instrumentation.getUiAutomation().getWindows())
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) keyboard = true;
        if (keyboard) device.pressBack();
        assertEquals(value, scanRun("siyue-goal-input").getText());
        scanRun("siyue-generate");
    }

    private JSONObject observeRun(String label, String caseId) throws Exception {
        click("siyue-qa-run-observe");
        awaitElement("siyue-qa-run-result");
        assertNull(unique("siyue-qa-run-error"));
        JSONObject result = new JSONObject(required("siyue-qa-run-result").getText());
        assertEquals(1, result.getInt("schemaVersion"));
        assertEquals(caseId, result.getString("caseId"));
        try (FileOutputStream stream = new FileOutputStream(new File(evidence, label + ".json"))) {
            stream.write(result.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        capture(label);
        return result;
    }

    private void assertEmptyFormal(JSONObject result) throws Exception {
        JSONObject counts = result.getJSONObject("counts");
        assertEquals(7, counts.length());
        for (String key : new String[]{"goals", "projects", "tasks", "events", "receipts", "drafts", "approvals"}) assertEquals(key, 0, counts.getInt(key));
        assertEquals(0, result.getInt("pendingCount"));
    }

    private void assertRun(JSONObject result, int index, String status, int seq) throws Exception {
        JSONObject run = result.getJSONArray("runs").getJSONObject(index);
        assertEquals(status, run.getString("status"));
        assertEquals(seq, run.getInt("seq"));
        assertFalse(run.has("draftId"));
        JSONArray events = run.getJSONArray("events");
        assertEquals(seq, events.length());
        for (int i = 0; i < seq; i++) {
            JSONObject event = events.getJSONObject(i);
            assertEquals(1, event.getInt("schemaVersion"));
            assertEquals(run.getString("id"), event.getString("runId"));
            assertEquals(i + 1, event.getInt("seq"));
            assertEquals(i == 0 ? "running" : status, event.getString("state"));
        }
    }

    private void assertCommon(JSONObject result, String caseId) throws Exception {
        assertEquals(1, result.getInt("schemaVersion"));
        assertEquals(caseId, result.getString("caseId"));
        assertTrue("Original command and receipt must be read back from fixture SQLite", result.getBoolean("metadataPersisted"));
        for (String key : new String[]{"commandId", "spaceId", "goalId", "projectId", "taskId", "processSession"}) {
            assertEquals(result.getString(key), UUID.fromString(result.getString(key)).toString());
        }
        assertEquals(64, result.getString("stateDigest").length());
        assertTrue(result.getString("stateDigest").matches("[a-f0-9]{64}"));
        OffsetDateTime.parse(result.getString("issuedAt"));
        JSONObject counts = result.getJSONObject("counts");
        assertEquals(5, counts.length());
        for (String kind : new String[]{"goals", "projects", "tasks", "events", "receipts"}) {
            assertEquals("Actual SQLite snapshot must contain one " + kind, 1, counts.getInt(kind));
        }
        JSONObject journal = result.getJSONObject("journal");
        assertTrue(journal.getBoolean("metadataOnly"));
        assertTrue(journal.getBoolean("beforeReceipt"));
        assertEquals(result.getString("commandId"), journal.getString("commandId"));
        assertEquals(result.getString("issuedAt"), journal.getString("issuedAt"));
    }

    private void assertTrace(JSONObject result, String... expected) throws Exception {
        JSONArray trace = result.getJSONArray("trace");
        assertEquals("Native observation sequence length", expected.length, trace.length());
        for (int i = 0; i < expected.length; i++) assertEquals(expected[i], trace.getString(i));
    }

    private void launchQa() throws IOException {
        // applicationId is distinct; the existing Activity class keeps its original namespace.
        String result = device.executeShellCommand("am start -W -n app.siyue.mobile.qa/app.siyue.mobile.MainActivity");
        assertTrue("QA launch failed: " + result, result.contains("Status: ok"));
        awaitElement("siyue-qa-ready");
        assertEquals(APP, device.getCurrentPackageName());
    }

    private void stopQa() throws IOException {
        device.executeShellCommand("am force-stop app.siyue.mobile.qa");
        long deadline = SystemClock.uptimeMillis() + TIMEOUT;
        while (!device.executeShellCommand("pidof app.siyue.mobile.qa").trim().isEmpty()
                && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100);
        assertEquals("QA PID must disappear; backgrounding alone is not a restart", "",
                device.executeShellCommand("pidof app.siyue.mobile.qa").trim());
    }

    private BySelector resource(String id) { return By.pkg(APP).res(id); }

    private UiObject2 unique(String id) {
        List<UiObject2> matches = device.findObjects(resource(id));
        assertTrue("Ambiguous QA control: " + id, matches.size() <= 1);
        return matches.isEmpty() ? null : matches.get(0);
    }

    private UiObject2 required(String id) {
        UiObject2 element = unique(id);
        assertNotNull("Missing QA control: " + id, element);
        return element;
    }

    private void awaitElement(String id) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT;
        do {
            if (unique(id) != null) return;
            SystemClock.sleep(100);
        } while (SystemClock.uptimeMillis() < deadline);
        fail("Timed out waiting for QA control: " + id);
    }

    private void enterCase(String value) {
        UiObject2 input = required("siyue-qa-case");
        assertEquals("android.widget.EditText", input.getClassName());
        input.setText(value);
        assertEquals(value, required("siyue-qa-case").getText());
        boolean keyboard = false;
        for (AccessibilityWindowInfo window : instrumentation.getUiAutomation().getWindows()) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) keyboard = true;
        }
        if (keyboard) {
            device.pressBack();
            device.waitForIdle(500);
            assertEquals(APP, device.getCurrentPackageName());
        }
    }

    private void click(String id) {
        UiObject2 target = required(id);
        assertTrue("QA button must be enabled", target.isEnabled());
        assertTrue("QA button must be clickable", target.isClickable());
        target.click();
    }

    private JSONObject result(String phase, String caseId) throws Exception {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT;
        do {
            try {
                UiObject2 error = unique("siyue-qa-error");
                assertNull("Native QA failed: " + (error == null ? "" : error.getText()), error);
                UiObject2 element = unique("siyue-qa-result");
                if (element != null && element.getText() != null && !element.getText().isEmpty()) {
                    JSONObject output = new JSONObject(element.getText());
                    assertEquals(phase, output.getString("phase"));
                    assertEquals(caseId, output.getString("caseId"));
                    try (FileOutputStream stream = new FileOutputStream(new File(evidence, phase + ".json"))) {
                        stream.write(output.toString(2).getBytes(StandardCharsets.UTF_8));
                    }
                    return output;
                }
            } catch (StaleObjectException ignored) { /* Read newly rendered state on next poll. */ }
            SystemClock.sleep(100);
        } while (SystemClock.uptimeMillis() < deadline);
        fail("Native SQL result JSON was not produced; a phase label alone is insufficient.");
        return null;
    }

    private void capture(String label) {
        if (device == null || evidence == null) return;
        try {
            device.dumpWindowHierarchy(new File(evidence, label + ".xml"));
            if (!device.takeScreenshot(new File(evidence, label + ".png"))) Log.e("SiyueNativeRecovery", "Screenshot unavailable: " + label);
        } catch (IOException failure) { Log.e("SiyueNativeRecovery", "Could not save evidence", failure); }
    }
}
