import XCTest
import UIKit
import Foundation

/// Screen-driven registration for the isolated account QA app.
///
/// The real sign-in form opens the real registration step, the code comes from the loopback QA fixture,
/// and the same run then proves the session survives a cold launch and that the account the screen just
/// created can be deleted. The fixture never creates an account, and `qa/account` is read before and
/// after the confirm, so a passing run is evidence the screen performed the request and the confirm.
/// This is local-fixture evidence only: it is not production, real mail delivery or device acceptance.
final class RegistrationUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "app.siyue.mobile.accountqa")
    private let fixture = URL(string: "http://127.0.0.1:18787")!
    private let password = "siyue registration pass 2026"
    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    private func shot(_ name: String) {
        let item = XCTAttachment(screenshot: app.screenshot())
        item.name = name; item.lifetime = .keepAlways; add(item)
    }
    private func attach(_ text: String, _ name: String) {
        let item = XCTAttachment(string: text)
        item.name = name; item.lifetime = .keepAlways; add(item)
    }
    private func failure(_ text: String) -> NSError {
        NSError(domain: "RegistrationUITests", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
    private func element(_ label: String) -> XCUIElement {
        let match = NSPredicate(format: "identifier == %@ OR label == %@", label, label)
        let controls = app.buttons.matching(match)
        let candidates = controls.count > 0 ? controls : app.descendants(matching: .any).matching(match)
        for candidate in candidates.allElementsBoundByIndex where candidate.isHittable { return candidate }
        return candidates.firstMatch
    }
    private func dismissSystemPrompts() {
        // The system password prompt follows a successful keyboard entry in either system language, and
        // only its dismiss option is ever chosen: this QA suite must never store a synthetic password in
        // the system password store.
        for label in ["Not Now", "以后再说", "稍后"] {
            let candidate = app.buttons[label]
            if candidate.exists && candidate.isHittable { candidate.tap() }
        }
    }
    private func show(_ element: XCUIElement) {
        dismissSystemPrompts()
        for _ in 0..<4 { if element.exists && element.isHittable { return }; app.swipeUp() }
        for _ in 0..<4 { if element.exists && element.isHittable { return }; app.swipeDown() }
    }
    private func tap(_ label: String) {
        let target = element(label)
        XCTAssertTrue(target.waitForExistence(timeout: 60), "Missing control: \(label)\n\(app.debugDescription)")
        show(target)
        XCTAssertTrue(target.isHittable, "Control is not hittable: \(label)\n\(app.debugDescription)")
        target.tap()
    }
    private func waitUntil(_ timeout: TimeInterval, _ message: String, _ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if condition() { return }; Thread.sleep(forTimeInterval: 0.25) }
        XCTFail("\(message)\n\(app.debugDescription)")
    }
    private func signOutButton(_ english: Bool) -> XCUIElement { app.buttons[english ? "Sign out" : "退出登录"] }
    private func emailField(_ english: Bool) -> XCUIElement { app.textFields[english ? "Email" : "邮箱"] }
    // iPadOS keeps the software keyboard hidden while the simulator's hardware keyboard is attached and
    // only offers a system menu in the input assistant bar. Requesting it is a best effort there, so on
    // iPad the typed value and the state it reaches afterwards are the input evidence; iPhone must show
    // the software keyboard for a real keystroke.
    private func revealSoftwareKeyboard() {
        if app.keyboards.firstMatch.waitForExistence(timeout: 5) { return }
        let toggle = app.buttons["Keyboard"]
        guard toggle.waitForExistence(timeout: 3), toggle.isHittable else { return }
        toggle.tap()
        for label in ["Show Keyboard", "显示键盘"] {
            let candidate = app.buttons[label]
            if candidate.waitForExistence(timeout: 3) && candidate.isHittable { candidate.tap(); return }
        }
    }
    private func type(_ label: String, _ value: String, into field: XCUIElement, secret: Bool) {
        XCTAssertTrue(field.waitForExistence(timeout: 60), "Missing field: \(label)\n\(app.debugDescription)")
        show(field)
        XCTAssertTrue(field.isHittable, "Field is not a real tappable control: \(label)")
        field.tap()
        revealSoftwareKeyboard()
        let softwareKeyboardVisible = app.keyboards.firstMatch.waitForExistence(timeout: 15)
        attach("software keyboard visible: \(softwareKeyboardVisible); idiom pad: \(isPad); secret: \(secret)", "keyboard-\(label)")
        XCTAssertTrue(softwareKeyboardVisible || isPad, "Native keyboard must be available for real typing on iPhone")
        Thread.sleep(forTimeInterval: 0.5)
        field.typeText(value)
        if secret {
            // A secure field mirrors only a masked buffer, so presence of a value is the readable proof.
            XCTAssertFalse(((field.value as? String) ?? "").isEmpty, "The masked \(label) field must contain the typed secret")
        } else {
            XCTAssertEqual(field.value as? String, value, "The complete value must be entered into \(label)")
        }
    }
    private func replaceAndAssert(_ field: XCUIElement, with value: String) {
        XCTAssertTrue(field.exists && field.isHittable, "The input stress target must remain editable")
        field.tap()
        if !((field.value as? String) ?? "").isEmpty {
            field.press(forDuration: 1.2)
            let selectAllLabels = ["Select All", "全选", "全選"]
            let predicate = NSPredicate(format: "label IN %@", selectAllLabels)
            var selectAll = app.menuItems.matching(predicate).firstMatch
            if !selectAll.waitForExistence(timeout: 2) {
                let selectLabels = ["Select", "选择", "選取"]
                let selectPredicate = NSPredicate(format: "label IN %@", selectLabels)
                let select = app.menuItems.matching(selectPredicate).firstMatch
                if select.exists && select.isHittable { select.tap() }
                selectAll = app.menuItems.matching(predicate).firstMatch
            }
            if !selectAll.waitForExistence(timeout: 3) {
                selectAll = app.buttons.matching(predicate).firstMatch
            }
            XCTAssertTrue(selectAll.waitForExistence(timeout: 3) && selectAll.isHittable, "The code field must expose Select All before replacement")
            selectAll.tap()
        }
        field.typeText(value)
        let exactValue = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            field.value as? String == value
        }, object: field)
        XCTAssertEqual(XCTWaiter.wait(for: [exactValue], timeout: 5), .completed, "Burst typing must preserve every code digit in order; expected \(value), got \((field.value as? String) ?? "<missing>")")
    }
    /// QA-only fixture read. The fixture binds to loopback and decides access from the socket address, so
    /// this helper can never reach a deployed service, and the code is never stored in an attachment.
    private func qaResponse(_ path: String, _ query: [String: String]) throws -> (status: Int, body: [String: Any]) {
        var components = URLComponents(url: fixture.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 20
        // A forwarded address must not move the fixture's decision in either direction.
        request.setValue("203.0.113.9", forHTTPHeaderField: "X-Forwarded-For")
        let semaphore = DispatchSemaphore(value: 0)
        var status = 0, body: [String: Any] = [:], callFailure: String?
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { callFailure = error.localizedDescription }
            else {
                status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if let data = data, let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any] { body = object }
            }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 25) == .timedOut { callFailure = "timed out" }
        if let callFailure { throw failure("QA fixture request \(path) failed: \(callFailure).") }
        return (status, body)
    }
    private func qaJSON(_ path: String, _ query: [String: String]) throws -> [String: Any] {
        let answer = try qaResponse(path, query)
        guard answer.status == 200 else { throw failure("QA fixture request \(path) answered \(answer.status): \(answer.body)") }
        return answer.body
    }
    private func accountExists(_ address: String) throws -> Bool {
        let body = try qaJSON("qa/account", ["email": address])
        return body["exists"] as? Bool ?? false
    }
    /// `qa/mail/code` answers 200 only while a register challenge for this address is still pending.
    private func pendingChallengeStatus(_ address: String) throws -> Int {
        try qaResponse("qa/mail/code", ["email": address]).status
    }
    private func issuedCode(_ address: String) throws -> String {
        let body = try qaJSON("qa/mail/code", ["email": address])
        guard let code = body["code"] as? String, code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else {
            throw failure("The QA code getter returned no six-digit code for \(address); the screen's request must have queued one first.")
        }
        // The value itself stays out of the artifacts; only its shape is recorded.
        attach("fixture returned a six-digit code for the pending register challenge (value withheld)", "qa-code-length")
        return code
    }
    private func openAccount(_ english: Bool) {
        tap(english ? "QA English dark" : "QA 中文明色")
        waitUntil(90, "The account screen must settle as signed in or signed out") {
            self.signOutButton(english).exists || self.emailField(english).exists
        }
    }
    private func registerOnScreen(_ english: Bool, _ address: String) throws {
        tap(english ? "Sign up" : "注册")
        let consent = element(english ? "I have read and agree to the" : "我已阅读并同意")
        XCTAssertTrue(consent.waitForExistence(timeout: 30), "The registration step must show the consent control\n\(app.debugDescription)")
        let send = app.buttons[english ? "Send code" : "发送验证码"]
        XCTAssertTrue(send.waitForExistence(timeout: 30), "The registration step must offer the code request\n\(app.debugDescription)")
        // Nothing pre-registers this address: the fixture has no create path at all.
        XCTAssertFalse(try accountExists(address), "The isolated fixture must never pre-create an account")
        type(english ? "Email" : "邮箱", address, into: emailField(english), secret: false)
        // A real tap at the control's own location. While the released documents are not accepted the
        // product must neither queue a code nor open the verification step, so this is the gate the
        // desktop panel also has to pass.
        show(send)
        send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let code = app.textFields[english ? "Six-digit code" : "六位验证码"]
        XCTAssertFalse(code.waitForExistence(timeout: 4), "An unaccepted consent must not open the verification step\n\(app.debugDescription)")
        XCTAssertEqual(try pendingChallengeStatus(address), 404, "An unaccepted consent must not queue a verification code")
        attach("no pending challenge before consent", "qa-no-challenge-before-consent")
        show(consent); consent.tap()
        XCTAssertTrue(send.waitForExistence(timeout: 5) && send.isEnabled, "Checking consent must enable the code request\n\(app.debugDescription)")
        // The control only sends once the accepted consent reaches the product state; repeating the tap
        // until the verification step actually opens tolerates that re-render without weakening the gate.
        let deadline = Date().addingTimeInterval(60)
        var verificationOpen = false
        while Date() < deadline && !verificationOpen {
            show(send)
            if send.isHittable { send.tap() }
            verificationOpen = code.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(verificationOpen, "The accepted request must open the verification step\n\(app.debugDescription)")
        shot(english ? "en-register-verify" : "zh-register-verify")
        type(english ? "Six-digit code" : "六位验证码", try issuedCode(address), into: code, secret: false)
        type(english ? "Password" : "密码", password, into: app.secureTextFields[english ? "Password" : "密码"], secret: true)
        type(english ? "Repeat new password" : "再次输入新密码", password, into: app.secureTextFields[english ? "Repeat new password" : "再次输入新密码"], secret: true)
        tap(english ? "Create account" : "创建账号")
        XCTAssertTrue(signOutButton(english).waitForExistence(timeout: 120), "The screen must complete the confirm and reach the authenticated state\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[english ? "Signed in" : "已登录"].exists, app.debugDescription)
        XCTAssertTrue(try accountExists(address), "The screen's confirm, not the fixture, must have created the account")
        shot(english ? "en-register-done" : "zh-register-done")
    }
    private func assertColdLaunchRestores(_ english: Bool) {
        app.terminate(); app.launch()
        openAccount(english)
        XCTAssertTrue(signOutButton(english).waitForExistence(timeout: 90), "A cold launch must restore the registered session\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[english ? "Signed in" : "已登录"].exists, app.debugDescription)
        XCTAssertFalse(emailField(english).exists, "A restored session must not fall back to the sign-in form")
        shot(english ? "en-register-restored" : "zh-register-restored")
    }
    private func deleteOnScreen(_ english: Bool) throws {
        tap(english ? "Delete account" : "注销账号")
        let review = app.buttons[english ? "Review family handling" : "查看家庭处置"]
        XCTAssertTrue(review.waitForExistence(timeout: 60), "The deletion impact step must be reachable\n\(app.debugDescription)")
        show(review); review.tap()
        let reauth = app.secureTextFields[english ? "Current password" : "当前密码"]
        XCTAssertTrue(reauth.waitForExistence(timeout: 60), app.debugDescription)
        show(reauth); reauth.tap(); reauth.typeText(password)
        shot(english ? "en-deletion-confirm" : "zh-deletion-confirm")
        let submit = app.buttons[english ? "Delete account" : "确认注销"]
        show(submit); submit.tap()
        let progress = app.staticTexts[english ? "Deletion progress" : "注销处理进度"]
        XCTAssertTrue(progress.waitForExistence(timeout: 90), "Submitting must show the real job receipt\n\(app.debugDescription)")
        app.terminate(); app.launch()
        openAccount(english)
        let resume = app.buttons[english ? "View deletion progress" : "查看注销进度"]
        XCTAssertTrue(resume.waitForExistence(timeout: 90), app.debugDescription)
        show(resume); resume.tap()
        XCTAssertTrue(progress.waitForExistence(timeout: 90), app.debugDescription)
        let completed = app.staticTexts[english ? "Server data and external revocation are both complete" : "服务端资料与外部撤销均已完成"]
        XCTAssertTrue(completed.waitForExistence(timeout: 120), "The restored receipt must load the completed job, not only a heading\n\(app.debugDescription)")
        XCTAssertFalse(reauth.exists, "A completed deletion must not ask for the password again")
        shot(english ? "en-deletion-complete" : "zh-deletion-complete")
    }
    private func registrationFlow(_ english: Bool) throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        app.launch()
        // The same clean-state control the deletion case uses: clear the isolated QA vault and receipt
        // slots so a repeated run cannot inherit a session. Then assert the screen really starts signed out.
        let reset = app.buttons["QA Reset deletion fixture"]
        XCTAssertTrue(reset.waitForExistence(timeout: 60), app.debugDescription)
        show(reset); reset.tap()
        XCTAssertTrue(app.staticTexts["QA vault status QA deletion fixture reset"].waitForExistence(timeout: 20), app.debugDescription)
        app.terminate(); app.launch()
        let address = "registration-\(isPad ? "pad" : "phone")-\(english ? "en" : "zh")-\(UUID().uuidString.prefix(8).lowercased())@example.test"
        openAccount(english)
        XCTAssertTrue(emailField(english).waitForExistence(timeout: 90), "A cleared vault must start on the sign-in form\n\(app.debugDescription)")
        XCTAssertFalse(signOutButton(english).exists, "No session may exist before the screen registers")
        try registerOnScreen(english, address)
        assertColdLaunchRestores(english)
        try deleteOnScreen(english)
    }

    func testRegistrationChinese() throws { try registrationFlow(false) }
    func testRegistrationEnglish() throws { try registrationFlow(true) }
    func testRegistrationCodeInputPreservesBurstOrder() throws {
        try XCTSkipIf(isPad, "The reproduced selection race is specific to the iPhone software keyboard path.")
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        defer { app.terminate(); XCUIDevice.shared.orientation = .portrait }
        app.launch()
        let reset = app.buttons["QA Reset deletion fixture"]
        XCTAssertTrue(reset.waitForExistence(timeout: 60), app.debugDescription)
        show(reset); reset.tap()
        XCTAssertTrue(app.staticTexts["QA vault status QA deletion fixture reset"].waitForExistence(timeout: 20), app.debugDescription)
        app.terminate(); app.launch()
        openAccount(true)
        tap("Sign up")
        let address = "registration-phone-input-\(UUID().uuidString.prefix(8).lowercased())@example.test"
        type("Email", address, into: emailField(true), secret: false)
        let consent = element("I have read and agree to the")
        XCTAssertTrue(consent.waitForExistence(timeout: 30), app.debugDescription)
        show(consent); consent.tap()
        let send = app.buttons["Send code"]
        XCTAssertTrue(send.waitForExistence(timeout: 5) && send.isEnabled, app.debugDescription)
        send.tap()
        let code = app.textFields["Six-digit code"]
        XCTAssertTrue(code.waitForExistence(timeout: 60), app.debugDescription)
        revealSoftwareKeyboard()
        for value in ["011046", "650398", "102938", "564738", "908172", "345612", "789054", "230167", "841529", "976031",
                      "120945", "675302", "498761", "031826", "752490", "286513", "917460", "540289", "163875", "824607"] {
            replaceAndAssert(code, with: value)
        }
    }
}
