import XCTest

/// Drives only the separately bundled QA application and preserves every synthetic case database.
final class NativeRecoveryUITests: XCTestCase {
    private var app: XCUIApplication!
    private let timeout: TimeInterval = 30
    private var recordingFailure = false

    private struct Journal: Decodable {
        let metadataOnly: Bool
        let beforeExecute: Bool
        let beforeReceipt: Bool
        let commandId: String
        let issuedAt: String
        let pendingCount: Int
        let cleanupAfterReceiptValidation: Bool
    }

    private struct Result: Decodable {
        let schemaVersion: Int
        let caseId: String
        let phase: String
        let processSession: String
        let commandId: String
        let issuedAt: String
        let spaceId: String
        let goalId: String
        let projectId: String
        let taskId: String
        let counts: [String: Int]
        let stateDigest: String
        let metadataPersisted: Bool
        let executeCalls: Int
        let receiptCalls: Int
        let cleanupCalls: Int
        let journal: Journal
        let receiptValidated: Bool
        let trace: [String]
    }

    private struct StorageResult: Decodable {
        struct Rollback: Decodable {
            let databaseName: String
            let commandId: String
            let baselineCounts: [String: Int]
            let insideCounts: [String: Int]
            let afterRollbackCounts: [String: Int]
            let afterReopenCounts: [String: Int]
            let afterRetryCounts: [String: Int]
            let afterDuplicateCounts: [String: Int]
            let insideWriteObserved: Bool
            let observerSawBaseline: Bool
            let rollbackRawEqual: Bool
            let reopenRawEqual: Bool
            let retryReceiptEqual: Bool
            let baselineDigest: String
            let rollbackDigest: String
            let reopenDigest: String
            let finalDigest: String
        }
        struct RejectedStorage: Decodable {
            let databaseName: String
            let errorCode: String
            let beforeDigest: String
            let afterDigest: String
            let reopenDigest: String
            let rawPreserved: Bool
        }
        struct Cases: Decodable {
            let rollback: Rollback
            let corrupt: RejectedStorage
            let future: RejectedStorage
        }
        let schemaVersion: Int
        let caseId: String
        let phase: String
        let kind: String
        let status: String
        let cases: Cases
    }

