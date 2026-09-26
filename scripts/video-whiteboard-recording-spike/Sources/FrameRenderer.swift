import Foundation
import CoreGraphics

enum RenderPalette {
    static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    static func color(_ red: Double, _ green: Double, _ blue: Double, alpha: Double = 1.0) -> CGColor {
        CGColor(colorSpace: colorSpace,
                components: [CGFloat(red), CGFloat(green), CGFloat(blue), CGFloat(alpha)])!
    }
}

/// Draws one synthetic frame. Coordinates are top-left origin pixels (y grows downward);
/// the renderer flips the context so both the generator and the verifier can use the same
/// numeric layout described in Spec.swift.
enum FrameRenderer {
    static func render(mode: SpikeMode, frameIndex: Int, into context: CGContext) {
        let t = Double(frameIndex) / Double(SpikeSpec.fps)
        context.saveGState()
        context.translateBy(x: 0, y: CGFloat(SpikeSpec.height))
        context.scaleBy(x: 1, y: -1)
        context.setShouldAntialias(true)

        switch mode {
        case .negative:
            context.setFillColor(RenderPalette.color(SpikeSpec.negativeColor.red,
                                                      SpikeSpec.negativeColor.green,
                                                      SpikeSpec.negativeColor.blue))
            context.fill(CGRect(x: 0, y: 0, width: SpikeSpec.width, height: SpikeSpec.height))
        case .whiteboard:
            drawWhiteboard(at: t, into: context)
            drawParticipants(mode: mode, at: t, into: context)
        case .grid:
            drawParticipantGrid(at: t, into: context)
        }

        context.restoreGState()
    }

    private static func drawWhiteboard(at t: Double, into context: CGContext) {
        // Board surface
        context.setFillColor(RenderPalette.color(1.0, 1.0, 1.0))
        context.fill(CGRect(x: 0, y: 0, width: SpikeSpec.width, height: SpikeSpec.height))

        // Light grid
        context.setStrokeColor(RenderPalette.color(SpikeSpec.gridLineColor.red,
                                                   SpikeSpec.gridLineColor.green,
                                                   SpikeSpec.gridLineColor.blue))
        context.setLineWidth(1.0)
        var x = SpikeSpec.gridLineSpacing
        while x < Double(SpikeSpec.width) {
            context.move(to: CGPoint(x: x, y: 0))
            context.addLine(to: CGPoint(x: x, y: Double(SpikeSpec.height)))
            x += SpikeSpec.gridLineSpacing
        }
        var y = SpikeSpec.gridLineSpacing
        while y < Double(SpikeSpec.height) {
            context.move(to: CGPoint(x: 0, y: y))
            context.addLine(to: CGPoint(x: Double(SpikeSpec.width), y: y))
            y += SpikeSpec.gridLineSpacing
        }
        context.strokePath()

        // Synthetic "homework photo" pinned on the board
        let problem = SpikeSpec.problemRect
        context.setFillColor(RenderPalette.color(SpikeSpec.problemColor.red,
                                                 SpikeSpec.problemColor.green,
                                                 SpikeSpec.problemColor.blue))
        context.fill(CGRect(x: problem.x, y: problem.y, width: problem.width, height: problem.height))
        context.setStrokeColor(RenderPalette.color(SpikeSpec.problemBorderColor.red,
                                                   SpikeSpec.problemBorderColor.green,
                                                   SpikeSpec.problemBorderColor.blue))
        context.setLineWidth(4.0)
        context.stroke(CGRect(x: problem.x, y: problem.y, width: problem.width, height: problem.height))

        // Handwriting appears progressively, as a real annotation would while being drawn
        let points = SpikeSpec.strokePolyline()
        let drawn = SpikeSpec.strokeProgressIndex(at: t)
        if drawn > 0 {
            context.setStrokeColor(RenderPalette.color(SpikeSpec.inkColor.red,
                                                       SpikeSpec.inkColor.green,
                                                       SpikeSpec.inkColor.blue))
            context.setLineWidth(CGFloat(SpikeSpec.strokeInkWidth))
            context.setLineCap(.round)
            context.setLineJoin(.round)
            context.move(to: CGPoint(x: points[0].x, y: points[0].y))
            for index in 1...min(drawn, SpikeSpec.strokePointCount) {
                context.addLine(to: CGPoint(x: points[index].x, y: points[index].y))
            }
            context.strokePath()
        }

        // Sliding pointer marker (deterministic motion signal)
        let marker = SpikeSpec.markerRect(at: t)
        context.setFillColor(RenderPalette.color(SpikeSpec.markerColor.red,
                                                 SpikeSpec.markerColor.green,
                                                 SpikeSpec.markerColor.blue))
        context.fill(CGRect(x: marker.x, y: marker.y, width: marker.width, height: marker.height))
    }

    private static func drawParticipants(mode: SpikeMode, at t: Double, into context: CGContext) {
        let sources = SpikeSpec.participants(for: mode)
        let rects = SpikeSpec.participantRects(for: mode)
        for (source, rect) in zip(sources, rects) {
            let color = source.color(at: t)
            // 3 px white surround so the thumbnail edge is unambiguous on a white board
            context.setFillColor(RenderPalette.color(1.0, 1.0, 1.0))
            context.fill(CGRect(x: rect.x - 3, y: rect.y - 3, width: rect.width + 6, height: rect.height + 6))
            context.setFillColor(RenderPalette.color(color.red, color.green, color.blue))
            context.fill(CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height))
            // Dark outline reads as a video tile, not as board content
            context.setStrokeColor(RenderPalette.color(0.15, 0.15, 0.15))
            context.setLineWidth(2.0)
            context.stroke(CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height))
        }
    }

    private static func drawParticipantGrid(at t: Double, into context: CGContext) {
        let sources = SpikeSpec.participants(for: .grid)
        let rects = SpikeSpec.participantRects(for: .grid)
        for (source, rect) in zip(sources, rects) {
            let color = source.color(at: t)
            context.setFillColor(RenderPalette.color(color.red, color.green, color.blue))
            context.fill(CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height))
        }
        // Separators between tiles (no participant sample point sits on them)
        context.setFillColor(RenderPalette.color(0.15, 0.15, 0.15))
        context.fill(CGRect(x: Double(SpikeSpec.width) / 2 - 2, y: 0, width: 4, height: Double(SpikeSpec.height)))
        context.fill(CGRect(x: 0, y: Double(SpikeSpec.height) / 2 - 2, width: Double(SpikeSpec.width), height: 4))
    }
}
