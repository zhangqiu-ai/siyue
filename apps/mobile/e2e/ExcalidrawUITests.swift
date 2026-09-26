import XCTest

// Runs against a separately installed Release app, with no Metro connection.
final class ExcalidrawUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.siyue.mobile")
    func element(_ label: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: label).firstMatch }
    func openBoard() {
        app.launch()
        app.open(URL(string: "siyue:///whiteboard")!)
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 45))
        XCTAssertTrue(element("选图").waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(element("转换旧白板副本").exists)
    }
    func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testOfflineEditorAndRecovery() {
        continueAfterFailure = false
        openBoard()
        shot("Excalidraw initial native layout")
        print("EXCALIDRAW_AX_BEGIN\n" + app.debugDescription + "\nEXCALIDRAW_AX_END")
        // Select the upstream pen using its accessible name, never an injected editor API.
        let pen = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "自由书写")).firstMatch
        XCTAssertTrue(pen.waitForExistence(timeout: 10)); pen.tap()
        let web = app.webViews.firstMatch
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.55)).press(forDuration: 0.05,
            thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.6)))
        element("保存").tap()
        XCTAssertTrue(element("已保存到本机").waitForExistence(timeout: 15))
        shot("Excalidraw native ink saved")
        app.terminate(); openBoard()
        XCTAssertTrue(element("已保存到本机").waitForExistence(timeout: 15))
        shot("Excalidraw native cold reopen")
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
            expectation(for: NSPredicate { _,_ in self.app.webViews.firstMatch.frame.width > self.app.webViews.firstMatch.frame.height }, evaluatedWith: app)
            waitForExpectations(timeout: 15)
            // Let the system rotation animation finish before capturing its rendered surface.
            Thread.sleep(forTimeInterval: 2)
            XCTAssertGreaterThan(app.webViews.firstMatch.frame.width, app.webViews.firstMatch.frame.height)
            XCTAssertTrue(element("选图").waitForExistence(timeout: 10))
            shot("Excalidraw iPad landscape")
            XCUIDevice.shared.orientation = .portrait
        }
    }
}

// Run separately after setting the isolated QA app's existing locale/theme preferences to en/dark.
final class ExcalidrawEnglishUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.siyue.mobile")
    func testEnglishDarkEditingAndRotation() {
        continueAfterFailure = false
        app.launch(); app.open(URL(string: "siyue:///whiteboard")!)
        XCTAssertTrue(app.buttons["Photos"].waitForExistence(timeout: 40), app.debugDescription)
        let pen = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Draw")).firstMatch
        XCTAssertTrue(pen.waitForExistence(timeout: 10)); pen.tap()
        let web = app.webViews.firstMatch
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.65)).press(forDuration: 0.05,
            thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.68)))
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Saved locally"].waitForExistence(timeout: 15))
        var shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "English dark native editing"; shot.lifetime = .keepAlways; add(shot)
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
            expectation(for: NSPredicate { _,_ in self.app.webViews.firstMatch.frame.width > self.app.webViews.firstMatch.frame.height }, evaluatedWith: app)
            waitForExpectations(timeout: 15)
            // Let the system rotation animation finish before capturing its rendered surface.
            Thread.sleep(forTimeInterval: 2)
            XCTAssertGreaterThan(app.webViews.firstMatch.frame.width, app.webViews.firstMatch.frame.height)
            XCTAssertTrue(app.buttons["Photos"].waitForExistence(timeout: 10))
            shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "English dark iPad landscape"; shot.lifetime = .keepAlways; add(shot)
            XCUIDevice.shared.orientation = .portrait
        }
        app.terminate(); app.launch(); app.open(URL(string: "siyue:///whiteboard")!)
        XCTAssertTrue(app.staticTexts["Saved locally"].waitForExistence(timeout: 40))
    }
}

