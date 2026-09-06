package app.siyue.uihost;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Context;
import android.graphics.Rect;
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
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TestWatcher;
import org.junit.runner.Description;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/** Cross-app instrumentation. Never clears data, edits unrelated records, or calls a model service. */
@RunWith(AndroidJUnit4.class)
public final class GoalFlowTest {
    private static final String APP = "app.siyue.mobile";
    private static final String HOST = "app.siyue.uihost";
    private static final long TIMEOUT = 25_000;
    private UiDevice device;
    private Instrumentation instrumentation;
    private File evidence;

    @Rule public final TestWatcher diagnostics = new TestWatcher() {
        @Override protected void failed(Throwable failure, Description description) {
            capture("failure");
            Log.e("SiyueUiHost", description.getMethodName(), failure);
        }
    };

    @Before public void start() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        Context host = instrumentation.getTargetContext();
        assertEquals("Instrumentation must run inside the independent host", HOST, host.getPackageName());
        device = UiDevice.getInstance(instrumentation);
        Configurator.getInstance().setWaitForIdleTimeout(500);
        evidence = new File(host.getExternalFilesDir(null), "m1-" + UUID.randomUUID());
        assertTrue("Create a new evidence directory without overwriting prior runs", evidence.mkdirs());
        Bundle status = new Bundle();
        status.putString("stream", "\nSiyue UI evidence: " + evidence.getAbsolutePath() + "\n");
        instrumentation.sendStatus(0, status);
        // Start with fresh activity state after a prior failed test, while retaining all local records.
        stopSiyue();
        launchSiyue();
    }

    @Test public void goalDraftConfirmationPersistenceRejectionAndManualCreation() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String input = "Android-" + suffix + "-goal";
        String goal = "Android-" + suffix + "-edited";
        String project = "Android-" + suffix + "-project";
        String task = "Android-" + suffix + "-task";
        String rejected = "Android-" + suffix + "-rejected";
        String manual = "Android-" + suffix + "-manual";
        String manualTask = "Android-" + suffix + "-manual-task";
        int initialGoals = goalCount();

        setField("我的目标", input);
        click("生成示例计划");
        scan(text("检查并编辑草稿"));
        assertEquals("Unconfirmed draft cannot create a formal goal", initialGoals, goalCount());
        setField("目标标题", goal);
        setField("项目 · 每行一个，最多 8 个", project);
        setField("任务 · 每行一个，最多 24 个", task);
        assertFalse("Unsaved edits must disable stale confirmation", scan(button("确认并正式保存")).isEnabled());
        click("保存草稿修改");
        scan(button("确认并正式保存"));
        await("Saved draft becomes confirmable", () -> enabled(button("确认并正式保存")));
        assertEquals(initialGoals, goalCount());

        forceStopAndRelaunch();
        assertEquals("Restarted draft still requires confirmation", initialGoals, goalCount());
        click("继续：" + goal);
        assertEquals(goal, scan(field("目标标题")).getText());
        click("确认并正式保存");
        String goalId = recordId("goal", goal);
        String projectId = recordId("project", project);
        String taskId = recordId("task", task);
        assertEquals(initialGoals + 1, goalCount());
        BySelector toggle = resource("siyue-task-toggle-" + taskId);
        UiObject2 complete = scan(toggle);
        assertEquals("完成任务", complete.getContentDescription());
        assertTrue(complete.isEnabled());
        complete.click();
        waitRecordStatus("task", taskId, "已完成");
        capture("confirmed-and-completed");

        forceStopAndRelaunch();
        assertEquals(goalId, recordId("goal", goal));
        assertEquals(projectId, recordId("project", project));
        assertEquals(taskId, recordId("task", task));
        waitRecordStatus("task", taskId, "已完成");
        assertEquals("撤销完成", scan(toggle).getContentDescription());
        assertEquals("Force-stop/relaunch cannot add duplicate goals", initialGoals + 1, goalCount());
        capture("relaunch-preserved-records");

        setField("我的目标", rejected);
        click("生成示例计划");
        scan(text("检查并编辑草稿"));
        click("拒绝草稿");
        scan(text("草稿已拒绝，没有创建正式目标。编辑内容保留，可手动保存。"));
        assertEquals("Reject cannot create a formal goal", initialGoals + 1, goalCount());
        assertNoRecord("goal", rejected);
        click("收起编辑（保留输入）");

        setField("我的目标", manual);
        click("手动创建");
        setField("任务 · 每行一个，最多 24 个", manualTask);
        click("确认保存手动计划");
        recordId("goal", manual);
        recordId("task", manualTask);
        assertEquals(initialGoals + 2, goalCount());
        assertNoRecord("goal", rejected);
        capture("manual-saved-rejected-absent");
    }

    @Test public void manualRenameCompletionArchiveAndRelaunch() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String goal = "Android-" + suffix + "-manual-edit";
        String renamedGoal = "Android-" + suffix + "-renamed-goal";
        String task = "Android-" + suffix + "-manual-task";
        String renamedTask = "Android-" + suffix + "-renamed-task";
        int initialGoals = goalCount();

        setField("我的目标", goal);
        click("手动创建");
        setField("任务 · 每行一个，最多 24 个", task);
        click("确认保存手动计划");
        String goalId = recordId("goal", goal);
        String taskId = recordId("task", task);
        assertEquals(initialGoals + 1, goalCount());

        clickIdentified("siyue-record-rename-goal-" + goalId, "改名");
        setField("修改名称", renamedGoal);
        clickIdentified("siyue-record-save-name-goal-" + goalId, "保存名称");
        scan(text(renamedGoal));
        assertEquals("Renaming must retain the formal goal ID", goalId, recordId("goal", renamedGoal));
        assertNoRecord("goal", goal);

        clickIdentified("siyue-record-rename-task-" + taskId, "改名");
        setField("修改名称", renamedTask);
        clickIdentified("siyue-record-save-name-task-" + taskId, "保存名称");
        scan(text(renamedTask));
        assertEquals("Renaming must retain the formal task ID", taskId, recordId("task", renamedTask));
        assertNoRecord("task", task);
        clickIdentified("siyue-task-toggle-" + taskId, "完成任务");
        waitRecordStatus("task", taskId, "已完成");
        capture("manual-renamed-and-completed");

        clickIdentified("siyue-record-archive-task-" + taskId, "归档");
        waitRecordStatus("task", taskId, "已归档");
        clickIdentified("siyue-record-archive-goal-" + goalId, "归档");
        waitRecordStatus("goal", goalId, "已归档");
        assertEquals("Rename and archive cannot create duplicate goals", initialGoals + 1, goalCount());
        assertArchivedRecordsReadOnly(goalId, taskId);
        capture("manual-renamed-and-archived");

        forceStopAndRelaunch();
        assertEquals(goalId, recordId("goal", renamedGoal));
        assertEquals(taskId, recordId("task", renamedTask));
        waitRecordStatus("goal", goalId, "已归档");
        waitRecordStatus("task", taskId, "已归档");
        assertEquals("Relaunch must preserve the formal goal count", initialGoals + 1, goalCount());
        assertNoRecord("goal", goal);
        assertNoRecord("task", task);
        assertArchivedRecordsReadOnly(goalId, taskId);
        capture("archived-records-retained-after-relaunch");
    }

    private void launchSiyue() throws IOException {
        String result = device.executeShellCommand("am start -W -n app.siyue.mobile/.MainActivity");
        assertTrue("Siyue launch failed: " + result, result.contains("Status: ok"));
        await("The app shell must expose the actions tab", () -> visible(text("行动")) != null);
        visible(text("行动")).click();
        await("Siyue main content must be mounted", () -> visible(resource("siyue-main-scroll")) != null);
        // am start may resume the existing activity at a prior scroll offset; preserve data and return to its header.
        goToTop();
        await("Siyue must open a real local space", () -> visible(text("本机空间 · 离线可用")) != null);
        assertEquals(APP, device.getCurrentPackageName());
    }

    private void forceStopAndRelaunch() throws IOException {
        String previousPid = device.executeShellCommand("pidof app.siyue.mobile").trim();
        assertFalse("App must actually be running before force-stop", previousPid.isEmpty());
        stopSiyue();
        launchSiyue();
    }

    private void stopSiyue() throws IOException {
        device.executeShellCommand("am force-stop app.siyue.mobile");
        long deadline = SystemClock.uptimeMillis() + TIMEOUT;
        while (!device.executeShellCommand("pidof app.siyue.mobile").trim().isEmpty()
                && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100);
        assertEquals("Siyue process must terminate; hiding the activity is insufficient", "",
                device.executeShellCommand("pidof app.siyue.mobile").trim());
        assertEquals("The host must survive stopping Siyue", HOST, instrumentation.getTargetContext().getPackageName());
    }

    // RN accessibilityRole=header exposes text as android.view.View, not TextView.
    // Read-only text queries therefore avoid a native class constraint; actionable queries stay typed.
    private static BySelector text(String value) { return By.pkg(APP).text(value); }
    private static BySelector button(String value) { return By.pkg(APP).desc(value).clickable(true); }
    private static BySelector field(String value) { return By.pkg(APP).desc(value).clazz("android.widget.EditText"); }
    private static BySelector resource(String value) { return By.pkg(APP).res(value); }

    private void setField(String label, String value) {
        // ACTION_SET_TEXT replaces content without typing shell escapes or depending on an IME language.
        scan(field(label)).setText(value);
        await("Input replacement must be exact: " + label, () -> {
            UiObject2 input = visible(field(label));
            return input != null && value.equals(input.getText());
        });
        if (keyboardVisible()) {
            device.pressBack();
            await("Back only dismisses a detected input-method window", () -> !keyboardVisible());
            assertEquals("Dismissing keyboard must not exit Siyue", APP, device.getCurrentPackageName());
        }
    }

    private boolean keyboardVisible() {
        for (AccessibilityWindowInfo window : instrumentation.getUiAutomation().getWindows()) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
        }
        return false;
    }

    private void click(String label) {
        BySelector selector = button(label);
        scan(selector);
        await("Button enabled: " + label, () -> enabled(selector));
        UiObject2 target = visible(selector);
        assertNotNull(target);
        target.click();
    }

    private boolean enabled(BySelector selector) {
        UiObject2 element = visible(selector);
        return element != null && element.isEnabled();
    }

    private void clickIdentified(String identifier, String label) {
        BySelector selector = resource(identifier).clickable(true);
        scan(selector);
        await("Identified button enabled: " + identifier, () -> enabled(selector));
        UiObject2 target = visible(selector);
        assertNotNull(target);
        assertEquals("Identified action must have the expected semantics", label, target.getContentDescription());
        target.click();
    }

    private void assertArchivedRecordsReadOnly(String goalId, String taskId) {
        List<String> forbidden = new ArrayList<>();
        for (String action : new String[]{"rename", "archive", "save-name", "cancel-name"}) {
            forbidden.add("siyue-record-" + action + "-goal-" + goalId);
            forbidden.add("siyue-record-" + action + "-task-" + taskId);
        }
        forbidden.add("siyue-task-toggle-" + taskId);
        goToTop();
        for (int i = 0; i < 80; i++) {
            for (String identifier : forbidden) {
                assertFalse("Archived records must expose no editing action: " + identifier,
                        device.hasObject(resource(identifier)));
            }
            if (visible(resource("siyue-page-end")) != null) return;
            scrollMain(true);
        }
        fail("Could not reach the identified footer; archived action absence was not proven.");
    }

    private int goalCount() {
        UiObject2 state = scan(resource("siyue-count-goal"), resource("siyue-goals-empty"));
        String label = state.getText();
        if ("siyue-goals-empty".equals(state.getResourceName())) return 0;
        assertNotNull(label);
        assertTrue("Count header must be a positive integer", label.matches("目标 · [1-9][0-9]*"));
        return Integer.parseInt(label.substring("目标 · ".length()));
    }

    private String recordId(String kind, String title) {
        Set<String> ids = collectRecordIds(kind, title);
        assertEquals("The full page must contain exactly one " + kind + " record with the synthetic title", 1, ids.size());
        return ids.iterator().next();
    }

    private Set<String> collectRecordIds(String kind, String title) {
        String prefix = "siyue-record-" + kind + "-";
        Set<String> ids = new LinkedHashSet<>();
        goToTop();
        for (int i = 0; i < 80; i++) {
            List<UiObject2> rows = device.findObjects(By.pkg(APP).res(Pattern.compile("^" + Pattern.quote(prefix) + ".+")));
            for (UiObject2 named : device.findObjects(text(title))) {
                Rect bounds = named.getVisibleBounds();
                if (bounds.width() <= 0 || bounds.height() <= 0) continue;
                List<String> matchingRows = new ArrayList<>();
                for (UiObject2 row : rows) {
                    if (row.getVisibleBounds().contains(bounds)) {
                        String id = row.getResourceName().substring(prefix.length());
                        assertFalse("Identified record must have a stable ID", id.isEmpty());
                        matchingRows.add(id);
                    }
                }
                assertTrue("A title cannot ambiguously belong to multiple records", matchingRows.size() <= 1);
                ids.addAll(matchingRows);
            }
            // Only the system's identified footer proves a complete page scan, never user text.
            if (visible(resource("siyue-page-end")) != null) return ids;
            scrollMain(true);
        }
        fail("Could not reach the identified footer; full-page record uniqueness/absence was not proven.");
        return ids;
    }

    private void waitRecordStatus(String kind, String id, String expected) {
        BySelector selector = resource("siyue-record-status-" + kind + "-" + id);
        scan(selector);
        await("Record status: " + expected, () -> {
            UiObject2 status = visible(selector);
            return status != null && expected.equals(status.getText());
        });
    }

    private void assertNoRecord(String kind, String title) {
        assertTrue("Title must be absent from formal records: " + title, collectRecordIds(kind, title).isEmpty());
    }

    /** All selectors are scoped to Siyue, never keyboard/launcher controls. */
    private UiObject2 visible(BySelector selector) {
        List<UiObject2> matches = new ArrayList<>();
        for (UiObject2 candidate : device.findObjects(selector)) {
            try {
                Rect bounds = candidate.getVisibleBounds();
                if (bounds.width() > 0 && bounds.height() > 0) matches.add(candidate);
            } catch (StaleObjectException ignored) { /* Re-query on the next bounded poll. */ }
        }
        assertTrue("Ambiguous target; refusing first-match action: " + selector, matches.size() <= 1);
        return matches.isEmpty() ? null : matches.get(0);
    }

    private UiObject2 scan(BySelector... selectors) {
        UiObject2 current = firstVisible(selectors);
        if (current != null) return current;
        goToTop();
        for (int i = 0; i < 80; i++) {
            current = firstVisible(selectors);
            if (current != null) return current;
            if (visible(resource("siyue-page-end")) != null) break;
            scrollMain(true);
        }
        fail("Required control not found after scanning the bounded page; see hierarchy evidence.");
        return null;
    }

    private UiObject2 firstVisible(BySelector... selectors) {
        UiObject2 selected = null;
        for (BySelector selector : selectors) {
            UiObject2 element = visible(selector);
            if (element != null) {
                assertNull("Mutually exclusive UI states appeared together", selected);
                selected = element;
            }
        }
        return selected;
    }

    private void goToTop() {
        for (int i = 0; i < 80; i++) {
            if (visible(resource("siyue-page-start")) != null) return;
            scrollMain(false);
        }
        fail("Main content could not return to its verified top marker.");
    }

    private void scrollMain(boolean towardBottom) {
        UiObject2 container = visible(resource("siyue-main-scroll"));
        assertNotNull("Main content identifier missing; do not swipe a keyboard or arbitrary ScrollView", container);
        Rect bounds = container.getVisibleBounds();
        assertTrue("Main content viewport is usable", bounds.width() > 100 && bounds.height() > 100);
        int x = bounds.right - Math.max(8, bounds.width() / 40);
        int upper = bounds.top + bounds.height() / 4;
        int lower = bounds.top + bounds.height() * 3 / 4;
        assertTrue(device.swipe(x, towardBottom ? lower : upper, x, towardBottom ? upper : lower, 30));
        device.waitForIdle(500);
    }

    private void await(String description, BooleanSupplier condition) {
        long deadline = SystemClock.uptimeMillis() + TIMEOUT;
        do {
            try { if (condition.getAsBoolean()) return; }
            catch (StaleObjectException ignored) { /* UI changed: read its new nodes, not stale handles. */ }
            SystemClock.sleep(100);
        } while (SystemClock.uptimeMillis() < deadline);
        fail("Timed out: " + description);
    }

    private void capture(String label) {
        if (device == null || evidence == null) return;
        try {
            device.dumpWindowHierarchy(new File(evidence, label + ".xml"));
            if (!device.takeScreenshot(new File(evidence, label + ".png"))) {
                Log.e("SiyueUiHost", "Screenshot could not be captured for " + label);
            }
        } catch (IOException failure) {
            Log.e("SiyueUiHost", "Could not save UI evidence", failure);
        }
    }
}
