import Foundation
import AVFoundation

// Line buffered so a redirected log shows progress while the experiment runs.
setvbuf(stdout, nil, _IOLBF, 0)

// Command line: video-whiteboard-spike all|generate|verify [options]
//
// Synthetic, local-only experiment. It never opens a camera or microphone, never contacts a
// network service, never reads product or family data, and writes only inside the given
// temporary output directory.

let sentinelName = ".siyue-video-whiteboard-spike"
let newline = String(UnicodeScalar(10))

struct Options {
    var command = "all"
    var mode: SpikeMode = .whiteboard
    var input: String?
    var outputDirectory = "/tmp/siyue-video-whiteboard-spike"
}

func parseOptions(_ arguments: [String]) throws -> Options {
    var options = Options()
    var index = 0
    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "all", "generate", "verify":
            options.command = argument
        case "--mode":
            index += 1
            guard index < arguments.count, let mode = SpikeMode(rawValue: arguments[index]) else {
                throw SpikeError.usage("--mode needs one of whiteboard|grid|negative")
            }
            options.mode = mode
        case "--input":
            index += 1
            guard index < arguments.count else { throw SpikeError.usage("--input needs a file path") }
            options.input = arguments[index]
        case "--output-dir":
            index += 1
            guard index < arguments.count else { throw SpikeError.usage("--output-dir needs a path") }
            options.outputDirectory = arguments[index]
        default:
            throw SpikeError.usage("unknown argument " + argument)
        }
        index += 1
    }
    return options
}

func prepareOutputDirectory(_ url: URL) throws {
    let path = url.standardizedFileURL.path
    let isTemporary = path.hasPrefix("/tmp/") || path.hasPrefix("/private/tmp/") || path.contains("/var/folders/")
    guard isTemporary, path.contains("video-whiteboard-spike") else {
        throw SpikeError.usage("output directory must be a dedicated temporary path containing "
                               + "video-whiteboard-spike, got " + path)
    }
    let fileManager = FileManager.default
    if fileManager.fileExists(atPath: path) {
        let contents = (try? fileManager.contentsOfDirectory(atPath: path)) ?? []
        if contents.isEmpty || contents.contains(sentinelName) {
            try fileManager.removeItem(at: url)
        } else {
            throw SpikeError.usage("refusing to delete a directory this spike did not create: " + path)
        }
    }
    try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    try Data(("siyue video whiteboard recording spike scratch" + newline).utf8)
        .write(to: url.appendingPathComponent(sentinelName))
}

func printChecks(_ title: String, _ records: [CheckRecord]) {
    print("-- checks: " + title)
    for record in records {
        let mark = record.passed ? "PASS" : "FAIL"
        print("  [" + mark + "] " + record.name + " | " + record.expectation + " | " + record.actual)
    }
}

func artifactRecord(role: String, url: URL) -> ArtifactRecord {
    ArtifactRecord(role: role, path: url.path,
                   bytes: SpikeIO.byteCount(of: url),
                   sha256: SpikeIO.sha256(of: url))
}

/// Confirms the two isolated source buses really carry different audio content.
func verifySourceBus(url: URL, expectLocal: Bool, label: String) -> [CheckRecord] {
    let log = CheckLog()
    do {
        let decoded = try AudioAnalysis.decode(asset: AVURLAsset(url: url))
        func tones(_ window: Range<Double>) -> (local: Double, remoteA: Double, remoteB: Double) {
            (AudioAnalysis.magnitude(samples: decoded.samples, sampleRate: decoded.sampleRate,
                                     frequency: SpikeSpec.localToneHz, window: window),
             AudioAnalysis.magnitude(samples: decoded.samples, sampleRate: decoded.sampleRate,
                                     frequency: SpikeSpec.remoteToneAHz, window: window),
             AudioAnalysis.magnitude(samples: decoded.samples, sampleRate: decoded.sampleRate,
                                     frequency: SpikeSpec.remoteToneBHz, window: window))
        }
        let early = tones(SpikeSpec.localOnlyWindow)
        let middle = tones(SpikeSpec.remoteOnlyWindow)
        let describe = String(format: "440 %.3f, 1200 %.3f, 1800 %.3f", early.local, early.remoteA, early.remoteB)
        let describeMiddle = String(format: "440 %.3f, 1200 %.3f, 1800 %.3f",
                                    middle.local, middle.remoteA, middle.remoteB)
        if expectLocal {
            log.record("source_bus_" + label + "_local_window",
                       expectation: "local bus carries 440 Hz only (>0.40 present, others <0.05)",
                       actual: describe,
                       passed: early.local >= 0.40 && early.remoteA <= 0.05 && early.remoteB <= 0.05)
            let silent = AudioAnalysis.peak(samples: decoded.samples, sampleRate: decoded.sampleRate,
                                            window: SpikeSpec.remoteOnlyWindow)
            log.record("source_bus_" + label + "_silent_stretch",
                       expectation: "local bus is silent while only the remote side talks (peak < 0.01)",
                       actual: String(format: "peak %.5f", silent),
                       passed: silent < 0.01)
        } else {
            log.record("source_bus_" + label + "_remote_window",
                       expectation: "remote bus carries 1200 Hz and 1800 Hz (>0.20 each, 440 Hz <0.05)",
                       actual: describeMiddle,
                       passed: middle.remoteA >= 0.20 && middle.remoteB >= 0.20 && middle.local <= 0.05)
            let silent = AudioAnalysis.peak(samples: decoded.samples, sampleRate: decoded.sampleRate,
                                            window: SpikeSpec.localOnlyWindow)
            log.record("source_bus_" + label + "_silent_stretch",
                       expectation: "remote bus is silent before the remote participants are audible (peak < 0.01)",
                       actual: String(format: "peak %.5f", silent),
                       passed: silent < 0.01)
        }
    } catch {
        log.record("source_bus_" + label + "_readable",
                   expectation: "source bus decodable",
                   actual: "error: " + String(describing: error),
                   passed: false)
    }
    return log.records
}