// 7.2 原生拍题/选图回归：只使用隔离 QA 模拟器与合成题图，不注入编辑器 API，也不用浏览器替代原生。
// 运行前在目标模拟器的系统相册放入唯一合成题图 apps/mobile/assets/whiteboard/exercise.png。
final class ExcalidrawPhotoPickUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.siyue.mobile")
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let saved = "已保存到本机", importing = "正在处理图片…"
    let importError = "图片未导入。请检查权限、图片格式或大小后重试。"

    func any(_ format: String, _ arguments: [CVarArg]) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: format, argumentArray: arguments)).firstMatch
    }
    func text(_ value: String) -> XCUIElement { any("label == %@ OR identifier == %@", [value, value]) }
    func exists(_ value: String) -> Bool { text(value).exists }
    func wait(_ value: String, _ timeout: TimeInterval = 25) -> Bool { text(value).waitForExistence(timeout: timeout) }
    func waitEnabled(_ label: String, _ timeout: TimeInterval) -> Bool {
        let probe = expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons[label].firstMatch)
        return XCTWaiter().wait(for: [probe], timeout: timeout) == .completed
    }
    func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    func openBoard() {
        app.launch()
        app.open(URL(string: "siyue:///whiteboard")!)
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 45))
        XCTAssertTrue(wait("选图", 30), app.debugDescription)
    }
    // 系统相册按钮随系统语言变化；iOS 26 上 AX hit-test 可能返回不可点击，改用元素自身坐标。
    func pickerCancel() -> XCUIElement {
        for label in ["Cancel", "取消"] {
            let button = app.buttons[label]
            if button.waitForExistence(timeout: 20) { return button }
        }
        return app.buttons.firstMatch
    }
    func pickerPhoto() -> XCUIElement {
        let match = app.images.matching(NSPredicate(format: "label BEGINSWITH %@ OR label CONTAINS %@", "Photo,", "照片")).firstMatch
        return match.exists ? match : app.images.firstMatch
    }
    // 已定位元素自身的中心坐标才能命中系统相册格子。
    func tapCentre(_ element: XCUIElement) { element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
    func stroke() {
        let web = app.webViews.firstMatch
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.28, dy: 0.72)).press(forDuration: 0.05,
            thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.78)))
    }
    func assertNoImportError(_ context: String) { XCTAssertFalse(exists(importError), "\(context): \(app.debugDescription)") }

    // 脚本基线步骤：保存当前白板，使空白 QA 安装与已有作品都能得到可核对的修订号。
    // 本轮记录的是已有作品（不是空白安装），用例名不宣称安装状态。
    func testSaveBoardRevisionForBaseline() {
        continueAfterFailure = false
        openBoard()
        text("保存").tap()
        XCTAssertTrue(wait(saved, 30), app.debugDescription)
        assertNoImportError("baseline save")
        shot("Baseline revision saved")
    }

    // 打开并取消系统相册两次：必须回到已保存状态、不导入对象、宿主仍可继续书写保存。
    func testLibraryPickerCancelKeepsBoardUsable() {
        continueAfterFailure = false
        openBoard()
        assertNoImportError("initial load")
        for attempt in 1...2 {
            text("选图").tap()
            let cancel = pickerCancel()
            XCTAssertTrue(cancel.exists, "attempt \(attempt): \(app.debugDescription)")
            // 原生动作未结束前不得继续显示上一修订的已保存状态。
            XCTAssertTrue(wait(importing, 15), "attempt \(attempt): \(app.debugDescription)")
            XCTAssertFalse(exists(saved), "attempt \(attempt): pending picker still showed the saved revision")
            shot("Native system photo picker \(attempt)")
            cancel.tap()
            XCTAssertTrue(wait(saved, 30), "attempt \(attempt): \(app.debugDescription)")
        }
        assertNoImportError("after cancelled picks")
        text("自由书写").tap()
        stroke()
        text("保存").tap()
        XCTAssertTrue(wait(saved, 30), app.debugDescription)
        shot("Board still editable after cancelled picks")
    }

    // 导入合成题图：等待原生动作结束、保存，并在同一页继续书写；冷启动后仍为已保存。
    func testLibraryPickerImportPersistsEditableImage() {
        continueAfterFailure = false
        openBoard()
        text("选图").tap()
        XCTAssertTrue(pickerCancel().exists, app.debugDescription)
        print("PHOTO_PICKER_AX_BEGIN\n" + app.debugDescription + "\nPHOTO_PICKER_AX_END")
        shot("Native system photo picker before import")
        let photo = pickerPhoto()
        XCTAssertTrue(photo.waitForExistence(timeout: 15), app.debugDescription)
        tapCentre(photo)
        // 原生导入结束前“已保存”仍属于上一修订，须等宿主按钮恢复 enabled 后再看状态。
        XCTAssertTrue(waitEnabled("选图", 60), app.debugDescription)
        XCTAssertTrue(wait(saved, 30), app.debugDescription)
        assertNoImportError("after import")
        shot("Native imported homework image")
        text("自由书写").tap()
        stroke()
        text("保存").tap()
        XCTAssertTrue(wait(saved, 30), app.debugDescription)
        shot("Native image page edited after import")
        app.terminate(); openBoard()
        XCTAssertTrue(wait(saved, 30), app.debugDescription)
        shot("Native image after cold reopen")
    }

    // 已导入图片是画布对象：选择工具下拖动应移动它，而不是再导入一次；坐标变化由脚本核对存档。
    func testMoveImportedImage() {
        continueAfterFailure = false
        openBoard()
        assertNoImportError("before move")
        let web = app.webViews.firstMatch
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2,
            thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.38)))
        text("保存").tap()
        XCTAssertTrue(wait(saved, 30), app.debugDescription)
        assertNoImportError("after move")
        shot("Imported image dragged with the selection tool")
    }

    // 相机入口边界：模拟器没有摄像头硬件，只能验证“拍题”打开系统拍摄界面并返回可用宿主。
    // 真实拍照、授权拒绝、EXIF 方向与极端大图仍需真机，不能由本用例替代。
    func testCameraEntryOpensAndDismisses() {
        continueAfterFailure = false
        openBoard()
        text("拍题").tap()
        // 首次使用会先出现系统授权提示；simctl 不能预置相机权限，这里只处理提示本身，不伪造拍摄结果。
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        let prompt = alert.waitForExistence(timeout: 25)
        if prompt {
            shot("Camera permission prompt")
            let allow = ["Allow", "好", "允许"].map { alert.buttons[$0] }.first { $0.exists }
            XCTAssertNotNil(allow, "permission alert must offer an allow choice: \(alert.debugDescription)")
            allow?.tap()
        }
        // 系统拍摄界面在应用进程内持续渲染，AX 轮询会等静默；用标识符做一次有界等待，找到即返回。
        let shutter = app.buttons["PhotoCapture"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 40), "拍题 must open the system capture UI: \(app.debugDescription)")
        shot("System camera capture sheet")
        print("CAMERA_ENTRY_AX_BEGIN\n" + app.debugDescription + "\nCAMERA_ENTRY_AX_END")
        XCTAssertEqual(app.state, .runningForeground, "host crashed after opening the camera")
        let dismiss = app.buttons["DismissImagePickerButton"].exists ? app.buttons["DismissImagePickerButton"] : app.buttons["Dismiss"]
        print("CAMERA_ENTRY_OPENED=\(shutter.exists) PROMPT=\(prompt) DISMISS=\(dismiss.exists)")
        XCTAssertTrue(dismiss.exists, "system capture UI must offer a dismiss control: \(app.debugDescription)")
        dismiss.tap()
        XCTAssertTrue(waitEnabled("选图", 60), "host stayed busy after leaving the camera: \(app.debugDescription)")
        XCTAssertTrue(wait(saved, 40), app.debugDescription)
        assertNoImportError("after camera dismissal")
        shot("Host usable after leaving the camera")
    }
}
