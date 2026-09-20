import XCTest

final class WhiteboardTrialUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.siyue.mobile")

    func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    func openBoard() {
        app.launch()
        let url = URL(string: "siyue:///whiteboard")!
        app.open(url)
        XCTAssertTrue(element("whiteboard-canvas").waitForExistence(timeout: 45))
    }
    func expectCount(_ count: Int) {
        let status = element("whiteboard-status")
        let predicate = NSPredicate(format: "label ENDSWITH %@ OR label ENDSWITH %@", "· \(count) 笔", "· \(count) strokes")
        expectation(for: predicate, evaluatedWith: status)
        waitForExpectations(timeout: 10)
    }
    func count() -> Int {
        let text = element("whiteboard-status").label
        return Int(text.components(separatedBy: "·").last!.trimmingCharacters(in: .whitespaces).components(separatedBy: " ")[0])!
    }
    func draw() {
        let canvas = element("whiteboard-canvas")
        let start = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
        let end = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)
    }
    func testDrawEraseUndoSaveReopenAndPages() {
        continueAfterFailure = false
        openBoard()
        // A new QA install starts blank; repeated runs preserve saved data and add a fresh page.
        if count() != 0 { element("whiteboard-add-blank").tap() }
        expectCount(0)
        element("whiteboard-pen").tap()
        draw(); expectCount(1)
        element("whiteboard-undo").tap(); expectCount(0)
        element("whiteboard-redo").tap(); expectCount(1)
        element("whiteboard-eraser").tap()
        element("whiteboard-canvas").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        expectCount(0)
        element("whiteboard-undo").tap(); expectCount(1)
        element("whiteboard-save").tap()
        let status = element("whiteboard-status").label
        let pageNumber = status.components(separatedBy: "/")[0].filter { $0.isNumber }
        app.terminate()
        openBoard()
        element("whiteboard-page-\(pageNumber)").tap()
        expectCount(1)
        XCTAssertEqual(element("whiteboard-status").label, status)
        element("whiteboard-add-exercise").tap(); expectCount(0)
        element("whiteboard-pen").tap(); draw(); expectCount(1)
        element("whiteboard-save").tap()
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Whiteboard exercise and editable ink"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
