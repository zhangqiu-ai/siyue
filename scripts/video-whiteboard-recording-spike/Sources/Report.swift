import Foundation
import CryptoKit

struct CheckRecord: Codable {
    let name: String
    let expectation: String
    let actual: String
    let passed: Bool
}

final class CheckLog {
    private(set) var records: [CheckRecord] = []

    func record(_ name: String, expectation: String, actual: String, passed: Bool) {
        records.append(CheckRecord(name: name, expectation: expectation, actual: actual, passed: passed))
    }

    var passed: Bool { records.allSatisfy { $0.passed } }
    var failedNames: [String] { records.filter { !$0.passed }.map { $0.name } }
}

struct ArtifactRecord: Codable {
    let role: String
    let path: String
    let bytes: Int
    let sha256: String
}

/// One output file plus every whole-writer attempt that produced it. A recovered stall stays
/// visible here instead of disappearing into a passing run.
struct WriteSummary: Codable {
    let file: String
    let framesAppended: Int
    let audioSampleFramesAppended: Int
    let attempts: [WriteAttempt]
}

struct EnvironmentRecord: Codable {
    let generatedAtUTC: String
    let macOSVersion: String
    let architecture: String
    let swiftVersion: String
    let xcodeSdkVersion: String
    let videoCodec: String
    let audioCodec: String
    let mediaSupplyMechanism: String
    let frameWidth: Int
    let frameHeight: Int
    let fps: Int
    let nominalDurationSeconds: Double
    let outputDirectory: String
}

struct SpikeReport: Codable {
    let environment: EnvironmentRecord
    let artifacts: [ArtifactRecord]
    let writes: [WriteSummary]
    let checks: [CheckRecord]
    let negativeControlRequiredFailures: [String]
    let negativeControlObservedFailures: [String]
    let negativeControlPassed: Bool
    let passed: Bool
    let limitations: [String]
}

enum SpikeIO {
    static func shell(_ path: String, _ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            return "unavailable"
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func sha256(of url: URL) -> String {
        guard let data = try? Data(contentsOf: url) else { return "unavailable" }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func byteCount(of url: URL) -> Int {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.size] as? NSNumber)?.intValue ?? 0
    }

    static func environment(outputDirectory: URL) -> EnvironmentRecord {
        let swiftVersionLine = shell("/usr/bin/xcrun", ["swift", "--version"])
            .split(separator: "\n").first.map(String.init) ?? "unavailable"
        return EnvironmentRecord(
            generatedAtUTC: ISO8601DateFormatter().string(from: Date()),
            macOSVersion: shell("/usr/bin/sw_vers", ["-productVersion"]),
            architecture: shell("/usr/bin/uname", ["-m"]),
            swiftVersion: swiftVersionLine,
            xcodeSdkVersion: shell("/usr/bin/xcrun", ["--show-sdk-version", "--sdk", "macosx"]),
            videoCodec: MediaWriter.videoCodec.rawValue,
            audioCodec: MediaWriter.audioCodecName,
            mediaSupplyMechanism: MediaWriter.supplyMechanism,
            frameWidth: SpikeSpec.width,
            frameHeight: SpikeSpec.height,
            fps: Int(SpikeSpec.fps),
            nominalDurationSeconds: SpikeSpec.durationSeconds,
            outputDirectory: outputDirectory.path)
    }
}
