import XCTest
import UIKit

final class AccountAuthUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.siyue.mobile.accountqa")
    func shot(_ name: String) {
        // Application capture can crop using stale portrait coordinates after rotation.
        // Capture the complete simulator display for landscape evidence.
        let item = XCTAttachment(screenshot: name.contains("landscape") ? XCUIScreen.main.screenshot() : app.screenshot())
        item.name = name; item.lifetime = .keepAlways; add(item)
    }
    func show(_ button: XCUIElement) {
        for _ in 0..<4 {
            let notNow = app.buttons["Not Now"]
            if notNow.exists && notNow.isHittable { notNow.tap() }
            if button.isHittable { return }; app.swipeUp()
        }
        for _ in 0..<4 { if button.isHittable { return }; app.swipeDown() }
        XCTAssertTrue(button.isHittable, app.debugDescription)
    }
    func flow(_ english: Bool) {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        app.launch()
        let qa = english ? "QA English dark" : "QA 中文明色"
        XCTAssertTrue(app.buttons[qa].waitForExistence(timeout: 45)); app.buttons[qa].tap()
        let signout = app.buttons[english ? "Sign out" : "退出登录"]
        if signout.waitForExistence(timeout: 2) { signout.tap(); app.buttons["account-signout-confirm"].tap() }
        let emailEntry = app.buttons["account-email-entry"]
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 30), app.debugDescription); emailEntry.tap()
        let email = app.textFields[english ? "Email" : "邮箱"]
        XCTAssertTrue(email.waitForExistence(timeout: 30), app.debugDescription)
        shot(english ? "en-dark-sign-in" : "zh-light-sign-in")
        email.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 0.5)
        let address = english ? "native-en@example.test" : "native-zh@example.test"
        email.typeText(address)
        XCTAssertEqual(email.value as? String, address, "Email must be complete before submitting")
        let password = app.secureTextFields[english ? "Password" : "密码"]
        password.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 0.5)
        password.typeText("siyue-qa-native7")
        shot(english ? "en-dark-input" : "zh-light-input")
        let signin = app.buttons[english ? "Sign in" : "登录"]
        show(signin); signin.tap()
        XCTAssertTrue(signout.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.staticTexts[english ? "Signed in" : "已登录"].exists)
        shot(english ? "en-dark-signed-in" : "zh-light-signed-in")
        let spaceRow = app.buttons["account-row-space"]
        show(spaceRow); spaceRow.tap()
        let createSpace = app.buttons[english ? "Create account space" : "创建账号空间"]
        XCTAssertTrue(createSpace.waitForExistence(timeout: 20)); show(createSpace); createSpace.tap()
        let accountSpace = app.staticTexts[english ? "Account space" : "账号空间"]
        XCTAssertTrue(accountSpace.waitForExistence(timeout: 20), app.debugDescription)
        shot(english ? "en-account-space" : "zh-account-space")
        app.buttons["account-back"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons[qa].waitForExistence(timeout: 30)); app.buttons[qa].tap()
        XCTAssertTrue(signout.waitForExistence(timeout: 30), app.debugDescription)
        show(spaceRow); spaceRow.tap()
        XCTAssertTrue(accountSpace.waitForExistence(timeout: 20), "Account namespace must restore after cold launch")
        app.buttons["account-back"].tap()
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
            expectation(for: NSPredicate { _,_ in self.app.windows.firstMatch.frame.width > self.app.windows.firstMatch.frame.height }, evaluatedWith: app)
            waitForExpectations(timeout: 10)
            // UIKit reports the new frame before the rotation animation settles.
            Thread.sleep(forTimeInterval: 2)
            shot(english ? "en-ipad-landscape-restored" : "zh-ipad-landscape-restored")
            XCUIDevice.shared.orientation = .portrait
        }
        let manageDevices = app.buttons["account-row-devices"]
        XCTAssertTrue(manageDevices.waitForExistence(timeout: 20)); show(manageDevices); manageDevices.tap()
        let currentDevice = app.staticTexts[english ? "This one" : "本机"]
        XCTAssertTrue(currentDevice.waitForExistence(timeout: 20), app.debugDescription)
        show(currentDevice)
        shot(english ? "en-dark-devices" : "zh-light-devices")
        let revokeAll = app.buttons["account-revoke-all"]
        show(revokeAll); revokeAll.tap()
        let verify = app.secureTextFields[english ? "Current password" : "当前密码"]
        XCTAssertTrue(verify.waitForExistence(timeout: 10), app.debugDescription)
        verify.tap(); verify.typeText("siyue-qa-native7")
        app.buttons["account-device-confirm"].tap()
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 20)); emailEntry.tap()
        XCTAssertTrue(email.waitForExistence(timeout: 20)); XCTAssertEqual(password.value as? String, "")
        app.terminate(); app.launch(); XCTAssertTrue(app.buttons[qa].waitForExistence(timeout: 30)); app.buttons[qa].tap()
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 30), "Revoked credentials must not restore a session")
    }
    func deletionFlow(_ english: Bool) {
        continueAfterFailure = false
        app.launch()
        let reset = app.buttons["QA Reset deletion fixture"]
        XCTAssertTrue(reset.waitForExistence(timeout: 45)); show(reset); reset.tap()
        XCTAssertTrue(app.staticTexts["QA vault status QA deletion fixture reset"].waitForExistence(timeout: 15), app.debugDescription)
        app.terminate(); app.launch()
        let qa = english ? "QA English dark" : "QA 中文明色"
        XCTAssertTrue(app.buttons[qa].waitForExistence(timeout: 45)); app.buttons[qa].tap()
        let emailEntry = app.buttons["account-email-entry"]
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 30), app.debugDescription); emailEntry.tap()
        let email = app.textFields[english ? "Email" : "邮箱"]
        XCTAssertTrue(email.waitForExistence(timeout: 30), app.debugDescription)
        email.tap()
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "pad" : "phone"
        email.typeText("deletion-\(device)-\(english ? "en" : "zh")@example.test")
        let password = app.secureTextFields[english ? "Password" : "密码"]
        password.tap(); password.typeText("siyue-qa-native7")
        let login = app.buttons[english ? "Sign in" : "登录"]; show(login); login.tap()
        let entry = app.buttons[english ? "Delete account" : "注销账号"]
        XCTAssertTrue(entry.waitForExistence(timeout: 30), app.debugDescription); show(entry); entry.tap()
        shot(english ? "deletion-en-impact" : "deletion-zh-impact")
        let impact = app.buttons[english ? "Review family handling" : "查看家庭处置"]
        XCTAssertTrue(impact.waitForExistence(timeout: 15), app.debugDescription); show(impact); impact.tap()
        let verify = app.secureTextFields[english ? "Current password" : "当前密码"]
        XCTAssertTrue(verify.waitForExistence(timeout: 15), app.debugDescription); show(verify); verify.tap(); verify.typeText("siyue-qa-native7")
        shot(english ? "deletion-en-confirm" : "deletion-zh-confirm")
        let submit = app.buttons[english ? "Delete account" : "确认注销"]; show(submit); submit.tap()
        let progress = app.staticTexts[english ? "Deletion progress" : "注销处理进度"]
        XCTAssertTrue(progress.waitForExistence(timeout: 30), app.debugDescription)
        shot(english ? "deletion-en-progress" : "deletion-zh-progress")
        app.terminate(); app.launch(); XCTAssertTrue(app.buttons[qa].waitForExistence(timeout: 30)); app.buttons[qa].tap()
        let resume = app.buttons[english ? "Deletion request in progress" : "注销请求处理中"]
        XCTAssertTrue(resume.waitForExistence(timeout: 30), app.debugDescription); show(resume); resume.tap()
        XCTAssertTrue(progress.waitForExistence(timeout: 30), app.debugDescription)
        let completed = app.staticTexts[english ? "Server data and external revocation are both complete" : "服务端资料与外部撤销均已完成"]
        XCTAssertTrue(completed.waitForExistence(timeout: 30), "The restored receipt must load the actual completed job, not only a progress heading\n\(app.debugDescription)")
        XCTAssertFalse(app.secureTextFields[english ? "Current password" : "当前密码"].exists)
        shot(english ? "deletion-en-restored" : "deletion-zh-restored")
    }
    func testDeletionChinese() { deletionFlow(false) }
    func testDeletionEnglish() { deletionFlow(true) }

    func testChineseLightRecovery() { flow(false) }
    func testEnglishDarkRecovery() { flow(true) }

    func testOtherAndAllDeviceRevocation() {
        continueAfterFailure = false
        app.launch()
        let qa = app.buttons["QA English dark"]
        XCTAssertTrue(qa.waitForExistence(timeout: 45)); qa.tap()
        let emailEntry = app.buttons["account-email-entry"]
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 30)); emailEntry.tap()
        let email = app.textFields["Email"]
        XCTAssertTrue(email.waitForExistence(timeout: 30), app.debugDescription)
        email.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 0.5)
        email.typeText("native-en@example.test")
        XCTAssertEqual(email.value as? String, "native-en@example.test")
        let password = app.secureTextFields["Password"]
        password.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 0.5)
        password.typeText("siyue-qa-native7")
        let signin = app.buttons["Sign in"]
        show(signin); signin.tap()
        XCTAssertTrue(app.buttons["Sign out"].waitForExistence(timeout: 30), app.debugDescription)

        let manage = app.buttons["account-row-devices"]
        show(manage); manage.tap()
        let other = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "QA registration device")).firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 20), app.debugDescription)
        show(other); shot("en-dark-other-device")
        let revokeOther = app.buttons["Sign out"]
        show(revokeOther); revokeOther.tap()
        let reauth = app.secureTextFields["Current password"]
        XCTAssertTrue(reauth.waitForExistence(timeout: 10)); reauth.tap(); reauth.typeText("siyue-qa-native7")
        app.buttons["account-device-confirm"].tap()
        expectation(for: NSPredicate(format: "exists == NO"), evaluatedWith: other)
        waitForExpectations(timeout: 20)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "This device")).firstMatch.exists)
        shot("en-dark-other-revoked")

        let revokeAll = app.buttons["account-revoke-all"]
        show(revokeAll); revokeAll.tap()
        XCTAssertTrue(reauth.waitForExistence(timeout: 10)); reauth.tap(); reauth.typeText("siyue-qa-native7")
        app.buttons["account-device-confirm"].tap()
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 20), app.debugDescription)
        app.terminate(); app.launch()
        XCTAssertTrue(qa.waitForExistence(timeout: 30)); qa.tap()
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 30), "All revoked sessions must not restore after restart")
    }

    func testMissingSecureStoreItemAfterInitializationPreservesVaultState() {
        continueAfterFailure = false
        app.launch()
        let qa = app.buttons["QA 中文明色"]
        XCTAssertTrue(qa.waitForExistence(timeout: 45)); qa.tap()
        let emailEntry = app.buttons["account-email-entry"]
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 30)); emailEntry.tap()
        let email = app.textFields["邮箱"]
        XCTAssertTrue(email.waitForExistence(timeout: 30), app.debugDescription)
        let back = app.buttons["返回"]
        XCTAssertTrue(back.waitForExistence(timeout: 10)); back.tap()
        let removeVault = app.buttons["QA Remove initialized auth vault"]
        XCTAssertTrue(removeVault.waitForExistence(timeout: 15), app.debugDescription)
        removeVault.tap()
        app.terminate()
        app.launch(); XCTAssertTrue(qa.waitForExistence(timeout: 30)); qa.tap()
        let preserved = app.staticTexts["原有内容已保留。请解锁设备后重试。"]
        XCTAssertTrue(preserved.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(email.exists, "A missing initialized SecureStore entry must not be replaced as a first-install record")
    }

    /// Drives the production account router in the isolated QA app. The fixture owns only synthetic
    /// accounts; each assertion checks a destination or server-backed state, not a screenshot alone.
    func testRedesignedAccountRoutes() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        app.launch()
        let reset = app.buttons["QA Reset deletion fixture"]
        XCTAssertTrue(reset.waitForExistence(timeout: 45)); reset.tap()
        XCTAssertTrue(app.staticTexts["QA vault status QA deletion fixture reset"].waitForExistence(timeout: 15))
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["QA English dark"].waitForExistence(timeout: 45))
        app.buttons["QA English dark"].tap()
        let emailEntry = app.buttons["account-email-entry"]
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 30), app.debugDescription)
        emailEntry.tap()
        let email = app.textFields["account-email"]
        XCTAssertTrue(email.waitForExistence(timeout: 15), app.debugDescription)
        email.tap(); email.typeText("native-en@example.test")
        let password = app.secureTextFields["account-password"]
        XCTAssertTrue(password.waitForExistence(timeout: 15), app.debugDescription)
        password.tap(); password.typeText("siyue-qa-native7")
        let submit = app.buttons["account-sign-in-submit"]
        show(submit); submit.tap()
        XCTAssertTrue(app.otherElements["account-identity"].waitForExistence(timeout: 30), app.debugDescription)
        let savePassword = app.buttons["Not Now"]
        if savePassword.waitForExistence(timeout: 2) { savePassword.tap() }
        let split = app.frame.width >= 941
        let sidebar = app.otherElements["account-sidebar"]
        if split {
            XCTAssertTrue(sidebar.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertEqual(sidebar.frame.width, 380, accuracy: 2)
            XCTAssertGreaterThanOrEqual(app.frame.width - sidebar.frame.maxX, 560)
        } else {
            XCTAssertFalse(sidebar.exists, "Narrow windows must use a single account column")
        }
        shot(split ? "account-wide-home" : "account-narrow-home")
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
            expectation(for: NSPredicate { _, _ in
                self.app.windows.firstMatch.frame.width > self.app.windows.firstMatch.frame.height
            }, evaluatedWith: app)
            waitForExpectations(timeout: 10)
            let wideSidebar = app.otherElements["account-sidebar"]
            XCTAssertTrue(wideSidebar.waitForExistence(timeout: 15), app.debugDescription)
            XCTAssertEqual(wideSidebar.frame.width, 380, accuracy: 2)
            XCTAssertGreaterThanOrEqual(app.frame.width - wideSidebar.frame.maxX, 560)
            shot("account-ipad-landscape-home")
            XCUIDevice.shared.orientation = .portrait
            expectation(for: NSPredicate { _, _ in
                self.app.windows.firstMatch.frame.width < self.app.windows.firstMatch.frame.height
            }, evaluatedWith: app)
            waitForExpectations(timeout: 10)
            if !split { XCTAssertFalse(sidebar.exists, "Portrait iPad must return to one column") }
        }
        let methods = app.buttons[split ? "account-side-methods" : "account-row-methods"]
        show(methods); methods.tap()
        XCTAssertTrue(app.otherElements["account-methods"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Email & password"].exists)
        if !split { app.buttons["account-back"].tap() }
        let devices = app.buttons[split ? "account-side-devices" : "account-row-devices"]
        show(devices); devices.tap()
        XCTAssertTrue(app.otherElements["account-devices"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["This one"].exists)
        if !split { app.buttons["account-back"].tap() }
        let space = app.buttons[split ? "account-side-space" : "account-row-space"]
        show(space); space.tap()
        XCTAssertTrue(app.otherElements["account-space"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Original local space"].exists)
        if !split { app.buttons["account-back"].tap() }
        let signout = app.buttons["account-row-signout"]
        show(signout); signout.tap()
        let confirm = app.buttons["account-signout-confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), app.debugDescription)
        confirm.tap()
        XCTAssertTrue(emailEntry.waitForExistence(timeout: 30), app.debugDescription)
    }
}

// Account-space whiteboard isolation. This case is independent of the session and device-revocation
// cases above: it drives only the isolated QA app, the two synthetic emails and the production
// AccountScreen/whiteboard surfaces, and it never injects ink through a QA API.
final class AccountWhiteboardIsolationUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "app.siyue.mobile.accountqa")
    private let password = "siyue-qa-native7"
    private let accountA = "native-zh@example.test"
    private let accountB = "native-en@example.test"

    private struct Inspection: Decodable, Equatable {
        struct Item: Decodable, Hashable { let id: String; let type: String }
        let inspectionId: String
        let scope: String?
        let namespace: String?
        let elements: [Item]
        let elementDigest: String
        let fileDigest: String
        var elementIDs: Set<String> { Set(elements.map(\.id)) }
    }

    private func failure(_ text: String) -> NSError {
        NSError(domain: "AccountWhiteboardIsolationUITests", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
    private func shot(_ name: String) {
        let item = XCTAttachment(screenshot: app.screenshot())
        item.name = name; item.lifetime = .keepAlways; add(item)
    }
    private func attach(_ text: String, _ name: String) {
        let item = XCTAttachment(string: text)
        item.name = name; item.lifetime = .keepAlways; add(item)
    }
    private func query(_ label: String) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ OR label == %@", label, label))
    }
    // Prefer a real control over a same-named static text, and never fall back to an invisible match.
    private func control(_ label: String) -> XCUIElement {
        let buttons = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", label, label))
        let candidates = buttons.count > 0 ? buttons : query(label)
        for candidate in candidates.allElementsBoundByIndex where candidate.isHittable { return candidate }
        return candidates.firstMatch
    }
    private func dismissSystemPrompts() {
        // The system password-save prompt follows a successful keyboard login in either system language.
        for label in ["Not Now", "以后再说", "稍后", "Save Password", "存储密码"] {
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
        let element = control(label)
        XCTAssertTrue(element.waitForExistence(timeout: 60), "Missing control: \(label)\n\(app.debugDescription)")
        show(element)
        XCTAssertTrue(element.isHittable, "Control is not hittable: \(label)\n\(app.debugDescription)")
        element.tap()
    }
    private func signOutButton(_ english: Bool) -> XCUIElement { app.buttons[english ? "Sign out" : "退出登录"] }
    private func emailField(_ english: Bool) -> XCUIElement { app.textFields[english ? "Email" : "邮箱"] }
    private func passwordField(_ english: Bool) -> XCUIElement { app.secureTextFields[english ? "Password" : "密码"] }
    private func accountSpaceText(_ english: Bool) -> XCUIElement {
        app.staticTexts[english ? "Current space: account space (on this device)" : "当前空间：账号空间（仅本机）"]
    }
    private func localSpaceText(_ english: Bool) -> XCUIElement {
        app.staticTexts[english ? "Current space: original local space" : "当前空间：原本机空间"]
    }
    private func openQAAccount(_ english: Bool) {
        tap(english ? "QA English dark" : "QA 中文明色")
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline {
            if signOutButton(english).exists || emailField(english).exists { return }
            Thread.sleep(forTimeInterval: 0.3)
        }
        XCTFail("Account screen did not settle as signed in or signed out\n\(app.debugDescription)")
    }
    private func backToQAIndex() {
        for label in ["返回", "Back"] {
            let candidate = app.buttons[label]
            if candidate.exists && candidate.isHittable { candidate.tap(); return }
        }
        let fallback = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(fallback.waitForExistence(timeout: 30), "Missing native back navigation\n\(app.debugDescription)")
        show(fallback)
        XCTAssertTrue(fallback.isHittable, app.debugDescription)
        fallback.tap()
    }
    private func signOut(_ english: Bool) {
        let button = signOutButton(english)
        XCTAssertTrue(button.waitForExistence(timeout: 60), "Expected an authenticated account to sign out\n\(app.debugDescription)")
        show(button)
        XCTAssertTrue(button.isHittable, "The sign-out control must be reachable\n\(app.debugDescription)")
        button.tap()
        XCTAssertTrue(emailField(english).waitForExistence(timeout: 60), "Signing out must return to the sign-in form\n\(app.debugDescription)")
        // The account screen keeps rendering the previous ready workspace while the scope switches.
        // Waiting for the local label is the actual scope-switch proof, not just a visible form.
        XCTAssertTrue(localSpaceText(english).waitForExistence(timeout: 60),
                      "Signing out must switch this device back to the original local space\n\(app.debugDescription)")
    }
    // The isolated QA case runs on iPhone and iPad. iPadOS keeps the software keyboard hidden while the
    // simulator's hardware keyboard is attached and only offers a system menu in the input assistant bar;
    // requesting "Show Keyboard" is a best effort there, and the typed value is the input evidence instead.
    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }
    private func revealSoftwareKeyboard() {
        if app.keyboards.firstMatch.waitForExistence(timeout: 5) { return }
        let toggle = app.buttons["Keyboard"]
        guard toggle.waitForExistence(timeout: 3), toggle.isHittable else { return }
        toggle.tap()
        for label in ["Show Keyboard", "显示键盘"] {
            let show = app.buttons[label]
            if show.waitForExistence(timeout: 3) && show.isHittable { show.tap(); return }
        }
    }
    private func signIn(_ english: Bool, _ address: String) {
        let email = emailField(english)
        XCTAssertTrue(email.waitForExistence(timeout: 60), "Sign-in form must be available\n\(app.debugDescription)")
        show(email)
        XCTAssertTrue(email.isHittable, "The email field must be a real tappable control\n\(app.debugDescription)")
        email.tap()
        revealSoftwareKeyboard()
        let softwareKeyboardVisible = app.keyboards.firstMatch.waitForExistence(timeout: 15)
        attach("software keyboard visible: \(softwareKeyboardVisible); idiom pad: \(isPad)", "keyboard-email-\(english ? "en" : "zh")")
        // iPhone must still show the software keyboard. iPadOS hides it while the hardware keyboard is
        // attached, so there the proof of real typing is the focused, tappable field, the complete value it
        // mirrors below, and the authenticated state the real login reaches afterwards.
        XCTAssertTrue(softwareKeyboardVisible || isPad,
                      "Native keyboard must be available for real typing on iPhone\n\(app.debugDescription)")
        Thread.sleep(forTimeInterval: 0.5)
        email.typeText(address)
        XCTAssertEqual(email.value as? String, address, "The complete synthetic address must be entered before submitting")
        let secret = passwordField(english)
        show(secret)
        XCTAssertTrue(secret.isHittable, "The password field must be a real tappable control\n\(app.debugDescription)")
        secret.tap()
        revealSoftwareKeyboard()
        Thread.sleep(forTimeInterval: 0.5)
        secret.typeText(password)
        attach("password field masked value present: \(!((secret.value as? String) ?? "").isEmpty)", "keyboard-password-\(english ? "en" : "zh")")
        tap(english ? "Sign in" : "登录")
        XCTAssertTrue(signOutButton(english).waitForExistence(timeout: 75), "Sign-in must reach the authenticated state\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[english ? "Signed in" : "已登录"].exists, app.debugDescription)
    }
    // Creates the on-device account space when this account has none yet; an existing space must be restored instead.
    private func ensureAccountSpace(_ english: Bool) {
        let space = accountSpaceText(english)
        let create = control(english ? "Create an account space on this device" : "在本机创建账号空间")
        let deadline = Date().addingTimeInterval(75)
        while Date() < deadline {
            if space.exists { return }
            if create.exists { show(create); if create.isHittable { create.tap() } }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(space.waitForExistence(timeout: 20), "The account space must be created or restored on this device\n\(app.debugDescription)")
    }
    // Reads the QA inspection text (metadata only). No product data is changed and no ink is injected.
    private func inspectionPayload() -> String? {
        for element in app.descendants(matching: .any).matching(identifier: "qa-board-inspection").allElementsBoundByIndex {
            for raw in [element.label, element.value as? String ?? ""] {
                if raw.contains("inspection_failed") { return "inspection_failed" }
                if let start = raw.range(of: "{\"") { return String(raw[start.lowerBound...]) }
            }
        }
        return nil
    }
    private func currentInspection() -> Inspection? {
        guard let raw = inspectionPayload(), raw.hasPrefix("{") else { return nil }
        return try? JSONDecoder().decode(Inspection.self, from: Data(raw.utf8))
    }
    private func inspectBoard(_ step: String) throws -> Inspection {
        let previous = currentInspection()
        tap("QA Inspect saved board")
        let deadline = Date().addingTimeInterval(60)
        var observed = ""
        while Date() < deadline {
            if let raw = inspectionPayload() {
                observed = raw
                if raw == "inspection_failed" {
                    XCTFail("QA board inspection failed at \(step)")
                    throw failure("inspection_failed")
                }
                if raw.hasPrefix("{"),
                   let value = try? JSONDecoder().decode(Inspection.self, from: Data(raw.utf8)),
                   value.inspectionId != previous?.inspectionId {
                    attach(raw, "inspection-\(step).json")
                    attach(app.debugDescription, "inspection-\(step) - accessibility tree")
                    shot("inspection-\(step)")
                    return value
                }
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTFail("QA Inspect saved board reported no new inspection for \(step). Last value: \(observed)\n\(app.debugDescription)")
        throw failure("no new board inspection")
    }
    // Real touch ink through the production pen tool. The gesture is relative to the WebView frame.
    private func drawStroke(dy: CGFloat) {
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 60), "The whiteboard WebView must be present\n\(app.debugDescription)")
        XCTAssertGreaterThan(web.frame.height, 200, "The whiteboard WebView must be a real drawing surface")
        let start = web.coordinate(withNormalizedOffset: CGVector(dx: 0.28, dy: dy))
        let end = web.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: dy + 0.06))
        start.press(forDuration: 0.05, thenDragTo: end)
    }
    private func drawAndSaveInAccountSpace(_ english: Bool) {
        tap("QA Whiteboard")
        let pen = control(english ? "Draw" : "自由书写")
        XCTAssertTrue(pen.waitForExistence(timeout: 90), "The whiteboard toolbar must load\n\(app.debugDescription)")
        XCTAssertGreaterThan(app.webViews.count, 0, app.debugDescription)
        show(pen)
        XCTAssertTrue(pen.isHittable, app.debugDescription)
        pen.tap()
        drawStroke(dy: 0.40)
        tap(english ? "Save" : "保存")
        XCTAssertTrue(control(english ? "Saved locally" : "已保存到本机").waitForExistence(timeout: 60),
                      "The board must confirm the explicit save\n\(app.debugDescription)")
        shot(english ? "en-account-stroke-saved" : "zh-account-stroke-saved")
        tap(english ? "Back" : "返回")
        XCTAssertTrue(control("QA Whiteboard").waitForExistence(timeout: 60), "Leaving the board must return to QA\n\(app.debugDescription)")
    }

    func testAccountSpaceWhiteboardIsolationAcrossAccounts() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        app.launch()

        // A signs in with the synthetic Chinese-email fixture, then edits only its own account space.
        openQAAccount(false)
        if signOutButton(false).waitForExistence(timeout: 3) { signOut(false) }
        if emailField(false).exists { signIn(false, accountA) }
        ensureAccountSpace(false)
        shot("zh-account-space")
        backToQAIndex()
        let before = try inspectBoard("a-before-drawing")
        XCTAssertEqual(before.scope, "account", "Signed-in editing must use an account space")
        XCTAssertNotEqual(before.namespace, "local")

        drawAndSaveInAccountSpace(false)
        let after = try inspectBoard("a-after-drawing")
        XCTAssertEqual(after.scope, "account")
        XCTAssertEqual(after.namespace, before.namespace, "A must keep editing the same account namespace")
        XCTAssertTrue(before.elementIDs.isSubset(of: after.elementIDs), "Drawing must keep the existing account content")
        XCTAssertTrue(after.elements.contains { $0.type == "freedraw" }, "The touch stroke must persist as a freedraw element")
        XCTAssertGreaterThan(after.elements.count, before.elements.count)
        XCTAssertFalse(after.elementIDs.subtracting(before.elementIDs).isEmpty, "The stroke must add a new element id")
        XCTAssertNotEqual(after.elementDigest, before.elementDigest)

        app.terminate(); app.launch()
        openQAAccount(false)
        XCTAssertTrue(accountSpaceText(false).waitForExistence(timeout: 90), "The account space must restore after a cold launch\n\(app.debugDescription)")
        backToQAIndex()
        let restored = try inspectBoard("a-after-cold-launch")
        XCTAssertEqual(restored.scope, "account")
        XCTAssertEqual(restored.namespace, after.namespace)
        XCTAssertEqual(Set(restored.elements), Set(after.elements), "Cold launch must show exactly the saved elements")
        XCTAssertEqual(restored.elementDigest, after.elementDigest)
        XCTAssertEqual(restored.fileDigest, after.fileDigest)

        // Signed out, the original local space must not show any of A's account content.
        openQAAccount(false)
        signOut(false)
        backToQAIndex()
        let local = try inspectBoard("local-after-sign-out")
        XCTAssertEqual(local.scope, "local", "Signing out must return this device to the original local space")
        XCTAssertTrue(local.elementIDs.isDisjoint(with: after.elementIDs), "The local space must not display A's account whiteboard content")
        XCTAssertNotEqual(local.elementDigest, after.elementDigest)
        shot("zh-local-space-after-sign-out")

        // B starts with its own empty account space and never sees A's content.
        openQAAccount(true)
        signIn(true, accountB)
        ensureAccountSpace(true)
        backToQAIndex()
        let second = try inspectBoard("b-new-account-space")
        XCTAssertEqual(second.scope, "account")
        XCTAssertNotEqual(second.namespace, after.namespace, "Each account must own a separate on-device space")
        XCTAssertTrue(second.elementIDs.isDisjoint(with: after.elementIDs), "B must never see A's whiteboard elements")
        XCTAssertTrue(second.elements.isEmpty,
                      "A newly created account space must start with an empty whiteboard. If an interrupted run left content in B's space, uninstall the isolated QA app before repeating this case: \(second.elements)")
        shot("en-account-space-empty")

        // Returning to A restores A's saved content, not B's.
        openQAAccount(false)
        signOut(false)
        signIn(false, accountA)
        XCTAssertTrue(accountSpaceText(false).waitForExistence(timeout: 90), "Signing back in must restore A's account space\n\(app.debugDescription)")
        backToQAIndex()
        let revisit = try inspectBoard("a-after-return")
        XCTAssertEqual(revisit.scope, "account")
        XCTAssertEqual(revisit.namespace, after.namespace)
        XCTAssertEqual(Set(revisit.elements), Set(after.elements), "Returning to A must restore A's saved content")
        XCTAssertEqual(revisit.elementDigest, after.elementDigest)
        XCTAssertEqual(revisit.fileDigest, after.fileDigest)
        XCTAssertTrue(revisit.elementIDs.isDisjoint(with: second.elementIDs), "A must not receive B's elements")
        shot("zh-account-space-restored")
    }
}