    private struct RunObservation: Decodable, Equatable {
        struct Event: Decodable, Equatable {
            let schemaVersion: Int
            let runId: String
            let seq: Int
            let state: String
            let time: String
        }
        struct Run: Decodable, Equatable {
            let id: String
            let status: String
            let seq: Int
            let events: [Event]
            let draftId: String?
        }
        let schemaVersion: Int
        let caseId: String
        let processSession: String
        let spaceId: String
        let counts: [String: Int]
        let runs: [Run]
        let pendingCount: Int
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "app.siyue.mobile.qa")
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        if app.state != .notRunning {
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: timeout))
        }
        try launchQA()
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    override func record(_ issue: XCTIssue) {
        if !recordingFailure, app != nil {
            recordingFailure = true
            capture("Native recovery failure")
            // Preserve any visible structured output even if its decoding/assertion failed.
            for identifier in ["siyue-qa-result", "siyue-qa-run-result"] {
                for (index, raw) in resultTexts(identifier: identifier).sorted().enumerated() {
                    attachJSON(Data(raw.utf8), name: "failure-\(identifier)-\(index).json")
                }
            }
            recordingFailure = false
        }
        super.record(issue)
    }

    func testLostReceiptRecoversAcrossTermination() throws {
        let caseID = UUID().uuidString.lowercased()
        try enterCase(caseID)
        try tapPhase("siyue-qa-inject")
        let injected = try readResult(phase: "injected", caseID: caseID)
        assertCommon(injected, caseID: caseID)
        XCTAssertEqual(injected.executeCalls, 1)
        XCTAssertEqual(injected.receiptCalls, 1)
        XCTAssertEqual(injected.cleanupCalls, 0)
        XCTAssertFalse(injected.receiptValidated)
        XCTAssertTrue(injected.journal.beforeExecute)
        XCTAssertEqual(injected.journal.pendingCount, 1)
        XCTAssertFalse(injected.journal.cleanupAfterReceiptValidation)
        XCTAssertEqual(injected.trace, ["journal_present_before_execute", "sqlite_commit_observed", "response_lost",
                                        "journal_present_before_receipt", "receipt_temporarily_unavailable"])
        capture("Committed with pending response")

        XCTAssertEqual(app.state, .runningForeground, "QA must actually be running before the process boundary.")
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: timeout), "QA must terminate, not merely enter the background.")
        XCTAssertEqual(app.state, .notRunning)
        try launchQA()
        let freshField = try caseField()
        XCTAssertEqual(freshField.value as? String ?? "", "", "Case ID must be explicitly re-entered after restart; this is not automatic form recovery.")
        try enterCase(caseID)
        try tapPhase("siyue-qa-recover")
        let recovered = try readResult(phase: "recovered", caseID: caseID)
        assertCommon(recovered, caseID: caseID)
        XCTAssertNotEqual(injected.processSession, recovered.processSession, "Recovery must run in a fresh JavaScript process session.")
        XCTAssertEqual(recovered.commandId, injected.commandId)
        XCTAssertEqual(recovered.issuedAt, injected.issuedAt)
        XCTAssertEqual(recovered.spaceId, injected.spaceId)
        XCTAssertEqual(recovered.goalId, injected.goalId)
        XCTAssertEqual(recovered.projectId, injected.projectId)
        XCTAssertEqual(recovered.taskId, injected.taskId)
        XCTAssertEqual(recovered.stateDigest, injected.stateDigest, "Reconciliation must preserve the full formal SQLite snapshot.")
        XCTAssertEqual(recovered.counts, injected.counts)
        XCTAssertEqual(recovered.executeCalls, 0, "Receipt reconciliation must not execute the command again.")
        XCTAssertEqual(recovered.receiptCalls, 1)
        XCTAssertEqual(recovered.cleanupCalls, 1)
        XCTAssertTrue(recovered.receiptValidated)
        XCTAssertFalse(recovered.journal.beforeExecute)
        XCTAssertEqual(recovered.journal.pendingCount, 0)
        XCTAssertTrue(recovered.journal.cleanupAfterReceiptValidation)
        XCTAssertEqual(recovered.trace, ["journal_present_before_receipt", "original_receipt_validated",
                                         "journal_present_until_validated", "journal_cleared"])
        capture("Original receipt reconciled after relaunch")
    }

    func testStorageFaultsPreserveData() throws {
        let caseID = UUID().uuidString.lowercased()
        try enterCase(caseID)
        try tapPhase("siyue-qa-storage")
        let data = try readResultData(phase: "storage", caseID: caseID)
        let result = try JSONDecoder().decode(StorageResult.self, from: data)
        XCTAssertEqual(result.schemaVersion, 1)
        XCTAssertEqual(result.caseId, caseID)
        XCTAssertEqual(result.phase, "storage")
        XCTAssertEqual(result.kind, "storage-faults")
        XCTAssertEqual(result.status, "passed")
        let rollback = result.cases.rollback
        let names = [rollback.databaseName, result.cases.corrupt.databaseName, result.cases.future.databaseName]
        XCTAssertEqual(Set(names).count, 3, "Each fault must use a distinct synthetic database.")
        for name in names {
            XCTAssertTrue(name.hasPrefix("siyue-native-storage-\(caseID)-") && name.hasSuffix(".db") && !name.contains("/"))
        }
        XCTAssertEqual(UUID(uuidString: rollback.commandId)?.uuidString.lowercased(), rollback.commandId)
        let one = ["goals": 1, "projects": 1, "tasks": 1, "events": 1, "receipts": 1]
        let two = ["goals": 2, "projects": 2, "tasks": 2, "events": 2, "receipts": 2]
        XCTAssertEqual(rollback.baselineCounts, one)
        XCTAssertEqual(rollback.insideCounts, two, "The transaction must actually observe its attempted formal write.")
        XCTAssertEqual(rollback.afterRollbackCounts, one)
        XCTAssertEqual(rollback.afterReopenCounts, one)
        XCTAssertEqual(rollback.afterRetryCounts, two)
        XCTAssertEqual(rollback.afterDuplicateCounts, two, "Duplicate delivery must not create a third write.")
        XCTAssertTrue(rollback.insideWriteObserved)
        XCTAssertTrue(rollback.observerSawBaseline, "The independent connection must not observe the uncommitted write.")
        XCTAssertTrue(rollback.rollbackRawEqual)
        XCTAssertTrue(rollback.reopenRawEqual)
        XCTAssertTrue(rollback.retryReceiptEqual)
        for digest in [rollback.baselineDigest, rollback.rollbackDigest, rollback.reopenDigest, rollback.finalDigest] {
            XCTAssertNotNil(digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression))
        }
        XCTAssertEqual(rollback.baselineDigest, rollback.rollbackDigest)
        XCTAssertEqual(rollback.baselineDigest, rollback.reopenDigest)
        XCTAssertNotEqual(rollback.finalDigest, rollback.baselineDigest, "The later successful retry must change the persisted snapshot.")
        for (storage, errorCode) in [(result.cases.corrupt, "corrupt_data"), (result.cases.future, "unsupported_schema")] {
            XCTAssertEqual(storage.errorCode, errorCode)
            XCTAssertTrue(storage.rawPreserved)
            for digest in [storage.beforeDigest, storage.afterDigest, storage.reopenDigest] {
                XCTAssertNotNil(digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression))
            }
            XCTAssertEqual(storage.beforeDigest, storage.afterDigest)
            XCTAssertEqual(storage.beforeDigest, storage.reopenDigest)
        }
        capture("Storage rollback and rejected database contents preserved")
    }

    func testNormalUiCancellationAndGenerationRestart() throws {
        let caseID = UUID().uuidString.lowercased()
        try openRunUI(caseID)
        try enterRunGoal("cancel", replacing: "")
        try tapRunButton("siyue-generate")
        let running = try observeRun("running-before-cancel", caseID: caseID)
        assertEmptyFormal(running)
        XCTAssertEqual(running.runs.count, 1)
        try assertRun(running, index: 0, status: "running", seq: 1)

        try tapPhase("siyue-qa-run-back")
        try tapRunButton("siyue-cancel-generation")
        let error = app.descendants(matching: .any).matching(identifier: "siyue-error-message").firstMatch
        XCTAssertTrue(error.exists || error.waitForExistence(timeout: timeout))
        try revealRun(error)
        XCTAssertEqual(error.label, "生成已取消，输入仍然保留。")
        let goal = try runGoalField()
        try revealRun(goal, directionAnchor: app.staticTexts.matching(identifier: "我的目标").firstMatch)
        XCTAssertEqual(goal.value as? String, "cancel", "The normal cancellation UI must retain the actual input.")
        try assertRunButtonEnabled("siyue-manual-create")
        let cancelled = try observeRun("cancelled", caseID: caseID)
        assertEmptyFormal(cancelled)
        XCTAssertEqual(cancelled.runs.count, 1)
        try assertRun(cancelled, index: 0, status: "cancelled", seq: 2)
        XCTAssertEqual(running.runs[0].id, cancelled.runs[0].id)

        // Wait beyond the original 20-second provider delay; late draft/formal writes must remain absent.
        let deadline = Date().addingTimeInterval(21)
        let elapsed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in Date() >= deadline }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [elapsed], timeout: 25), .completed)
        let late = try observeRun("cancelled-after-provider-deadline", caseID: caseID)
        XCTAssertEqual(late, cancelled, "No late provider completion may alter the cancelled SQLite snapshot.")

        try tapPhase("siyue-qa-run-back")
        try enterRunGoal("kill", replacing: "cancel")
        try tapRunButton("siyue-generate")
        let beforeKill = try observeRun("running-before-kill", caseID: caseID)
        assertEmptyFormal(beforeKill)
        XCTAssertEqual(beforeKill.runs.count, 2)
        try assertRun(beforeKill, index: 1, status: "running", seq: 1)
        XCTAssertEqual(beforeKill.runs[0], cancelled.runs[0])
        let originalRunID = beforeKill.runs[1].id
        try terminateRunningQA()
        try launchQA()
        try openRunUI(caseID)
        let recovered = try observeRun("interrupted-after-kill", caseID: caseID)
        XCTAssertNotEqual(recovered.processSession, beforeKill.processSession)
        XCTAssertEqual(recovered.spaceId, beforeKill.spaceId)
        assertEmptyFormal(recovered)
        XCTAssertEqual(recovered.runs.count, 2, "Restart must not automatically generate a new run.")
        try assertRun(recovered, index: 0, status: "cancelled", seq: 2)
        try assertRun(recovered, index: 1, status: "interrupted", seq: 2)
        XCTAssertEqual(recovered.runs[0], cancelled.runs[0])
        XCTAssertEqual(recovered.runs[1].id, originalRunID)
        try tapPhase("siyue-qa-run-back")
        let status = app.descendants(matching: .any).matching(identifier: "siyue-run-status").firstMatch
        try revealRun(status)
        XCTAssertTrue(status.label.contains("上次生成已中断，没有自动重试"))
        try assertRunButtonEnabled("siyue-manual-create")

        try terminateRunningQA()
        try launchQA()
        try openRunUI(caseID)
        let again = try observeRun("interrupted-second-restart", caseID: caseID)
        XCTAssertNotEqual(again.processSession, recovered.processSession)
        XCTAssertEqual(again.spaceId, recovered.spaceId)
        XCTAssertEqual(again.runs, recovered.runs, "A second restart must not append another interrupted event or run.")
        assertEmptyFormal(again)
    }

    private func openRunUI(_ caseID: String) throws {
        try enterCase(caseID)
        try tapPhase("siyue-qa-run-ui")
        let local = app.descendants(matching: .any).matching(identifier: "siyue-local-state").firstMatch
        XCTAssertTrue(local.exists || local.waitForExistence(timeout: timeout))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in local.label == "本机空间 · 离线可用" }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed)
    }

    private func terminateRunningQA() throws {
        XCTAssertEqual(app.state, .runningForeground)
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: timeout))
        XCTAssertEqual(app.state, .notRunning)
    }

    private func runGoalField() throws -> XCUIElement {
        let fields = app.textFields.matching(identifier: "siyue-goal-input")
        let views = app.textViews.matching(identifier: "siyue-goal-input")
        guard fields.count + views.count == 1 else {
            XCTFail("Expected exactly one normal goal input.")
            throw failure("Ambiguous normal goal input")
        }
        return fields.count == 1 ? fields.element(boundBy: 0) : views.element(boundBy: 0)
    }

    private func enterRunGoal(_ value: String, replacing previous: String) throws {
        let input = try runGoalField()
        let anchor = app.staticTexts.matching(identifier: "我的目标").firstMatch
        try revealRun(input, directionAnchor: anchor)
        XCTAssertEqual(input.value as? String ?? "", previous, "Only replace the previously verified synthetic input.")
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.exists || app.keyboards.firstMatch.waitForExistence(timeout: timeout))
        if !previous.isEmpty {
            input.press(forDuration: 1.2)
            let selectAll = app.menuItems["Select All"].exists ? app.menuItems["Select All"] : app.buttons["Select All"]
            if !selectAll.waitForExistence(timeout: 2) {
                let select = app.menuItems["Select"].exists ? app.menuItems["Select"] : app.buttons["Select"]
                if select.exists { select.tap() }
            }
            XCTAssertTrue(selectAll.waitForExistence(timeout: 3))
            selectAll.tap()
        }
        var prefix = ""
        for character in value {
            input.typeText(String(character))
            prefix.append(character)
            let expected = prefix
            let accepted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in input.value as? String == expected }, object: input)
            XCTAssertEqual(XCTWaiter.wait(for: [accepted], timeout: 5), .completed)
        }
        XCTAssertEqual(input.value as? String, value)
        if app.keyboards.firstMatch.exists {
            try scrollRun(towardBottom: true)
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
            XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 5), .completed)
        }
        // Reveal before starting the timed provider; UI navigation must not consume the cancellation window.
        try revealRun(app.buttons.matching(identifier: "siyue-generate").firstMatch)
    }

    private func mainRunScroll() throws -> XCUIElement {
        let containers = app.otherElements.matching(identifier: "siyue-main-scroll")
        guard containers.count == 1 else {
            XCTFail("Missing or ambiguous identified normal content; never swipe the keyboard or QA observation panel.")
            throw failure("Missing normal main scroll")
        }
        let scrolls = containers.element(boundBy: 0).children(matching: .scrollView)
        guard scrolls.count == 1 else {
            XCTFail("Expected the identified container's single direct native ScrollView.")
            throw failure("Ambiguous normal main scroll")
        }
        let scroll = scrolls.element(boundBy: 0)
        XCTAssertGreaterThan(scroll.frame.height, 100)
        return scroll
    }

    private func scrollRun(towardBottom: Bool) throws {
        let scroll = try mainRunScroll()
        let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: towardBottom ? 0.75 : 0.25))
        let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: towardBottom ? 0.25 : 0.75))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    private func revealRun(_ element: XCUIElement, directionAnchor: XCUIElement? = nil) throws {
        XCTAssertTrue(element.exists || element.waitForExistence(timeout: timeout))
        if let anchor = directionAnchor { XCTAssertTrue(anchor.exists || anchor.waitForExistence(timeout: timeout)) }
        for _ in 0..<20 {
            if element.isHittable { return }
            let scroll = try mainRunScroll()
            let anchor = directionAnchor ?? element
            try scrollRun(towardBottom: anchor.frame.midY >= scroll.frame.midY)
        }
        XCTFail("Normal control did not become hittable within bounded main-content scrolling.")
        throw failure("Normal control could not be revealed")
    }

    private func assertRunButtonEnabled(_ identifier: String) throws {
        let buttons = app.buttons.matching(identifier: identifier)
        XCTAssertEqual(buttons.count, 1)
        let button = buttons.element(boundBy: 0)
        try revealRun(button)
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: button)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed)
    }

    private func tapRunButton(_ identifier: String) throws {
        try assertRunButtonEnabled(identifier)
        app.buttons.matching(identifier: identifier).element(boundBy: 0).tap()
    }

    private func observeRun(_ label: String, caseID: String) throws -> RunObservation {
        try tapPhase("siyue-qa-run-observe")
        let error = app.descendants(matching: .any).matching(identifier: "siyue-qa-run-error").firstMatch
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { [self] _, _ in
            error.exists || !resultTexts(identifier: "siyue-qa-run-result").isEmpty
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed)
        guard !error.exists else {
            XCTFail("SQL run observation failed: \(error.label)")
            throw failure("Run observation failed")
        }
        let values = resultTexts(identifier: "siyue-qa-run-result")
        guard values.count == 1, let raw = values.first else {
            XCTFail("Expected exactly one complete SQL run observation JSON.")
            throw failure("Ambiguous run JSON")
        }
        let data = Data(raw.utf8)
        attachJSON(data, name: "\(label).json")
        let result = try JSONDecoder().decode(RunObservation.self, from: data)
        XCTAssertEqual(result.schemaVersion, 1)
        XCTAssertEqual(result.caseId, caseID)
        XCTAssertNotNil(UUID(uuidString: result.processSession))
        XCTAssertNotNil(UUID(uuidString: result.spaceId))
        capture(label)
        return result
    }

    private func assertEmptyFormal(_ result: RunObservation) {
        XCTAssertEqual(result.counts, ["goals": 0, "projects": 0, "tasks": 0, "events": 0, "receipts": 0, "drafts": 0, "approvals": 0])
        XCTAssertEqual(result.pendingCount, 0)
    }

    private func assertRun(_ result: RunObservation, index: Int, status: String, seq: Int) throws {
        guard result.runs.indices.contains(index) else {
            XCTFail("Expected real persisted run at index \(index).")
            throw failure("Missing persisted run")
        }
        let run = result.runs[index]
        XCTAssertNotNil(UUID(uuidString: run.id))
        XCTAssertEqual(run.status, status)
        XCTAssertEqual(run.seq, seq)
        XCTAssertNil(run.draftId)
        XCTAssertEqual(run.events.count, seq)
        for (index, event) in run.events.enumerated() {
            XCTAssertEqual(event.schemaVersion, 1)
            XCTAssertEqual(event.runId, run.id)
            XCTAssertEqual(event.seq, index + 1)
            XCTAssertEqual(event.state, index == 0 ? "running" : status)
        }
    }

    private func assertCommon(_ result: Result, caseID: String) {
        XCTAssertEqual(result.schemaVersion, 1)
        XCTAssertEqual(result.caseId, caseID)
        XCTAssertTrue(result.metadataPersisted, "Original command and receipt must be read back from fixture SQLite.")
        for identifier in [result.commandId, result.spaceId, result.goalId, result.projectId, result.taskId, result.processSession] {
            XCTAssertEqual(UUID(uuidString: identifier)?.uuidString.lowercased(), identifier, "Expected a canonical UUID identity.")
        }
        XCTAssertNotNil(result.stateDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression))
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        XCTAssertNotNil(formatter.date(from: result.issuedAt), "Issued time must be a valid original ISO timestamp.")
        XCTAssertEqual(result.counts, ["goals": 1, "projects": 1, "tasks": 1, "events": 1, "receipts": 1],
                       "Actual SQLite snapshot must contain one of each formal record, event and receipt.")
        XCTAssertTrue(result.journal.metadataOnly)
        XCTAssertTrue(result.journal.beforeReceipt)
        XCTAssertEqual(result.journal.commandId, result.commandId)
        XCTAssertEqual(result.journal.issuedAt, result.issuedAt)
    }

    private func launchQA() throws {
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: timeout))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "siyue-qa-ready").firstMatch.waitForExistence(timeout: timeout))
        _ = try caseField()
    }

    private func caseField() throws -> XCUIElement {
        let fields = app.textFields.matching(identifier: "siyue-qa-case")
        let views = app.textViews.matching(identifier: "siyue-qa-case")
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in fields.count + views.count > 0 }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed)
        guard fields.count + views.count == 1 else {
            XCTFail("Expected exactly one QA input; refusing an ambiguous action.")
            throw failure("Ambiguous QA input")
        }
        return fields.count == 1 ? fields.element(boundBy: 0) : views.element(boundBy: 0)
    }

    private func enterCase(_ value: String) throws {
        let input = try caseField()
        XCTAssertEqual(input.value as? String ?? "", "", "Fresh QA input must be empty; do not overwrite unknown text.")
        XCTAssertTrue(input.isHittable)
        input.tap()
        let keyboard = app.keyboards.firstMatch
        let keyboardReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            keyboard.exists && keyboard.keys.count > 0
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [keyboardReady], timeout: timeout), .completed,
                       "Wait for actual keyboard keys before typing into the controlled input.")
        var expectedPrefix = ""
        for character in value {
            input.typeText(String(character))
            expectedPrefix.append(character)
            let expected = expectedPrefix
            let accepted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                input.value as? String == expected
            }, object: input)
            XCTAssertEqual(XCTWaiter.wait(for: [accepted], timeout: 5), .completed,
                           "Each character must be reflected exactly before sending the next; do not overwrite a mismatched input.")
            XCTAssertEqual(input.value as? String, expected)
        }
        XCTAssertEqual(input.value as? String, value)
    }

    private func tapPhase(_ identifier: String) throws {
        let buttons = app.buttons.matching(identifier: identifier)
        XCTAssertTrue(buttons.firstMatch.waitForExistence(timeout: timeout))
        guard buttons.count == 1 else {
            XCTFail("Expected exactly one identified QA phase button.")
            throw failure("Ambiguous QA phase button")
        }
        let button = buttons.element(boundBy: 0)
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true AND hittable == true"), object: button)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed)
        // The QA ScrollView handles button taps while the keyboard is open. Do not assume drag dismisses it.
        button.tap()
    }

    private func resultTexts(identifier: String = "siyue-qa-result") -> Set<String> {
        var values = Set<String>()
        // RN may expose parent/child duplicates or selectable text as a TextView. Read-only duplicates
        // must contain the same complete JSON; controls above still require a unique typed match.
        for element in app.descendants(matching: .any).matching(identifier: identifier).allElementsBoundByIndex {
            for raw in [element.label, element.value as? String ?? ""] where raw.hasPrefix("{") {
                values.insert(raw)
            }
        }
        return values
    }

    private func readResult(phase: String, caseID: String) throws -> Result {
        let data = try readResultData(phase: phase, caseID: caseID)
        let result = try JSONDecoder().decode(Result.self, from: data)
        XCTAssertEqual(result.phase, phase)
        XCTAssertEqual(result.caseId, caseID)
        return result
    }

    private func readResultData(phase: String, caseID: String) throws -> Data {
        let error = app.descendants(matching: .any).matching(identifier: "siyue-qa-error").firstMatch
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { [self] _, _ in error.exists || !resultTexts().isEmpty }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: timeout), .completed,
                       "Native result JSON is required; a phase status label is insufficient.")
        guard !error.exists else {
            XCTFail("Native QA failed: \(error.label)")
            throw failure("Native SQLite QA reported failure")
        }
        let values = resultTexts()
        guard values.count == 1, let raw = values.first else {
            XCTFail("Expected one complete, unambiguous native result JSON.")
            throw failure("Missing or conflicting native JSON")
        }
        let data = Data(raw.utf8)
        attachJSON(data, name: "\(phase).json")
        let value = try JSONSerialization.jsonObject(with: data)
        let envelope = try XCTUnwrap(value as? [String: Any], "Expected a JSON result object.")
        XCTAssertEqual(envelope["phase"] as? String, phase)
        XCTAssertEqual(envelope["caseId"] as? String, caseID)
        return data
    }

    private func attachJSON(_ data: Data, name: String) {
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func capture(_ name: String) {
        guard let app = app else { return }
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "\(name) - accessibility debugDescription"
        tree.lifetime = .keepAlways
        add(tree)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private func failure(_ description: String) -> NSError {
        NSError(domain: "NativeRecoveryUITests", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
    }
}
