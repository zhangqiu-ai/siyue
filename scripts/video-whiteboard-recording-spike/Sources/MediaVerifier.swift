import Foundation
import AVFoundation
import CoreGraphics

/// Programmatic inspection of one recorded file: container/track structure, video timestamps,
/// audio content, and decoded keyframe pixels. Every expectation comes from Spec.swift.
final class MediaVerifier {
    let mode: SpikeMode
    let url: URL
    let outputDirectory: URL?
    let evidencePrefix: String
    let log = CheckLog()

    private var extractor: FrameExtractor?
    private let colorTolerance = 0.12

    init(mode: SpikeMode, url: URL, outputDirectory: URL?, evidencePrefix: String? = nil) {
        self.mode = mode
        self.url = url
        self.outputDirectory = outputDirectory
        self.evidencePrefix = evidencePrefix ?? mode.displayName
    }

    func run() -> [CheckRecord] {
        let asset = AVURLAsset(url: url)
        let bytes = SpikeIO.byteCount(of: url)
        log.record("artifact_present",
                   expectation: "recorded file exists with media data",
                   actual: "\(url.lastPathComponent) \(bytes) bytes",
                   passed: bytes > 4096)
        guard bytes > 4096 else { return log.records }

        checkContainerDuration(asset)
        checkTracks(asset)
        checkVideoTimeline(asset)
        checkAudio(asset)
        checkParticipantPixels()
        checkWhiteboardPixels()
        checkMotion()
        if outputDirectory != nil {
            let evidence = writeEvidenceFrames()
            let evidenceDetail = evidence.error == nil
                ? String(evidence.written) + " files"
                : String(evidence.written) + " files, first error: " + (evidence.error ?? "unknown")
            log.record("pixel_evidence_written",
                       expectation: "keyframe PNG evidence written for every sampled timestamp",
                       actual: evidenceDetail,
                       passed: evidence.error == nil && evidence.written == evidence.expected)
        }
        return log.records
    }

    // MARK: - Container and tracks

    private func checkContainerDuration(_ asset: AVAsset) {
        measure("container_duration",
                expectation: String(format: "%.2f s ±0.15", mode.expectedDurationSeconds)) {
            let duration = try blockOnAsync { try await asset.load(.duration) }
            let seconds = CMTimeGetSeconds(duration)
            let passed = abs(seconds - mode.expectedDurationSeconds) <= 0.15
            return (String(format: "%.3f s", seconds), passed)
        }
    }

    private func checkTracks(_ asset: AVAsset) {
        let videoTracks = (try? blockOnAsync { try await asset.loadTracks(withMediaType: .video) }) ?? []
        let audioTracks = (try? blockOnAsync { try await asset.loadTracks(withMediaType: .audio) }) ?? []

        log.record("video_track_count",
                   expectation: "exactly 1 video track",
                   actual: "\(videoTracks.count)",
                   passed: videoTracks.count == 1)
        log.record("audio_track_count",
                   expectation: mode.expectsAudio ? "exactly 1 audio track" : "no audio track",
                   actual: "\(audioTracks.count)",
                   passed: audioTracks.count == (mode.expectsAudio ? 1 : 0))

        if let track = videoTracks.first {
            measure("video_track_format",
                    expectation: "\(SpikeSpec.width)x\(SpikeSpec.height) avc1") {
                let descriptions = try blockOnAsync { try await track.load(.formatDescriptions) }
                guard let description = descriptions.first else {
                    throw SpikeError.verificationFailure("video track has no format description")
                }
                let size = CMVideoFormatDescriptionGetDimensions(description)
                let subtype = MediaVerifier.fourCC(CMFormatDescriptionGetMediaSubType(description))
                let actual = "\(size.width)x\(size.height) \(subtype)"
                let passed = size.width == Int32(SpikeSpec.width)
                    && size.height == Int32(SpikeSpec.height)
                    && subtype == "avc1"
                return (actual, passed)
            }
        }

        if let track = audioTracks.first {
            measure("audio_track_format",
                    expectation: "48000 Hz, 2 channels, aac") {
                let descriptions = try blockOnAsync { try await track.load(.formatDescriptions) }
                guard let description = descriptions.first,
                      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description) else {
                    throw SpikeError.verificationFailure("audio track has no ASBD")
                }
                let subtype = MediaVerifier.fourCC(CMFormatDescriptionGetMediaSubType(description))
                let actual = String(format: "%.0f Hz, %u ch, %@",
                                    asbd.pointee.mSampleRate,
                                    asbd.pointee.mChannelsPerFrame,
                                    subtype)
                let passed = abs(asbd.pointee.mSampleRate - SpikeSpec.sampleRate) < 1
                    && asbd.pointee.mChannelsPerFrame == UInt32(SpikeSpec.channelCount)
                    && subtype == "aac "
                return (actual, passed)
            }
        }