let limitations = [
    "Synthetic media only: frames and audio are generated in-process; no camera, microphone, screen capture or RTC stream is involved.",
    "macOS/AVFoundation container and codec behaviour only: nothing here validates Expo, iOS, iPadOS, Android or Electron capture paths.",
    "No background suspension, audio-session interruption, process kill, network loss or reconnect scenario was executed.",
    "No vendor SDK, no signalling, no five-device room, no consent flow and no upload were exercised.",
    "The whiteboard surface is drawn with Core Graphics vectors; it is not the Excalidraw DOM surface and it is not a screen recording.",
    "Audio/video alignment is only checked through container start times and the synthetic timeline; real RTC jitter, buffering and drift are out of scope.",
    "Generator and verifier share Spec.swift, so this checks that the muxing pipeline preserves the designed content, not that a vendor SDK can produce it.",
]

func runAll(outputDirectory: URL) throws -> SpikeReport {
    try prepareOutputDirectory(outputDirectory)
    let audioDirectory = outputDirectory.appendingPathComponent("audio")
    try FileManager.default.createDirectory(at: audioDirectory, withIntermediateDirectories: true)

    let localBus = AudioSynthesis.localBus()
    let remoteBus = AudioSynthesis.remoteBus()
    let localURL = audioDirectory.appendingPathComponent("local-bus.wav")
    let remoteURL = audioDirectory.appendingPathComponent("remote-bus.wav")
    try AudioSynthesis.writeWAV(samples: localBus, to: localURL)
    try AudioSynthesis.writeWAV(samples: remoteBus, to: remoteURL)

    let modes: [SpikeMode] = [.whiteboard, .grid, .negative]

    print("== generate ==")
    var artifacts = [artifactRecord(role: "source-audio-local", url: localURL),
                     artifactRecord(role: "source-audio-remote", url: remoteURL)]
    var writes: [WriteSummary] = []
    for mode in modes {
        let url = outputDirectory.appendingPathComponent(mode.fileName)
        let result = try MediaWriter.write(mode: mode, to: url,
                                           localBus: localBus, remoteBus: remoteBus,
                                           sampleRate: SpikeSpec.sampleRate,
                                           channels: SpikeSpec.channelCount)
        print(String(format: "  %-22@ frames=%3d audioSamples=%6d bytes=%8d  %@",
                     mode.displayName as NSString,
                     result.framesAppended,
                     result.audioSampleFramesAppended,
                     SpikeIO.byteCount(of: url),
                     url.lastPathComponent as NSString))
        let attemptText = result.attempts.map { attempt in
            attempt.outcome + "(" + String(format: "%.1fs frames=%d audioSamples=%d",
                                              attempt.seconds,
                                              attempt.framesAppended,
                                              attempt.audioSampleFramesAppended) + ")"
        }.joined(separator: " -> ")
        print("  attempts: " + attemptText)
        writes.append(WriteSummary(file: mode.fileName,
                                   framesAppended: result.framesAppended,
                                   audioSampleFramesAppended: result.audioSampleFramesAppended,
                                   attempts: result.attempts))
        artifacts.append(artifactRecord(role: "recording-" + mode.displayName, url: url))
    }

    print("== verify ==")
    var checks: [CheckRecord] = []
    for mode in modes where mode != .negative {
        let url = outputDirectory.appendingPathComponent(mode.fileName)
        let records = MediaVerifier(mode: mode, url: url, outputDirectory: outputDirectory).run()
        checks.append(contentsOf: records)
        printChecks(mode.displayName, records)
    }
    let busChecks = verifySourceBus(url: localURL, expectLocal: true, label: "local")
        + verifySourceBus(url: remoteURL, expectLocal: false, label: "remote")
    checks.append(contentsOf: busChecks)
    printChecks("isolated-source-buses", busChecks)

    print("== negative control: whiteboard expectations applied to a deficient file ==")
    let negativeURL = outputDirectory.appendingPathComponent(SpikeMode.negative.fileName)
    let negativeRecords = MediaVerifier(mode: .whiteboard, url: negativeURL,
                                        outputDirectory: outputDirectory,
                                        evidencePrefix: "negative-control").run()
    let observedFailures = negativeRecords.filter { !$0.passed }.map { $0.name }
    let requiredFailures = ["audio_track_count", "audio_decodable",
                            "whiteboard_white_fraction", "whiteboard_marker_at_0.50s",
                            "participant_local_color_at_0.50s", "participant_colors_distinguishable",
                            "frame_motion_nonzero"]
    let negativePassed = requiredFailures.allSatisfy { observedFailures.contains($0) }
    print("  required failures observed: "
          + String(requiredFailures.filter { observedFailures.contains($0) }.count)
          + "/" + String(requiredFailures.count))
    print("  negative control passed: " + String(describing: negativePassed))

    let framesDirectory = outputDirectory.appendingPathComponent("frames")
    let pngs = ((try? FileManager.default.contentsOfDirectory(at: framesDirectory,
                                                             includingPropertiesForKeys: nil)) ?? [])
        .filter { $0.pathExtension == "png" }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
    for png in pngs {
        artifacts.append(artifactRecord(role: "keyframe-png", url: png))
    }

    let report = SpikeReport(environment: SpikeIO.environment(outputDirectory: outputDirectory),
                             artifacts: artifacts,
                             writes: writes,
                             checks: checks,
                             negativeControlRequiredFailures: requiredFailures,
                             negativeControlObservedFailures: observedFailures,
                             negativeControlPassed: negativePassed,
                             passed: checks.allSatisfy { $0.passed } && negativePassed,
                             limitations: limitations)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(report).write(to: outputDirectory.appendingPathComponent("report.json"))
    return report
}

