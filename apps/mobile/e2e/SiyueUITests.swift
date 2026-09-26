import XCTest

/// Uses the current Drawer/space/plan routes and an isolated QA simulator. Every run adds
/// uniquely named local records; it never resets, uninstalls, or clears the app database.
final class SiyueUITests: XCTestCase {
    private var app: XCUIApplication!
    private var english = false
    private let timeout: TimeInterval = 30
    private var attachingFailure = false

    override func record(_ issue: XCTIssue) {
        if !attachingFailure, let app = app {
            attachingFailure = true
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "Accessibility tree at failure"
            tree.lifetime = .keepAlways
            add(tree)
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "Screen at failure"
            screenshot.lifetime = .keepAlways
            add(screenshot)
            attachingFailure = false
        }
        super.record(issue)
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        try openSpace()
    }

    override func tearDownWithError() throws { app.terminate() }

    private func copy(_ zh: String, _ en: String) -> String { english ? en : zh }

    private func page(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func expectPage(_ id: String) {
        XCTAssertTrue(page(id).waitForExistence(timeout: timeout), "Expected the actual \(id) screen, not merely a successful tap.")
    }

    private func openSpace() throws {
        let englishMenu = app.buttons["Open sidebar"]
        let chineseMenu = app.buttons["打开侧边栏"]
        let menuReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            englishMenu.exists || chineseMenu.exists
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [menuReady], timeout: timeout), .completed,
                       "The current Drawer trigger must be accessible.")
        english = englishMenu.exists
        try tap(english ? englishMenu : chineseMenu)
        try tap(app.buttons[copy("目标", "Goals")])
        expectPage("space-home")
        XCTAssertTrue(app.buttons[copy("本机空间", "This device")].waitForExistence(timeout: timeout),
                      "The local workspace must be open; an account or loading screen is not a valid fixture.")
        XCTAssertTrue(app.staticTexts[copy("仅保存在这台设备", "Saved on this device only")].exists)
    }

    private func pageScroll(_ id: String) throws -> XCUIElement {
        let marker = page(id)
        XCTAssertTrue(marker.exists, "Cannot scroll an absent \(id) page.")
        if marker.elementType == .scrollView { return marker }
        let direct = marker.children(matching: .scrollView)
        guard direct.count == 1 else {
            XCTFail("Expected one main ScrollView under \(id), found \(direct.count); refusing a keyboard or nested input scroll.")
            throw NSError(domain: "SiyueUITests", code: 1)
        }
        return direct.element(boundBy: 0)
    }

    private func reveal(_ element: XCUIElement, on pageID: String, towardsBottom: Bool = true) throws {
        _ = element.waitForExistence(timeout: 2)
        for _ in 0..<40 {
            if element.isHittable { return }
            let scroll = try pageScroll(pageID)
            let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: towardsBottom ? 0.78 : 0.24))
            let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: towardsBottom ? 0.26 : 0.76))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        XCTFail("Control is missing or not hittable on \(pageID); no unrelated control was tapped.")
        throw NSError(domain: "SiyueUITests", code: 2)
    }

    private func tap(_ element: XCUIElement, on pageID: String? = nil, towardsBottom: Bool = true) throws {
        if let pageID { try reveal(element, on: pageID, towardsBottom: towardsBottom) }
        else {
            let hittable = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                element.exists && element.isHittable
            }, object: app)
            XCTAssertEqual(XCTWaiter.wait(for: [hittable], timeout: timeout), .completed,
                           "Button did not become hittable: \(element)")
        }
        XCTAssertTrue(element.isEnabled)
        element.tap()
    }

    private func enter(_ text: String, label: String, on pageID: String) throws {
        let view = app.textViews[label]
        let field = view.exists ? view : app.textFields[label]
        try reveal(field, on: pageID)
        field.tap()
        XCTAssertTrue(field.isEnabled)
        field.typeText(text)
        XCTAssertEqual(field.value as? String, text, "Typed value must match exactly.")
    }

    private func waitLabel(_ label: String) {
        XCTAssertTrue(app.staticTexts[label].waitForExistence(timeout: timeout), "Missing visible result: \(label)")
    }

    private func makeManualDraft(_ goal: String) throws {
        try tap(app.buttons[copy("新建计划", "New plan")])
        expectPage("plan-create")
        // React Native exposes accessibilityRole=radio as an iOS button with a radio value.
        let manual = app.buttons[copy("自己填写", "Fill it in myself")]
        try tap(manual, on: "plan-create")
        let ai = app.buttons[copy("AI 帮我拆解", "Let AI break it down")]
        if app.staticTexts[copy("还没有连接 AI 服务，可以先自己填写。", "No AI service yet; fill it in yourself for now.")].exists {
            XCTAssertFalse(ai.isEnabled, "Unconfigured AI must not send the goal to a provider.")
        }
        try enter(goal, label: copy("目标", "Goal"), on: "plan-create")
        try tap(app.buttons[copy("开始填写", "Start writing")])
        expectPage("plan-draft")
        waitLabel(copy("草稿 · 自动保存", "Draft · autosaved"))
        let emptyJoin = app.buttons[copy("加入「本机空间」", "Add to “This device”")]
        XCTAssertTrue(emptyJoin.waitForExistence(timeout: timeout))
        XCTAssertFalse(emptyJoin.isEnabled,
                       "A draft without a task must not become a formal plan.")
    }

    func testManualDraftAutosavesJoinsAndGoalPersists() throws {
        let token = String(UUID().uuidString.prefix(8))
        let goal = "UITest-\(token)-goal"
        let task = "UITest-\(token)-task"
        let second = "UITest-\(token)-added"
        XCTAssertFalse(app.buttons[copy("打开目标：\(goal)", "Open goal: \(goal)")].exists)
        try makeManualDraft(goal)
        try tap(app.buttons[copy("添加任务", "Add a task")], on: "plan-draft")
        try enter(task, label: copy("任务 1", "Task 1"), on: "plan-draft")
        // Tap immediately after typing: the app must flush the debounced draft edit and
        // approve the version the user saw, without a separate Save action.
        let join = app.buttons[copy("加入「本机空间」", "Add to “This device”")]
        try tap(join)
        waitLabel(copy("已加入「本机空间」", "Added to “This device”"))
        waitLabel(copy("1 个目标 · 1 个项目 · 1 项任务。可以在空间首页查看。", "1 goal · 1 project · 1 tasks. View them from your space home."))
        try tap(app.buttons[copy("查看目标", "View goal")])
        expectPage("goal-detail")
        waitLabel(goal)
        XCTAssertTrue(app.buttons[copy("修改任务：\(task)", "Edit task: \(task)")].waitForExistence(timeout: timeout))
        try tap(app.checkBoxes[copy("完成 \(task)", "Complete \(task)")], on: "goal-detail")
        waitLabel(copy("1/1 已完成", "1/1 done"))
        try enter(second, label: copy("添加任务", "Add a task"), on: "goal-detail")
        try tap(app.buttons[copy("添加任务", "Add a task")], on: "goal-detail")
        XCTAssertTrue(app.buttons[copy("修改任务：\(second)", "Edit task: \(second)")].waitForExistence(timeout: timeout))
        waitLabel(copy("1/2 已完成", "1/2 done"))

        app.terminate()
        app.launch()
        try openSpace()
        try tap(app.buttons[copy("打开目标：\(goal)", "Open goal: \(goal)")], on: "space-home")
        expectPage("goal-detail")
        waitLabel(copy("1/2 已完成", "1/2 done"))
        XCTAssertTrue(app.buttons[copy("修改任务：\(second)", "Edit task: \(second)")].waitForExistence(timeout: timeout))
        try tap(app.buttons[copy("更多", "More")])
        try tap(app.buttons[copy("标记为已完成", "Mark as done")])
        try tap(app.buttons[copy("更多", "More")])
        XCTAssertTrue(app.buttons[copy("标记为未完成", "Mark as not done")].waitForExistence(timeout: timeout))
        try tap(app.buttons[copy("归档目标", "Archive goal")])
        try tap(app.alerts.buttons[copy("归档", "Archive")])
        waitLabel(copy("这个目标已归档，可以恢复后继续。", "This goal is archived. Restore it to continue."))
        try tap(app.buttons[copy("返回空间首页", "Back to space home")])
        expectPage("space-home")
        try tap(app.buttons[copy("恢复目标：\(goal)", "Restore goal: \(goal)")], on: "space-home")
        XCTAssertTrue(app.buttons[copy("打开目标：\(goal)", "Open goal: \(goal)")].waitForExistence(timeout: timeout))
    }

    func testDiscardDraftDoesNotCreateGoalAfterRelaunch() throws {
        let goal = "UITest-\(String(UUID().uuidString.prefix(8)))-discard"
        try makeManualDraft(goal)
        try tap(app.buttons[copy("添加任务", "Add a task")], on: "plan-draft")
        try enter("UITest-discard-task", label: copy("任务 1", "Task 1"), on: "plan-draft")
        try tap(app.buttons[copy("放弃草稿", "Discard draft")])
        try tap(app.alerts.buttons[copy("放弃", "Discard")])
        expectPage("space-home")
        XCTAssertFalse(app.buttons[copy("打开目标：\(goal)", "Open goal: \(goal)")].exists)
        XCTAssertFalse(app.buttons[copy("打开草稿：\(goal)", "Open draft: \(goal)")].exists)
        app.terminate()
        app.launch()
        try openSpace()
        XCTAssertFalse(app.buttons[copy("打开目标：\(goal)", "Open goal: \(goal)")].exists)
        XCTAssertFalse(app.buttons[copy("打开草稿：\(goal)", "Open draft: \(goal)")].exists)
    }

    func testAutosavedDraftResumesAfterRelaunch() throws {
        let token = String(UUID().uuidString.prefix(8))
        let goal = "UITest-\(token)-resume"
        let task = "UITest-\(token)-resume-task"
        try makeManualDraft(goal)
        try tap(app.buttons[copy("添加任务", "Add a task")], on: "plan-draft")
        try enter(task, label: copy("任务 1", "Task 1"), on: "plan-draft")
        let saved = app.staticTexts[copy("草稿 · 自动保存", "Draft · autosaved")]
        XCTAssertTrue(saved.waitForExistence(timeout: timeout), "The edited draft must finish autosaving.")

        app.terminate()
        app.launch()
        try openSpace()
        try tap(app.buttons[copy("打开草稿：\(goal)", "Open draft: \(goal)")], on: "space-home")
        expectPage("plan-draft")
        let recoveredTask = app.textViews[copy("任务 1", "Task 1")]
        XCTAssertTrue(recoveredTask.waitForExistence(timeout: timeout))
        XCTAssertEqual(recoveredTask.value as? String, task,
                       "The task must survive process restart in the recoverable draft.")
        try tap(app.buttons[copy("加入「本机空间」", "Add to “This device”")])
        waitLabel(copy("已加入「本机空间」", "Added to “This device”"))
        try tap(app.buttons[copy("查看目标", "View goal")])
        expectPage("goal-detail")
        XCTAssertTrue(app.buttons[copy("修改任务：\(task)", "Edit task: \(task)")].waitForExistence(timeout: timeout))
    }
}
