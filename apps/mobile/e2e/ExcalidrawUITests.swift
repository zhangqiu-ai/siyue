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
    func testPhotoPickerImport() {
        continueAfterFailure = false
        openBoard()
        XCTAssertFalse(element("转换旧白板副本").exists)
        element("选图").tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(element("选图").waitForExistence(timeout: 10))
        element("选图").tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 15))
        print("PHOTO_PICKER_AX_BEGIN\n" + app.debugDescription + "\nPHOTO_PICKER_AX_END")
        shot("Native system photo picker")
        let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH %@", "Photo,")).firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 10), app.debugDescription)
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        // Previously a pre-import saved label could be observed while the native action was still pending.
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons["选图"].firstMatch)
        waitForExpectations(timeout: 30)
        XCTAssertTrue(element("已保存到本机").waitForExistence(timeout: 20), app.debugDescription)
        shot("Native imported homework image")
        app.terminate(); openBoard()
        XCTAssertTrue(element("已保存到本机").waitForExistence(timeout: 15))
        shot("Native image after cold reopen")
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
