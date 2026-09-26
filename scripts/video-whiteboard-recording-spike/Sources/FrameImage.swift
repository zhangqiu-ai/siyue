import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Decoded frame as BGRA bytes, so pixel expectations from Spec.swift can be checked directly.
struct FrameImage {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    init(cgImage: CGImage) {
        let imageWidth = cgImage.width
        let imageHeight = cgImage.height
        var storage = [UInt8](repeating: 0, count: imageWidth * imageHeight * 4)
        storage.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress,
                  let context = CGContext(data: base,
                                          width: imageWidth,
                                          height: imageHeight,
                                          bitsPerComponent: 8,
                                          bytesPerRow: imageWidth * 4,
                                          space: RenderPalette.colorSpace,
                                          bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
                                                      | CGBitmapInfo.byteOrder32Little.rawValue) else {
                return
            }
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: imageWidth, height: imageHeight))
        }
        self.width = imageWidth
        self.height = imageHeight
        self.pixels = storage
    }

    func rgb(x: Int, y: Int) -> (red: Double, green: Double, blue: Double) {
        let clampedX = min(max(x, 0), width - 1)
        let clampedY = min(max(y, 0), height - 1)
        let base = (clampedY * width + clampedX) * 4
        return (Double(pixels[base + 2]) / 255.0,
                Double(pixels[base + 1]) / 255.0,
                Double(pixels[base]) / 255.0)
    }

    /// Mean colour of a square region centred on the given pixel coordinates.
    func mean(centerX: Double, centerY: Double, box: Double) -> (red: Double, green: Double, blue: Double) {
        let half = box / 2
        let minX = max(0, Int((centerX - half).rounded(.down)))
        let maxX = min(width - 1, Int((centerX + half).rounded(.up)))
        let minY = max(0, Int((centerY - half).rounded(.down)))
        let maxY = min(height - 1, Int((centerY + half).rounded(.up)))
        guard minX <= maxX, minY <= maxY else { return (0, 0, 0) }
        var sums = (red: 0.0, green: 0.0, blue: 0.0)
        var count = 0.0
        for y in minY...maxY {
            for x in minX...maxX {
                let pixel = rgb(x: x, y: y)
                sums.red += pixel.red
                sums.green += pixel.green
                sums.blue += pixel.blue
                count += 1
            }
        }
        return (sums.red / count, sums.green / count, sums.blue / count)
    }

    func fraction(centerX: Double, centerY: Double, box: Double,
                  matching predicate: (Double, Double, Double) -> Bool) -> Double {
        let half = box / 2
        let minX = max(0, Int((centerX - half).rounded(.down)))
        let maxX = min(width - 1, Int((centerX + half).rounded(.up)))
        let minY = max(0, Int((centerY - half).rounded(.down)))
        let maxY = min(height - 1, Int((centerY + half).rounded(.up)))
        guard minX <= maxX, minY <= maxY else { return 0 }
        var matched = 0.0
        var count = 0.0
        for y in minY...maxY {
            for x in minX...maxX {
                let pixel = rgb(x: x, y: y)
                if predicate(pixel.red, pixel.green, pixel.blue) { matched += 1 }
                count += 1
            }
        }
        return count > 0 ? matched / count : 0
    }

    func whiteFraction(rect: PixelRect, threshold: Double) -> Double {
        let minX = max(0, Int(rect.x))
        let maxX = min(width - 1, Int(rect.maxX))
        let minY = max(0, Int(rect.y))
        let maxY = min(height - 1, Int(rect.maxY))
        guard minX < maxX, minY < maxY else { return 0 }
        var white = 0.0
        var count = 0.0
        for y in stride(from: minY, to: maxY, by: 3) {
            for x in stride(from: minX, to: maxX, by: 3) {
                let pixel = rgb(x: x, y: y)
                if pixel.red >= threshold && pixel.green >= threshold && pixel.blue >= threshold {
                    white += 1
                }
                count += 1
            }
        }
        return count > 0 ? white / count : 0
    }

    func meanAbsoluteDifference(to other: FrameImage) -> Double {
        guard width == other.width, height == other.height else { return .nan }
        var total = 0.0
        var index = 0
        while index < pixels.count {
            total += abs(Double(pixels[index]) - Double(other.pixels[index]))
            index += 4
        }
        let samples = Double(pixels.count / 4)
        return samples > 0 ? total / samples / 255.0 : 0
    }
}

/// Extracts frames at exact presentation times and can persist them as PNG evidence.
final class FrameExtractor {
    private let generator: AVAssetImageGenerator
    private var imageCache: [Int: CGImage] = [:]
    private var frameCache: [Int: FrameImage] = [:]
    let outputDirectory: URL?
    private(set) var writtenPNGs: [URL] = []

    init(asset: AVAsset, outputDirectory: URL?) throws {
        generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = false
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        self.outputDirectory = outputDirectory
        if let outputDirectory {
            try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        }
    }

    static func frameIndex(forSeconds seconds: Double) -> Int {
        Int((seconds * Double(SpikeSpec.fps)).rounded())
    }

    private func image(atFrameIndex index: Int) throws -> CGImage {
        if let cached = imageCache[index] { return cached }
        let time = CMTime(value: CMTimeValue(index), timescale: SpikeSpec.fps)
        let result = try blockOnAsync { try await self.generator.image(at: time) }
        imageCache[index] = result.image
        return result.image
    }

    func frame(atSeconds seconds: Double) throws -> FrameImage {
        let index = FrameExtractor.frameIndex(forSeconds: seconds)
        if let cached = frameCache[index] { return cached }
        let frame = FrameImage(cgImage: try image(atFrameIndex: index))
        frameCache[index] = frame
        return frame
    }

    func writePNG(atSeconds seconds: Double, prefix: String) throws -> URL {
        let index = FrameExtractor.frameIndex(forSeconds: seconds)
        guard let outputDirectory else {
            throw SpikeError.ioFailure("no output directory for PNG evidence")
        }
        let url = outputDirectory.appendingPathComponent(String(format: "%@-t%05.2fs.png", prefix, seconds))
        try? FileManager.default.removeItem(at: url)
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL,
                                                               UTType.png.identifier as CFString, 1, nil) else {
            throw SpikeError.ioFailure("cannot create PNG destination at " + url.path)
        }
        CGImageDestinationAddImage(destination, try image(atFrameIndex: index), nil)
        guard CGImageDestinationFinalize(destination) else {
            throw SpikeError.ioFailure("cannot write PNG at " + url.path)
        }
        writtenPNGs.append(url)
        return url
    }
}