do {
    let options = try parseOptions(Array(CommandLine.arguments.dropFirst()))
    let outputURL = URL(fileURLWithPath: options.outputDirectory)
    switch options.command {
    case "all":
        let report = try runAll(outputDirectory: outputURL)
        let failed = report.checks.filter { !$0.passed }
        print("== summary ==")
        print("output directory: " + outputURL.standardizedFileURL.path)
        print("checks: " + String(report.checks.count - failed.count) + " passed, "
              + String(failed.count) + " failed")
        print("negative control: " + (report.negativeControlPassed ? "passed" : "FAILED"))
        print("overall: " + (report.passed ? "PASS" : "FAIL"))
        exit(report.passed ? 0 : 1)
    case "generate":
        try prepareOutputDirectory(outputURL)
        let url = outputURL.appendingPathComponent(options.mode.fileName)
        let result = try MediaWriter.write(mode: options.mode, to: url,
                                           localBus: AudioSynthesis.localBus(),
                                           remoteBus: AudioSynthesis.remoteBus(),
                                           sampleRate: SpikeSpec.sampleRate,
                                           channels: SpikeSpec.channelCount)
        print("wrote " + url.path + " frames=" + String(result.framesAppended))
    case "verify":
        guard let input = options.input else { throw SpikeError.usage("verify needs --input FILE") }
        let records = MediaVerifier(mode: options.mode, url: URL(fileURLWithPath: input),
                                    outputDirectory: nil).run()
        printChecks(options.mode.displayName, records)
        let failed = records.filter { !$0.passed }.count
        print("checks: " + String(records.count - failed) + " passed, " + String(failed) + " failed")
        exit(failed > 0 ? 1 : 0)
    default:
        throw SpikeError.usage("unknown command " + options.command)
    }
} catch {
    FileHandle.standardError.write(Data(("error: " + String(describing: error) + newline).utf8))
    exit(2)
}
