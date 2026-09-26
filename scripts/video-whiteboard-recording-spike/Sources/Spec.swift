import Foundation

/// Deterministic description of the synthetic call recording used by this spike.
///
/// The same constants drive the generator and the verifier, so the verifier checks analytic
/// expectations instead of replaying generated buffers.
enum SpikeMode: String, CaseIterable {
    case whiteboard
    case grid
    case negative

    var displayName: String {
        switch self {
        case .whiteboard: return "whiteboard-pip"
        case .grid: return "multi-video-grid"
        case .negative: return "negative-control-solid"
        }
    }

    /// C10 whiteboard mode: board as the main picture with participant thumbnails.
    var hasWhiteboard: Bool { self == .whiteboard }
    var expectsAudio: Bool { self != .negative }

    /// File name used inside the isolated output directory.
    var fileName: String {
        switch self {
        case .whiteboard: return "whiteboard-call.mov"
        case .grid: return "multi-video-call.mov"
        case .negative: return "negative-control-solid.mov"
        }
    }

    var expectedFrameCount: Int {
        switch self {
        case .negative: return SpikeSpec.negativeFrameCount
        default: return SpikeSpec.frameCount
        }
    }

    var expectedDurationSeconds: Double {
        switch self {
        case .negative: return Double(SpikeSpec.negativeFrameCount) / Double(SpikeSpec.fps)
        default: return SpikeSpec.durationSeconds
        }
    }
}

/// One synthetic participant video: a flat signature colour modulated in brightness over time.
struct ParticipantSource {
    let id: String
    let red: Double
    let green: Double
    let blue: Double
    let modulationHz: Double
    let phase: Double

    func brightness(at seconds: Double) -> Double {
        0.70 + 0.25 * sin(2 * Double.pi * modulationHz * seconds + phase)
    }

    func color(at seconds: Double) -> (red: Double, green: Double, blue: Double) {
        let b = brightness(at: seconds)
        return (red * b, green * b, blue * b)
    }

    /// Hue-only template used for classification, independent of brightness.
    var normalizedTemplate: (red: Double, green: Double, blue: Double) {
        let n = (red * red + green * green + blue * blue).squareRoot()
        return (red / n, green / n, blue / n)
    }
}

/// Rectangle in frame pixels with a top-left origin (y grows downward).
struct PixelRect {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var centerX: Double { x + width / 2 }
    var centerY: Double { y + height / 2 }
    var maxX: Double { x + width }
    var maxY: Double { y + height }
}

enum SpikeSpec {
    // Video geometry
    static let width = 1280
    static let height = 720
    static let fps: Int32 = 30
    static let durationSeconds = 6.0
    static let frameCount = 180
    /// The negative control keeps the same duration and frame count as the real recordings but
    /// has no audio track and no structured picture, so failures can only come from content.
    static let negativeFrameCount = 180
    static let negativeColor = (red: 0.5, green: 0.5, blue: 0.5)

    // Audio
    static let sampleRate = 48_000.0
    static let channelCount = 2
    static let localToneHz = 440.0
    static let localToneAmplitude = 0.5
    static let remoteToneAHz = 1200.0
    static let remoteToneBHz = 1800.0
    static let remoteToneAmplitude = 0.28

    static let localOnlyWindow = 0.25..<1.75
    static let remoteOnlyWindow = 2.25..<3.75
    static let mixedWindow = 4.25..<5.75
    static let lateMixedWindow = 4.05..<4.40

    /// The recorder captures the local microphone for the whole call; the remote bus only
    /// carries the other participants once they are audible.
    static let localActiveWindows: [Range<Double>] = [0.0..<2.0, 4.0..<6.0]
    static let remoteActiveWindows: [Range<Double>] = [2.0..<4.0, 4.0..<6.0]

