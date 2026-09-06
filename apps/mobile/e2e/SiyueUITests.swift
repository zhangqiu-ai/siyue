import XCTest

/// Exercises the real app and its local database. Each run leaves uniquely named fixtures in place.
final class SiyueUITests: XCTestCase {
    private var app: XCUIApplication!
    private let timeout: TimeInterval = 25
    private var recordingFailure = false

    override func record(_ issue: XCTIssue) {
        if !recordingFailure, let app = app {
            recordingFailure = true
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "Accessibility tree at failure"
            tree.lifetime = .keepAlways
            add(tree)
            capture("App at failure")
            recordingFailure = false
        }
        super.record(issue)
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        // The product copy remains Chinese; use English system edit-menu labels deterministically.
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(identifier: "本机空间 · 离线可用").firstMatch.waitForExistence(timeout: timeout),
                      "App must open its actual local space; a loading or unavailable screen is not success.")
    }

    override func tearDownWithError() throws {
        app.terminate()
    }

    func testGoalDraftConfirmationPersistenceRejectionAndManualCreation() throws {
        let suffix = UUID().uuidString.prefix(8)
        let input = "UITest-\(suffix)-goal"
        let goal = "UITest-\(suffix)-edited"
        let project = "UITest-\(suffix)-project"
        let task = "UITest-\(suffix)-task"
        let rejected = "UITest-\(suffix)-rejected"
        let manual = "UITest-\(suffix)-manual"
        let manualTask = "UITest-\(suffix)-manual-task"
        let initialGoals = goalCount()

        try replace(field: "我的目标", with: input)
        try tapButton("生成示例计划")
        XCTAssertTrue(app.staticTexts.matching(identifier: "检查并编辑草稿").firstMatch.waitForExistence(timeout: timeout))
        XCTAssertEqual(goalCount(), initialGoals, "Generating a draft must not add a formal goal.")
        XCTAssertFalse(app.staticTexts.matching(identifier: input).firstMatch.exists, "Input/draft title must not appear as a formal record.")

        try replace(field: "目标标题", with: goal)
        try replace(field: "项目 · 每行一个，最多 8 个", with: project)
        try replace(field: "任务 · 每行一个，最多 24 个", with: task)
        XCTAssertFalse(app.buttons["确认并正式保存"].isEnabled, "Unsaved edits cannot use stale approval.")
        try tapButton("保存草稿修改")
        try waitEnabled(app.buttons["确认并正式保存"])
        XCTAssertEqual(goalCount(), initialGoals)

        // Restart before approval as well: a saved draft must require an explicit resume and confirmation.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(identifier: "本机空间 · 离线可用").firstMatch.waitForExistence(timeout: timeout))
        XCTAssertEqual(goalCount(), initialGoals)
        try tapButton("继续：\(goal)")
        XCTAssertEqual(textField("目标标题").value as? String, goal)
        try tapButton("确认并正式保存")
        try waitForRecord(goal)
        try waitForRecord(project)
        try waitForRecord(task)
        XCTAssertEqual(goalCount(), initialGoals + 1)
        try tapTaskAction("完成任务", title: task)
        try waitTaskStatus("已完成", title: task)
        capture("Confirmed plan and completed task")

        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(identifier: "本机空间 · 离线可用").firstMatch.waitForExistence(timeout: timeout))
        try waitForRecord(goal)
        try waitForRecord(project)
        try waitForRecord(task)
        try waitTaskStatus("已完成", title: task)
        XCTAssertEqual(goalCount(), initialGoals + 1, "Relaunch must neither lose nor duplicate records.")

        try replace(field: "我的目标", with: rejected)
        try tapButton("生成示例计划")
        XCTAssertTrue(app.staticTexts.matching(identifier: "检查并编辑草稿").firstMatch.waitForExistence(timeout: timeout))
        try tapButton("拒绝草稿")
        XCTAssertTrue(app.staticTexts.matching(identifier: "草稿已拒绝，没有创建正式目标。编辑内容保留，可手动保存。").firstMatch.waitForExistence(timeout: timeout))
        XCTAssertEqual(goalCount(), initialGoals + 1)
        XCTAssertFalse(app.staticTexts.matching(identifier: rejected).firstMatch.exists)
        try tapButton("收起编辑（保留输入）")

        try replace(field: "我的目标", with: manual)
        try tapButton("手动创建")
        try replace(field: "任务 · 每行一个，最多 24 个", with: manualTask)
        try tapButton("确认保存手动计划")
        try waitForRecord(manual)
        try waitForRecord(manualTask)
        XCTAssertEqual(goalCount(), initialGoals + 2)
        XCTAssertFalse(app.staticTexts.matching(identifier: rejected).firstMatch.exists, "Rejected draft must remain absent from formal goals.")
        capture("Manual plan saved without executing rejected draft")
    }

    func testManualRenameCompletionArchiveAndRelaunch() throws {
        let suffix = UUID().uuidString.prefix(8)
        let goal = "UITest-\(suffix)-manual-edit"
        let renamedGoal = "UITest-\(suffix)-renamed-goal"
        let task = "UITest-\(suffix)-manual-task"
        let renamedTask = "UITest-\(suffix)-renamed-task"
        let initialGoals = goalCount()

        try replace(field: "我的目标", with: goal)
        try tapButton("手动创建")
        try replace(field: "任务 · 每行一个，最多 24 个", with: task)
        try tapButton("确认保存手动计划")
        try waitForRecord(goal)
        try waitForRecord(task)
        XCTAssertEqual(goalCount(), initialGoals + 1)
        let goalID = try recordID(kind: "goal", title: goal)
        let taskID = try recordID(kind: "task", title: task)

        try tapRecordButton("rename", kind: "goal", id: goalID, label: "改名")
        try replace(field: "修改名称", with: renamedGoal)
        try tapRecordButton("save-name", kind: "goal", id: goalID, label: "保存名称")
        try waitForRecord(renamedGoal)
        XCTAssertEqual(try recordID(kind: "goal", title: renamedGoal), goalID, "Renaming must retain the actual goal ID.")
        XCTAssertFalse(app.staticTexts.matching(identifier: goal).firstMatch.exists)

        try tapRecordButton("rename", kind: "task", id: taskID, label: "改名")
        try replace(field: "修改名称", with: renamedTask)
        try tapRecordButton("save-name", kind: "task", id: taskID, label: "保存名称")
        try waitForRecord(renamedTask)
        XCTAssertEqual(try recordID(kind: "task", title: renamedTask), taskID)
        XCTAssertFalse(app.staticTexts.matching(identifier: task).firstMatch.exists)
        try tapTaskAction("完成任务", title: renamedTask)
        try waitTaskStatus("已完成", title: renamedTask)

        try tapRecordButton("archive", kind: "task", id: taskID, label: "归档")
        try waitRecordStatus("已归档", kind: "task", id: taskID)
        try tapRecordButton("archive", kind: "goal", id: goalID, label: "归档")
        try waitRecordStatus("已归档", kind: "goal", id: goalID)
        XCTAssertEqual(goalCount(), initialGoals + 1, "Editing and archiving must not create duplicate goals.")
        capture("Manual goal and task renamed, completed, and archived")

        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(identifier: "本机空间 · 离线可用").firstMatch.waitForExistence(timeout: timeout))
        try waitForRecord(renamedGoal)
        try waitForRecord(renamedTask)
        XCTAssertEqual(try recordID(kind: "goal", title: renamedGoal), goalID)
        XCTAssertEqual(try recordID(kind: "task", title: renamedTask), taskID)
        try waitRecordStatus("已归档", kind: "goal", id: goalID)
        try waitRecordStatus("已归档", kind: "task", id: taskID)
        XCTAssertEqual(goalCount(), initialGoals + 1)
        XCTAssertFalse(app.staticTexts.matching(identifier: goal).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(identifier: task).firstMatch.exists)
        for (kind, id) in [("goal", goalID), ("task", taskID)] {
            XCTAssertFalse(app.buttons.matching(identifier: "siyue-record-rename-\(kind)-\(id)").firstMatch.exists)
            XCTAssertFalse(app.buttons.matching(identifier: "siyue-record-archive-\(kind)-\(id)").firstMatch.exists)
        }
        XCTAssertFalse(app.buttons.matching(identifier: "siyue-task-toggle-\(taskID)").firstMatch.exists, "Archived tasks must remain read-only after relaunch.")
        capture("Archived records retained after relaunch without duplicates")
    }

    private func recordID(kind: String, title: String) throws -> String {
        let titleElement = app.staticTexts.matching(identifier: title).firstMatch
        try reveal(titleElement)
        let prefix = "siyue-record-\(kind)-"
        let rows = app.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).allElementsBoundByIndex.filter {
            $0.frame.contains(titleElement.frame)
        }
        guard rows.count == 1, let row = rows.first else {
            XCTFail("Expected exactly one \(kind) row containing unique title \(title); refusing unrelated record actions.")
            throw NSError(domain: "SiyueUITests", code: 1)
        }
        let id = String(row.identifier.dropFirst(prefix.count))
        XCTAssertFalse(id.isEmpty)
        return id
    }

    private func tapRecordButton(_ action: String, kind: String, id: String, label: String) throws {
        let buttons = app.buttons.matching(identifier: "siyue-record-\(action)-\(kind)-\(id)")
        guard buttons.count == 1 else {
            XCTFail("Expected one \(action) button for the identified record; refusing an ambiguous action.")
            throw NSError(domain: "SiyueUITests", code: 1)
        }
        let button = buttons.element(boundBy: 0)
        XCTAssertEqual(button.label, label)
        try reveal(button)
        try waitEnabled(button)
        button.tap()
    }

    private func waitRecordStatus(_ status: String, kind: String, id: String) throws {
        let element = app.staticTexts.matching(identifier: "siyue-record-status-\(kind)-\(id)").firstMatch
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND label == %@", status), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed)
    }

    private func textField(_ label: String) -> XCUIElement {
        let multiline = app.textViews[label]
        return multiline.exists ? multiline : app.textFields[label]
    }

    private func replace(field label: String, with text: String) throws {
        let field = textField(label)
        let labelAnchor = app.staticTexts.matching(identifier: label).firstMatch
        try reveal(field, directionAnchor: labelAnchor)
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != field.placeholderValue {
            // Prefer the already reachable field. A strict centering loop can fight keyboard avoidance.
            var selectAll = openSelectAll(field, allowDoubleTap: false)
            if selectAll == nil {
                try positionForEditMenu(field, directionAnchor: labelAnchor)
                selectAll = openSelectAll(field, allowDoubleTap: true)
            }
            guard let selectAll = selectAll else {
                XCTFail("Edit menu must expose an explicit Select All/全选 action; unknown text was not overwritten.")
                throw NSError(domain: "SiyueUITests", code: 4)
            }
            XCTAssertEqual(field.value as? String, current, "Positioning and selection must not alter the existing text.")
            selectAll.tap()
        }
        field.typeText(text)
        XCTAssertEqual(field.value as? String, text, "Input replacement must be exact.")
        if app.keyboards.firstMatch.exists {
            try scrollMain(up: true)
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
            XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 5), .completed,
                           "Dragging the main content must dismiss the keyboard before revealing the next control.")
        }
    }

    private func positionForEditMenu(_ field: XCUIElement, directionAnchor: XCUIElement) throws {
        // Dismiss via the app's on-drag behavior even when a third-party keyboard exposes no Keyboard AX node.
        try scrollMain(up: true)
        if app.keyboards.firstMatch.exists {
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
            XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 5), .completed)
        }
        for _ in 0..<4 {
            let scroll = try mainScroll()
            let viewport = scroll.frame
            let offset = directionAnchor.frame.midY - (viewport.minY + viewport.height * 0.40)
            if field.isHittable && abs(offset) <= viewport.height * 0.12 { break }
            let distance = min(0.35, max(0.10, abs(offset) / viewport.height))
            let startY: CGFloat = offset > 0 ? 0.70 : 0.30
            let endY = startY + (offset > 0 ? -distance : distance)
            let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: startY))
            let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: endY))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        try reveal(field, directionAnchor: directionAnchor)
        field.tap() // Exactly one refocus after scrolling; try its menu without imposing another position threshold.
    }

    private func openSelectAll(_ field: XCUIElement, allowDoubleTap: Bool) -> XCUIElement? {
        if let action = editAction(["Select All", "全选", "全選"]) { return action }
        guard field.isHittable else { return nil }
        field.press(forDuration: 1.2)
        var action = waitForEditAction(["Select All", "全选", "全選"], seconds: 2)
        if action == nil, let select = editAction(["Select", "选择", "選取"]) {
            select.tap()
            action = waitForEditAction(["Select All", "全选", "全選"], seconds: 2)
        }
        if action == nil && allowDoubleTap && field.isHittable {
            field.doubleTap()
            action = waitForEditAction(["Select All", "全选", "全選"], seconds: 3)
        }
        return action
    }

    private func editAction(_ labels: [String]) -> XCUIElement? {
        let predicate = NSPredicate(format: "label IN %@", labels)
        for query in [app.menuItems.matching(predicate), app.buttons.matching(predicate)] {
            let matches = query.allElementsBoundByIndex.filter { $0.isHittable && $0.isEnabled }
            XCTAssertLessThanOrEqual(matches.count, 1, "Refuse an ambiguous edit-menu action.")
            if matches.count == 1 { return matches[0] }
        }
        return nil
    }

    private func waitForEditAction(_ labels: [String], seconds: TimeInterval) -> XCUIElement? {
        if let action = editAction(labels) { return action }
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate { [self] _, _ in editAction(labels) != nil }, object: app)
        guard XCTWaiter.wait(for: [visible], timeout: seconds) == .completed else { return nil }
        return editAction(labels)
    }

    private func tapButton(_ label: String) throws {
        let button = app.buttons[label]
        try reveal(button)
        try waitEnabled(button)
        button.tap()
    }

    private func waitEnabled(_ element: XCUIElement) throws {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed)
    }

    private func waitForRecord(_ title: String) throws {
        let record = app.staticTexts.matching(identifier: title).firstMatch
        XCTAssertTrue(record.waitForExistence(timeout: timeout), "Formal record missing: \(title)")
        try reveal(record)
    }

    private func goalCount() -> Int {
        let header = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "目标 · [0-9]+" )).firstMatch
        let emptyTitle = app.staticTexts.matching(identifier: "第一步，可以很小。").firstMatch
        let emptyMessage = app.staticTexts.matching(identifier: "确认一个计划后，目标和行动会出现在这里。").firstMatch
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            header.exists || (emptyTitle.exists && emptyMessage.exists)
        }, object: app)
        guard XCTWaiter.wait(for: [loaded], timeout: timeout) == .completed else {
            XCTFail("Neither the formal goal count nor the verified empty state is accessible; absence is not zero goals.")
            return -1
        }
        if header.exists {
            guard let count = Int(header.label.components(separatedBy: " · ").last ?? ""), count > 0 else {
                XCTFail("Formal goal count could not be parsed: \(header.label)")
                return -1
            }
            XCTAssertFalse(emptyTitle.exists && emptyMessage.exists, "Count and empty state must not contradict each other.")
            return count
        }
        XCTAssertTrue(emptyTitle.exists && emptyMessage.exists)
        return 0
    }

    /// React Native may flatten accessibility ancestry. Associate the unique synthetic title
    /// with exactly one identified task-row frame, then address controls by its stable record ID.
    private func taskRow(_ title: String) throws -> XCUIElement {
        let titleElement = app.staticTexts.matching(identifier: title).firstMatch
        try reveal(titleElement)
        let candidates = app.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH %@", "siyue-record-task-")).allElementsBoundByIndex.filter {
            $0.frame.contains(titleElement.frame)
        }
        guard candidates.count == 1, let row = candidates.first else {
            XCTFail("Expected exactly one identified task row containing the unique title \(title), found \(candidates.count); refusing an unrelated action.")
            throw NSError(domain: "SiyueUITests", code: 1)
        }
        return row
    }

    private func taskButton(title: String) throws -> XCUIElement {
        let row = try taskRow(title)
        let recordID = String(row.identifier.dropFirst("siyue-record-task-".count))
        let buttons = app.buttons.matching(identifier: "siyue-task-toggle-\(recordID)")
        guard !recordID.isEmpty, buttons.count == 1 else {
            XCTFail("Expected one task toggle for the identified record, refusing an ambiguous action.")
            throw NSError(domain: "SiyueUITests", code: 1)
        }
        return buttons.element(boundBy: 0)
    }

    private func tapTaskAction(_ action: String, title: String) throws {
        let button = try taskButton(title: title)
        XCTAssertEqual(button.label, action)
        try reveal(button)
        try waitEnabled(button)
        button.tap()
    }

    private func waitTaskStatus(_ status: String, title: String) throws {
        let row = try taskRow(title)
        let recordID = String(row.identifier.dropFirst("siyue-record-task-".count))
        let statusElement = app.staticTexts.matching(identifier: "siyue-record-status-task-\(recordID)").firstMatch
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND label == %@", status), object: statusElement)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed)
        XCTAssertEqual(try taskButton(title: title).label, "撤销完成")
    }

    private func reveal(_ element: XCUIElement, directionAnchor: XCUIElement? = nil) throws {
        XCTAssertTrue(element.exists || element.waitForExistence(timeout: timeout), "Missing accessible control: \(element)")
        if let anchor = directionAnchor {
            XCTAssertTrue(anchor.exists || anchor.waitForExistence(timeout: timeout), "Missing field-label scroll anchor.")
        }
        for attempt in 0..<40 {
            // A label only supplies direction; the actual input/control must be hittable before any tap.
            if element.isHittable { return }
            let scroll = try mainScroll()
            let anchor = directionAnchor ?? element
            let anchorFrame = anchor.frame
            print("Reveal attempt \(attempt): control=\(element.label) frame=\(element.frame); direction anchor frame=\(anchorFrame); scroll frame=\(scroll.frame)")
            try scrollMain(up: anchorFrame.midY >= scroll.frame.midY)
        }
        XCTFail("Control could not be revealed within 40 swipes; no unrelated control was tapped.")
        throw NSError(domain: "SiyueUITests", code: 2)
    }

    private func mainScroll() throws -> XCUIElement {
        let container = app.otherElements["siyue-main-scroll"]
        guard container.exists || container.waitForExistence(timeout: timeout) else {
            XCTFail("The identified main content container is missing; refusing to swipe keyboard or nested input scroll views.")
            throw NSError(domain: "SiyueUITests", code: 3)
        }
        // React Native exposes testID on the wrapping Other, with one direct native ScrollView child.
        let scrolls = container.children(matching: .scrollView)
        guard scrolls.count == 1 else {
            XCTFail("Expected exactly one direct main ScrollView child, found \(scrolls.count); refusing ambiguous scrolling.")
            throw NSError(domain: "SiyueUITests", code: 3)
        }
        return scrolls.element(boundBy: 0)
    }

    private func scrollMain(up: Bool) throws {
        let scroll = try mainScroll()
        // The outer content padding avoids dragging a nested multiline TextInput.
        // The named ScrollView excludes the keyboard candidate bar observed in the first simulator failure.
        let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: up ? 0.75 : 0.25))
        let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: up ? 0.25 : 0.75))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