        if videoTracks.count == 1, audioTracks.count == 1 {
            measure("track_durations_aligned",
                    expectation: "video and audio track duration differ by <= 0.10 s") {
                let videoRange = try blockOnAsync { try await videoTracks[0].load(.timeRange) }
                let audioRange = try blockOnAsync { try await audioTracks[0].load(.timeRange) }
                let videoSeconds = CMTimeGetSeconds(videoRange.duration)
                let audioSeconds = CMTimeGetSeconds(audioRange.duration)
                return (String(format: "video %.3f s, audio %.3f s, delta %.3f s",
                               videoSeconds, audioSeconds, abs(videoSeconds - audioSeconds)),
                        abs(videoSeconds - audioSeconds) <= 0.10)
            }
        }
    }

    // MARK: - Video timestamps

    private func checkVideoTimeline(_ asset: AVAsset) {
        var samples: [(pts: Double, duration: Double, bytes: Int)] = []
        do {
            let track = try blockOnAsync { try await asset.loadTracks(withMediaType: .video) }.first
            guard let track else { throw SpikeError.verificationFailure("no video track") }
            let reader = try AVAssetReader(asset: asset)
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
            guard reader.canAdd(output) else {
                throw SpikeError.verificationFailure("AVAssetReader rejected the video output")
            }
            reader.add(output)
            guard reader.startReading() else {
                throw SpikeError.verificationFailure("AVAssetReader did not start reading video")
            }
            while let sampleBuffer = output.copyNextSampleBuffer() {
                samples.append((pts: CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)),
                                duration: CMTimeGetSeconds(CMSampleBufferGetDuration(sampleBuffer)),
                                bytes: CMSampleBufferGetTotalSampleSize(sampleBuffer)))
            }
            if reader.status == .failed {
                throw SpikeError.verificationFailure("video read failed: "
                                                     + String(describing: reader.error))
            }
        } catch {
            log.record("video_timeline_readable",
                       expectation: "compressed video samples readable",
                       actual: "error: " + String(describing: error),
                       passed: false)
            return
        }

        // Passthrough reading returns storage order; presentation order is the sorted PTS list.
        let coded = samples.filter { $0.bytes > 0 && $0.duration > 0 }
        let emptySamples = samples.count - coded.count
        let times = coded.map { $0.pts }.sorted()

        log.record("video_timeline_readable",
                   expectation: "compressed video samples readable",
                   actual: "\(samples.count) stored samples, \(coded.count) coded frames",
                   passed: !samples.isEmpty)
        if emptySamples > 0 {
            // Apple's muxer pads the stored sample table; reported as a note, not asserted.
            print("  note: \(emptySamples) empty stored samples accompany the coded frames")
        }
        log.record("video_frame_count",
                   expectation: "\(mode.expectedFrameCount) frames",
                   actual: "\(times.count)",
                   passed: times.count == mode.expectedFrameCount)
        let monotonic = zip(times, times.dropFirst()).allSatisfy { $0 < $1 }
        log.record("video_timestamps_monotonic",
                   expectation: "strictly increasing presentation times",
                   actual: monotonic ? "increasing" : "not increasing",
                   passed: monotonic)
        let first = times.first ?? -1
        log.record("video_first_pts_near_zero",
                   expectation: "0.000 s ±0.050",
                   actual: String(format: "%.4f s", first),
                   passed: abs(first) <= 0.05)

        let deltas = zip(times, times.dropFirst()).map { $1 - $0 }
        let sorted = deltas.sorted()
        let median = sorted.isEmpty ? 0 : sorted[sorted.count / 2]
        log.record("video_frame_interval",
                   expectation: "median 0.03333 s ±0.004",
                   actual: String(format: "%.5f s", median),
                   passed: abs(median - 1.0 / Double(SpikeSpec.fps)) <= 0.004)

        let maxDelta = deltas.max() ?? 0
        log.record("video_pts_continuous",
                   expectation: "no presentation gap larger than 0.10 s",
                   actual: String(format: "%.4f s", maxDelta),
                   passed: maxDelta <= 0.10)

        measure("video_decoded_frame_count",
                expectation: "\(mode.expectedFrameCount) frames decode from the video track") {
            guard let track = try blockOnAsync({ try await asset.loadTracks(withMediaType: .video) }).first else {
                throw SpikeError.verificationFailure("no video track")
            }
            let reader = try AVAssetReader(asset: asset)
            let settings: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
            guard reader.canAdd(output) else {
                throw SpikeError.verificationFailure("AVAssetReader rejected the decoding output")
            }
            reader.add(output)
            guard reader.startReading() else {
                throw SpikeError.verificationFailure("AVAssetReader did not start decoding video")
            }
            var count = 0
            while output.copyNextSampleBuffer() != nil { count += 1 }
            if reader.status == .failed {
                throw SpikeError.verificationFailure("decoded video read failed: "
                                                     + String(describing: reader.error))
            }
            return ("\(count) decoded frames", count == mode.expectedFrameCount)
        }
    }

    // MARK: - Audio content

    private func checkAudio(_ asset: AVAsset) {
        guard mode.expectsAudio else { return }
        do {
            let decoded = try AudioAnalysis.decode(asset: asset)
            let expectedSamples = mode.expectedDurationSeconds * decoded.sampleRate
            let deviation = abs(Double(decoded.samples.count) - expectedSamples) / expectedSamples
            log.record("audio_sample_count",
                       expectation: String(format: "%.0f samples ±2%%", expectedSamples),
                       actual: "\(decoded.samples.count) samples",
                       passed: deviation <= 0.02)
            log.record("audio_peak_level",
                       expectation: "peak in 0.30 ... 0.99 (audible, not clipped)",
                       actual: String(format: "%.3f", decoded.peak),
                       passed: decoded.peak >= 0.30 && decoded.peak <= 0.99)
            guard decoded.samples.count > 1_000 else {
                throw SpikeError.verificationFailure("decoded audio too short to analyse")
            }

            let localOnly = toneSet(decoded, window: SpikeSpec.localOnlyWindow)
            log.record("audio_local_only_window",
                       expectation: "440 Hz present (>0.30), 1200/1800 Hz absent (<0.08)",
                       actual: formatTones(localOnly),
                       passed: localOnly.local >= 0.30
                           && localOnly.remoteA <= 0.08
                           && localOnly.remoteB <= 0.08)

            let remoteOnly = toneSet(decoded, window: SpikeSpec.remoteOnlyWindow)
            log.record("audio_remote_only_window",
                       expectation: "1200 Hz and 1800 Hz present (>0.18), 440 Hz absent (<0.08)",
                       actual: formatTones(remoteOnly),
                       passed: remoteOnly.remoteA >= 0.18
                           && remoteOnly.remoteB >= 0.18
                           && remoteOnly.local <= 0.08)

            let mixed = toneSet(decoded, window: SpikeSpec.mixedWindow)
            log.record("audio_mixed_window",
                       expectation: "440 Hz, 1200 Hz and 1800 Hz all present (>0.18 / >0.14)",
                       actual: formatTones(mixed),
                       passed: mixed.local >= 0.18 && mixed.remoteA >= 0.14 && mixed.remoteB >= 0.14)

            let late = toneSet(decoded, window: SpikeSpec.lateMixedWindow)
            log.record("audio_late_mixed_window",
                       expectation: "after 4.0 s both buses are audible again (remote 1200/1800 Hz > 0.14)",
                       actual: formatTones(late),
                       passed: late.local >= 0.18 && late.remoteA >= 0.14 && late.remoteB >= 0.14)

        } catch {
            log.record("audio_decodable",
                       expectation: "audio track decodable to PCM",
                       actual: "error: " + String(describing: error),
                       passed: false)
        }
    }

    private struct ToneSet {
        let local: Double
        let remoteA: Double
        let remoteB: Double
    }

    private func toneSet(_ decoded: DecodedAudio, window: Range<Double>) -> ToneSet {
        ToneSet(local: AudioAnalysis.magnitude(samples: decoded.samples, sampleRate: decoded.sampleRate,
                                               frequency: SpikeSpec.localToneHz, window: window),
                remoteA: AudioAnalysis.magnitude(samples: decoded.samples, sampleRate: decoded.sampleRate,
                                                 frequency: SpikeSpec.remoteToneAHz, window: window),
                remoteB: AudioAnalysis.magnitude(samples: decoded.samples, sampleRate: decoded.sampleRate,
                                                 frequency: SpikeSpec.remoteToneBHz, window: window))
    }

    private func formatTones(_ tones: ToneSet) -> String {
        String(format: "440 Hz %.3f, 1200 Hz %.3f, 1800 Hz %.3f",
               tones.local, tones.remoteA, tones.remoteB)
    }

    // MARK: - Pixel checks

    private func frame(_ seconds: Double) throws -> FrameImage {
        if extractor == nil {
            let framesDirectory = outputDirectory?.appendingPathComponent("frames")
            extractor = try FrameExtractor(asset: AVURLAsset(url: url), outputDirectory: framesDirectory)
        }
        return try extractor!.frame(atSeconds: seconds)
    }

    private func checkParticipantPixels() {
        let sources = SpikeSpec.participants(for: mode)
        let rects = SpikeSpec.participantRects(for: mode)
        guard !sources.isEmpty else { return }

        for (source, rect) in zip(sources, rects) {
            measure("participant_\(source.id)_color_at_0.50s",
                    expectation: String(format: "mean RGB within ±%.2f of base colour x brightness", colorTolerance)) {
                let image = try frame(0.5)
                let measured = image.mean(centerX: rect.centerX, centerY: rect.centerY, box: 40)
                let expected = source.color(at: 0.5)
                let deviation = max(abs(measured.red - expected.red),
                                    max(abs(measured.green - expected.green),
                                        abs(measured.blue - expected.blue)))
                return (String(format: "measured (%.3f, %.3f, %.3f), expected (%.3f, %.3f, %.3f), maxdev %.3f",
                               measured.red, measured.green, measured.blue,
                               expected.red, expected.green, expected.blue, deviation),
                        deviation <= colorTolerance)
            }
        }

        measure("participant_colors_distinguishable",
                expectation: "nearest hue template of each tile equals its own source, with positive margin") {
            let image = try frame(0.5)
            var classified: [String] = []
            var margins: [Double] = []
            for (_, rect) in zip(sources, rects) {
                let measured = image.mean(centerX: rect.centerX, centerY: rect.centerY, box: 40)
                let scores = sources.map { candidate -> (id: String, score: Double) in
                    (candidate.id, MediaVerifier.cosine(measured, candidate.normalizedTemplate))
                }.sorted { $0.score > $1.score }
                classified.append(scores[0].id)
                margins.append(scores[0].score - scores[1].score)
            }
            let expectedIds = sources.map { $0.id }
            let passed = classified == expectedIds && margins.allSatisfy { $0 > 0.0 }
            let marginText = margins.map { String(format: "%.4f", $0) }.joined(separator: ", ")
            return ("classified [\(classified.joined(separator: ", "))], margins [\(marginText)]", passed)
        }

        for (source, rect) in zip(sources, rects) {
            measure("participant_\(source.id)_temporal_activity",
                    expectation: "brightness follows the source modulation (measured spread >= 50% of expected)") {
                let grid = stride(from: 0.05, through: SpikeSpec.durationSeconds - 0.05, by: 0.05).map { $0 }
                let samples = grid.map { (seconds: $0, brightness: source.brightness(at: $0)) }
                guard let high = samples.max(by: { $0.brightness < $1.brightness }),
                      let low = samples.min(by: { $0.brightness < $1.brightness }) else {
                    throw SpikeError.verificationFailure("no modulation samples")
                }
                let expectedSpread = (high.brightness - low.brightness) * max(source.red, max(source.green, source.blue))
                let highColor = try frame(high.seconds).mean(centerX: rect.centerX, centerY: rect.centerY, box: 40)
                let lowColor = try frame(low.seconds).mean(centerX: rect.centerX, centerY: rect.centerY, box: 40)
                let highMax = max(highColor.red, max(highColor.green, highColor.blue))
                let lowMax = max(lowColor.red, max(lowColor.green, lowColor.blue))
                let measuredSpread = highMax - lowMax
                let passed = expectedSpread > 0.10 && measuredSpread >= 0.5 * expectedSpread
                return (String(format: "t=%.2fs max %.3f, t=%.2fs max %.3f, spread %.3f (expected %.3f)",
                               high.seconds, highMax, low.seconds, lowMax, measuredSpread, expectedSpread),
                        passed)
            }
        }
    }

    private func checkWhiteboardPixels() {
        guard mode.hasWhiteboard else { return }

        measure("whiteboard_white_fraction",
                expectation: "board area away from annotations stays white (>= 0.60 of pixels >= 0.85)") {
            let image = try frame(2.5)
            let fraction = image.whiteFraction(rect: SpikeSpec.boardWhiteRegion, threshold: 0.85)
            return (String(format: "%.3f", fraction), fraction >= 0.60)
        }

        measure("whiteboard_problem_image_color",
                expectation: String(format: "mean RGB within ±%.2f of the pinned yellow-cream sheet", colorTolerance)) {
            let image = try frame(2.5)
            let measured = image.mean(centerX: SpikeSpec.problemRect.centerX,
                                      centerY: SpikeSpec.problemRect.centerY, box: 40)
            let expected = SpikeSpec.problemColor
            let deviation = max(abs(measured.red - expected.red),
                                max(abs(measured.green - expected.green),
                                    abs(measured.blue - expected.blue)))
            return (String(format: "measured (%.3f, %.3f, %.3f), expected (%.3f, %.3f, %.3f), maxdev %.3f",
                           measured.red, measured.green, measured.blue,
                           expected.red, expected.green, expected.blue, deviation),
                    deviation <= colorTolerance)
        }

        measure("whiteboard_stroke_start_at_0.50s",
                expectation: "ink already present at the stroke origin at t=0.50 s") {
            let image = try frame(0.5)
            let fraction = image.fraction(centerX: SpikeSpec.strokeStart.x, centerY: SpikeSpec.strokeStart.y,
                                          box: 30, matching: MediaVerifier.isInk)
            return (String(format: "ink fraction %.3f", fraction), fraction >= 0.10)
        }

        measure("whiteboard_stroke_end_absent_at_0.50s",
                expectation: "stroke end not drawn yet at t=0.50 s (< 0.02 ink)") {
            let image = try frame(0.5)
            let fraction = image.fraction(centerX: SpikeSpec.strokeEnd.x, centerY: SpikeSpec.strokeEnd.y,
                                          box: 30, matching: MediaVerifier.isInk)
            return (String(format: "ink fraction %.3f", fraction), fraction <= 0.02)
        }

        measure("whiteboard_stroke_end_present_at_3.50s",
                expectation: "stroke reaches its end by t=3.50 s (>= 0.10 ink)") {
            let image = try frame(3.5)
            let fraction = image.fraction(centerX: SpikeSpec.strokeEnd.x, centerY: SpikeSpec.strokeEnd.y,
                                          box: 30, matching: MediaVerifier.isInk)
            return (String(format: "ink fraction %.3f", fraction), fraction >= 0.10)
        }

        measure("whiteboard_marker_at_0.50s",
                expectation: "sliding marker is at its expected position at t=0.50 s (>= 0.80 dark)") {
            let image = try frame(0.5)
            let rect = SpikeSpec.markerRect(at: 0.5)
            let fraction = image.fraction(centerX: rect.centerX, centerY: rect.centerY,
                                          box: 16, matching: MediaVerifier.isMarker)
            return (String(format: "x=%.1f, dark fraction %.3f", rect.centerX, fraction), fraction >= 0.80)
        }

        measure("whiteboard_marker_at_3.00s",
                expectation: "sliding marker is at its expected position at t=3.00 s (>= 0.80 dark)") {
            let image = try frame(3.0)
            let rect = SpikeSpec.markerRect(at: 3.0)
            let fraction = image.fraction(centerX: rect.centerX, centerY: rect.centerY,
                                          box: 16, matching: MediaVerifier.isMarker)
            return (String(format: "x=%.1f, dark fraction %.3f", rect.centerX, fraction), fraction >= 0.80)
        }

    }

    private func checkMotion() {
        measure("frame_motion_nonzero",
                expectation: "consecutive frames differ (mean abs delta > 0.0005)") {
            let first = try frame(0.5)
            let second = try frame(0.5 + 1.0 / Double(SpikeSpec.fps))
            let difference = first.meanAbsoluteDifference(to: second)
            return (String(format: "mean abs delta %.5f", difference), difference > 0.0005)
        }
    }

    private func writeEvidenceFrames() -> (written: Int, expected: Int, error: String?) {
        guard outputDirectory != nil else { return (0, 0, "no output directory") }
        let secondsList = mode.hasWhiteboard || mode == .grid ? [0.5, 2.5, 5.0] : [0.5]
        var firstError: String?
        for seconds in secondsList {
            do {
                _ = try extractor?.writePNG(atSeconds: seconds, prefix: evidencePrefix)
            } catch {
                if firstError == nil { firstError = String(describing: error) }
            }
        }
        return (extractor?.writtenPNGs.count ?? 0, secondsList.count, firstError)
    }

    // MARK: - Helpers

    private func measure(_ name: String, expectation: String,
                         _ body: () throws -> (actual: String, passed: Bool)) {
        do {
            let result = try body()
            log.record(name, expectation: expectation, actual: result.actual, passed: result.passed)
        } catch {
            log.record(name, expectation: expectation,
                       actual: "error: " + String(describing: error), passed: false)
        }
    }

    private static func fourCC(_ code: FourCharCode) -> String {
        let bytes: [UInt8] = [UInt8((code >> 24) & 0xFF), UInt8((code >> 16) & 0xFF),
                              UInt8((code >> 8) & 0xFF), UInt8(code & 0xFF)]
        return String(bytes: bytes, encoding: .ascii) ?? "????"
    }

    private static func cosine(_ measured: (red: Double, green: Double, blue: Double),
                               _ template: (red: Double, green: Double, blue: Double)) -> Double {
        let measuredLength = (measured.red * measured.red + measured.green * measured.green
                              + measured.blue * measured.blue).squareRoot()
        guard measuredLength > 0 else { return 0 }
        return (measured.red * template.red + measured.green * template.green
                + measured.blue * template.blue) / measuredLength
    }

    private static func isInk(_ red: Double, _ green: Double, _ blue: Double) -> Bool {
        blue > 0.30 && blue > red + 0.12 && red < 0.45
    }

    private static func isMarker(_ red: Double, _ green: Double, _ blue: Double) -> Bool {
        max(red, max(green, blue)) < 0.30
    }
}