    // Synthetic participants (distinct hue per stream)
    static let localSource = ParticipantSource(id: "local", red: 0.90, green: 0.25, blue: 0.10,
                                               modulationHz: 1.00, phase: 0.0)
    static let remoteSource1 = ParticipantSource(id: "remote-1", red: 0.10, green: 0.75, blue: 0.20,
                                                 modulationHz: 1.50, phase: Double.pi / 3)
    static let remoteSource2 = ParticipantSource(id: "remote-2", red: 0.15, green: 0.30, blue: 0.90,
                                                 modulationHz: 0.75, phase: 2 * Double.pi / 3)
    static let remoteSource3 = ParticipantSource(id: "remote-3", red: 0.90, green: 0.80, blue: 0.10,
                                                 modulationHz: 1.10, phase: Double.pi / 6)

    static let whiteboardParticipantRects: [PixelRect] = [
        PixelRect(x: 1000, y: 40, width: 240, height: 135),
        PixelRect(x: 1000, y: 195, width: 240, height: 135),
        PixelRect(x: 1000, y: 350, width: 240, height: 135),
    ]

    static let gridParticipantRects: [PixelRect] = [
        PixelRect(x: 0, y: 0, width: 640, height: 360),
        PixelRect(x: 640, y: 0, width: 640, height: 360),
        PixelRect(x: 0, y: 360, width: 640, height: 360),
        PixelRect(x: 640, y: 360, width: 640, height: 360),
    ]

    static func participants(for mode: SpikeMode) -> [ParticipantSource] {
        switch mode {
        case .whiteboard: return [localSource, remoteSource1, remoteSource2]
        case .grid: return [localSource, remoteSource1, remoteSource2, remoteSource3]
        case .negative: return []
        }
    }

    static func participantRects(for mode: SpikeMode) -> [PixelRect] {
        switch mode {
        case .whiteboard: return whiteboardParticipantRects
        case .grid: return gridParticipantRects
        case .negative: return []
        }
    }

    // Whiteboard canvas content
    static let boardWhiteRegion = PixelRect(x: 600, y: 80, width: 360, height: 520)
    static let problemRect = PixelRect(x: 80, y: 80, width: 480, height: 280)
    static let problemColor = (red: 0.97, green: 0.95, blue: 0.88)
    static let problemBorderColor = (red: 0.75, green: 0.72, blue: 0.65)
    static let inkColor = (red: 0.10, green: 0.24, blue: 0.55)
    static let strokeStart = (x: 100.0, y: 600.0)
    static let strokeEnd = (x: 580.0, y: 600.0)
    static let strokeDrawSeconds = 3.0
    static let strokePointCount = 48
    static let strokeInkWidth = 9.0
    static let gridLineSpacing = 64.0
    static let gridLineColor = (red: 0.90, green: 0.90, blue: 0.90)
    static let markerSize = 40.0
    static let markerBandY = 640.0
    static let markerTravelStartX = 40.0
    static let markerTravelDistance = 560.0
    static let markerColor = (red: 0.05, green: 0.05, blue: 0.05)

    static func strokePolyline() -> [(x: Double, y: Double)] {
        (0...strokePointCount).map { index in
            let u = Double(index) / Double(strokePointCount)
            return (strokeStart.x + (strokeEnd.x - strokeStart.x) * u,
                    strokeStart.y - 70.0 * sin(Double.pi * u))
        }
    }

    /// Number of polyline segments already drawn at the given time (handwriting appears progressively).
    static func strokeProgressIndex(at seconds: Double) -> Int {
        let u = min(1.0, max(0.0, seconds / strokeDrawSeconds))
        return Int((u * Double(strokePointCount)).rounded(.down))
    }

    /// Black square sliding over the lower canvas: a crisp, exactly predictable motion signal.
    static func markerRect(at seconds: Double) -> PixelRect {
        let p = min(1.0, max(0.0, seconds / durationSeconds))
        return PixelRect(x: markerTravelStartX + markerTravelDistance * p,
                         y: markerBandY,
                         width: markerSize,
                         height: markerSize)
    }
}
