import Foundation
import AVFoundation
import CoreGraphics

/// One whole-writer attempt for a single output file.
///
/// Every attempt is recorded in stdout and in report.json, so the bounded rebuild below stays
/// visible as evidence instead of hiding a stalled attempt.
struct WriteAttempt: Codable {
    /// 1-based attempt number within one output file.
    let attempt: Int
    /// "completed", "stalled", "failed" or "refused".
    let outcome: String
    let framesAppended: Int
    let audioSampleFramesAppended: Int
    let seconds: Double
    let note: String
}

/// Raised when `finishWritingWithCompletionHandler:` does not report completion inside its budget.
///
/// The completion handler may still fire afterwards, which is why this failure is terminal: the
/// writer may keep writing to the URL, so the file must not be rebuilt in this process.
struct MediaWriterFinishTimedOut: Error, TerminalWriteFailure, CustomStringConvertible {
    let attempt: Int
    let framesAppended: Int
    let audioSampleFramesAppended: Int
    let waitedSeconds: Double

    var description: String {
        "finishWriting did not complete within " + String(format: "%.1f", waitedSeconds)
            + " s on attempt " + String(attempt) + " (framesAppended=" + String(framesAppended)
            + ", audioSamplesAppended=" + String(audioSampleFramesAppended)
            + "); the writer may still be finalising that file, so the file is not rebuilt"
    }
}

struct MediaWriteResult {
    let url: URL
    let videoCodec: String
    let audioCodec: String?
    let dimensions: (width: Int, height: Int)
    let framesAppended: Int
    let audioSampleFramesAppended: Int
    let attempts: [WriteAttempt]

}

/// Raised when an attempt hands no media data to the writer for longer than the bounded budget.
struct MediaWriterStall: Error, CustomStringConvertible {
    let attempt: Int
    let framesAppended: Int
    let audioSampleFramesAppended: Int
    let secondsWithoutProgress: Double
    let detail: String

    var description: String {
        "no append progress for " + String(format: "%.1f", secondsWithoutProgress)
            + " s on attempt " + String(attempt) + " (framesAppended=" + String(framesAppended)
            + ", audioSamplesAppended=" + String(audioSampleFramesAppended) + "): " + detail
    }
}

/// Marker for failures that must end the file immediately instead of being retried.
///
/// A retry would rebuild the same URL while the writer from the failed attempt may still be
/// appending or finishing that file, so `write()` records the attempt and stops.
protocol TerminalWriteFailure: Error {}

/// Raised when an attempt cannot be torn down safely: a supply block is still inside an
/// AVAssetWriter call, so cancelling or finishing the writer could run concurrently with an append.
///
/// This failure is terminal for the file. The wedged block belongs to the abandoned attempt, so a
/// rebuild would race it; the partially written file is left in place and reported instead.
struct MediaWriterTearDownRefused: Error, TerminalWriteFailure, CustomStringConvertible {
    let attempt: Int
    let framesAppended: Int
    let audioSampleFramesAppended: Int
    let waitedSeconds: Double
    let detail: String

    var description: String {
        "refused to cancel/finish attempt " + String(attempt) + " after waiting "
            + String(format: "%.1f", waitedSeconds) + " s for supply blocks to stop (framesAppended="
            + String(framesAppended) + ", audioSamplesAppended=" + String(audioSampleFramesAppended)
            + "): " + detail
    }
}

/// Muxes the synthetic video and the mixed audio into a single local file with AVAssetWriter.
///
/// This is the C10 shape under test: one container, one video track that already contains the
/// whiteboard main picture plus participant thumbnails, and one audio track that already contains
/// the local and remote buses mixed.
///
/// Media data is supplied through requestMediaDataWhenReady(on:using:), one block and one serial
/// queue per input, which is the mechanism AVFoundation documents for a non-real-time source. The
/// earlier implementation polled the video input from a single supplying thread; with two tracks
/// the writer's ideal interleaving pattern can then need data for the *other* track before it
/// accepts more video, so the poll never returns. That is recorded in the round-1 evidence: a
/// sampled stall showed video.ready=false / audio.ready=true with every CoreMedia thread idle.
enum MediaWriter {
    static let videoCodec = AVVideoCodecType.h264
    static let audioCodecName = "aac"

    /// Documented mechanism used to hand media data to the writer inputs.
    static let supplyMechanism = "requestMediaDataWhenReady(on:using:) per input, one serial queue each"

    /// An attempt that appends nothing for this long is treated as stalled. The budget is reported
    /// in the error, in stdout and in report.json; it is never silently retried into a pass.
    static let stallTimeoutSeconds = 10.0

    /// Whole-writer attempts per file: the original attempt plus at most one full rebuild.
    static let defaultMaxAttempts = 2

    /// `SPIKE_MAX_WRITE_ATTEMPTS` is the only override, and its value is clamped to 1...2: `1`
    /// disables the rebuild, anything larger (or unparsable) falls back to the bounded default 2.
    static var maxAttempts: Int {
        guard let raw = ProcessInfo.processInfo.environment["SPIKE_MAX_WRITE_ATTEMPTS"],
              let value = Int(raw) else {
            return defaultMaxAttempts
        }
        return min(defaultMaxAttempts, max(1, value))
    }

    /// Test-only fault injection, off unless set: keeps the first audio supply block in flight for
    /// this many seconds. From the observer that is indistinguishable from a block still sitting
    /// inside a writer call, so it executes the "refuse to cancel while an append may be active"
    /// path on purpose. It never changes what is asserted.
    static var holdAudioBlockSeconds: Double {
        if let raw = ProcessInfo.processInfo.environment["SPIKE_HOLD_AUDIO_BLOCK_SECONDS"],
           let value = Double(raw), value > 0 {
            return value
        }
        return 0
    }

    /// How long `finishWritingWithCompletionHandler:` may take before the attempt is declared
    /// failed. The documented API can take a long time, so this stays generous for a 6 s file; the
    /// point is that no wait in this file is unbounded.
    static let finishWritingTimeoutSeconds = 20.0

    /// How long an aborted attempt waits for its supply blocks to leave AVAssetWriter calls before
    /// it refuses to cancel the writer. Bounded, and never traded for an unsafe cancel.
    static let supplierStopTimeoutSeconds = 2.0

    /// Test-only fault injection, off unless set: abandons that attempt mid-write with a stall so
    /// the bounded rebuild path can be exercised on purpose. It never changes what is asserted.
    static var forcedStallAttempt: Int? {
        if let raw = ProcessInfo.processInfo.environment["SPIKE_FORCE_STALL_ATTEMPT"],
           let value = Int(raw), value >= 1 {
            return value
        }
        return nil
    }

    static func write(mode: SpikeMode, to url: URL,
                      localBus: [Float], remoteBus: [Float],
                      sampleRate: Double, channels: Int) throws -> MediaWriteResult {
        var attempts: [WriteAttempt] = []
        var lastError: Error?

        for attempt in 1...maxAttempts {
            let started = Date()
            do {
                let outcome = try writeOnce(mode: mode, to: url, localBus: localBus, remoteBus: remoteBus,
                                            sampleRate: sampleRate, channels: channels, attempt: attempt)
                attempts.append(WriteAttempt(attempt: attempt,
                                             outcome: "completed",
                                             framesAppended: outcome.framesAppended,
                                             audioSampleFramesAppended: outcome.audioSampleFramesAppended,
                                             seconds: Date().timeIntervalSince(started),
                                             note: ""))
                return MediaWriteResult(url: url,
                                        videoCodec: videoCodec.rawValue,
                                        audioCodec: mode.expectsAudio ? audioCodecName : nil,
                                        dimensions: (SpikeSpec.width, SpikeSpec.height),
                                        framesAppended: outcome.framesAppended,
                                        audioSampleFramesAppended: outcome.audioSampleFramesAppended,
                                        attempts: attempts)
            } catch {
                lastError = error
                let stall = error as? MediaWriterStall
                let refused = error as? MediaWriterTearDownRefused
                let finishTimeout = error as? MediaWriterFinishTimedOut
                let outcome: String
                if refused != nil { outcome = "refused" }
                else if finishTimeout != nil { outcome = "finish_timeout" }
                else if stall != nil { outcome = "stalled" }
                else { outcome = "failed" }
                let note = (stall?.description ?? refused?.description ?? finishTimeout?.description)
                    ?? String(describing: error)
                attempts.append(WriteAttempt(attempt: attempt,
                                             outcome: outcome,
                                             framesAppended: stall?.framesAppended ?? refused?.framesAppended
                                                 ?? finishTimeout?.framesAppended ?? 0,
                                             audioSampleFramesAppended: stall?.audioSampleFramesAppended
                                                 ?? refused?.audioSampleFramesAppended
                                                 ?? finishTimeout?.audioSampleFramesAppended ?? 0,
                                             seconds: Date().timeIntervalSince(started),
                                             note: note))
                writeDiagnostic("  attempt " + String(attempt) + "/" + String(maxAttempts) + " for "
                                + mode.fileName + " "
                                + outcome
                                + " after " + String(format: "%.1f", Date().timeIntervalSince(started))
                                + " s: " + note)
                if error is TerminalWriteFailure {
                    // Terminal: the writer from this attempt may still be appending to or finalising
                    // the same URL, so rebuilding it here would race that writer. Fail the file.
                    throw error
                }

            }
        }
        throw lastError ?? SpikeError.ioFailure("no write attempt was made for " + mode.fileName)
    }

    /// Stall and failure notices go to stderr so a recovered attempt is never invisible.
    private static func writeDiagnostic(_ message: String) {
        FileHandle.standardError.write(Data((message + newline).utf8))
    }

    private struct AttemptOutcome {
        let framesAppended: Int
        let audioSampleFramesAppended: Int
    }

    private static func writeOnce(mode: SpikeMode, to url: URL,
                                 localBus: [Float], remoteBus: [Float],
                                 sampleRate: Double, channels: Int,
                                 attempt: Int) throws -> AttemptOutcome {
        try? FileManager.default.removeItem(at: url)

        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: videoCodec,
            AVVideoWidthKey: SpikeSpec.width,
            AVVideoHeightKey: SpikeSpec.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 4_000_000,
                AVVideoExpectedSourceFrameRateKey: Int(SpikeSpec.fps),
                AVVideoMaxKeyFrameIntervalKey: Int(SpikeSpec.fps),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                // Without this the encoder emits B-frame reordering plus empty leading samples,
                // so a passthrough reader reports 184 stored samples for 180 frames.
                AVVideoAllowFrameReorderingKey: false,
            ],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: SpikeSpec.width,
                kCVPixelBufferHeightKey as String: SpikeSpec.height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as CFDictionary,
            ])

        var audioInput: AVAssetWriterInput?
        if mode.expectsAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: 128_000,
            ]
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            input.expectsMediaDataInRealTime = false
            audioInput = input
        }

        guard writer.canAdd(videoInput) else {
            throw SpikeError.ioFailure("AVAssetWriter rejected the video input")
        }
        writer.add(videoInput)
        if let audioInput {
            guard writer.canAdd(audioInput) else {
                throw SpikeError.ioFailure("AVAssetWriter rejected the audio input")
            }
            writer.add(audioInput)
        }

        guard writer.startWriting() else {
            throw SpikeError.ioFailure("startWriting failed: " + String(describing: writer.error))
        }
        writer.startSession(atSourceTime: .zero)

        let poolAttributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: SpikeSpec.width,
            kCVPixelBufferHeightKey as String: SpikeSpec.height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as CFDictionary,
        ]
        var pool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(nil, nil, poolAttributes as CFDictionary, &pool)
        guard let pixelBufferPool = pool else {
            throw SpikeError.ioFailure("cannot create pixel buffer pool")
        }

        let samplesPerFrame = Int((sampleRate / Double(SpikeSpec.fps)).rounded())
        let mixed = AudioSynthesis.masterMix(local: localBus, remote: remoteBus)
        let holdAudioBlockSeconds = MediaWriter.holdAudioBlockSeconds
        let audioFormat = try makeAudioFormat(sampleRate: sampleRate, channels: channels)

        let state = SupplyState(videoFrameCount: mode.expectedFrameCount,
                                audioChunkCount: audioInput == nil ? 0 : mode.expectedFrameCount,
                                samplesPerFrame: samplesPerFrame)
        let videoQueue = DispatchQueue(label: "com.siyue.video-whiteboard-spike.supply.video")
        let audioQueue = DispatchQueue(label: "com.siyue.video-whiteboard-spike.supply.audio")

        videoInput.requestMediaDataWhenReady(on: videoQueue) {
            state.withSupplier(.video) {
                while videoInput.isReadyForMoreMediaData && !state.isStopped {
                    guard let frameIndex = state.nextVideoFrameIndex() else {
                        videoInput.markAsFinished()
                        state.finish(.video)
                        return
                    }
                    guard let buffer = makePixelBuffer(pool: pixelBufferPool, mode: mode,
                                                       frameIndex: frameIndex) else {
                        state.recordFailure(SpikeError.ioFailure("cannot render pixel buffer for frame "
                                                                 + String(frameIndex)))
                        return
                    }
                    let videoTime = CMTime(value: CMTimeValue(frameIndex), timescale: SpikeSpec.fps)
                    guard adaptor.append(buffer, withPresentationTime: videoTime) else {
                        state.recordFailure(SpikeError.ioFailure("video append failed at frame "
                                                                 + String(frameIndex) + ": "
                                                                 + String(describing: writer.error)))
                        return
                    }
                    state.recordVideoAppended()
                }
            }
        }

        if let audioInput {
            audioInput.requestMediaDataWhenReady(on: audioQueue) {
                state.withSupplier(.audio) {
                    state.holdFirstInvocation(of: .audio, seconds: holdAudioBlockSeconds)
                    while audioInput.isReadyForMoreMediaData && !state.isStopped {
                        guard let chunk = state.nextAudioChunkIndex() else {
                            audioInput.markAsFinished()
                            state.finish(.audio)
                            return
                        }
                        do {
                            let sampleBuffer = try makeAudioSampleBuffer(mixed: mixed,
                                                                        startSample: chunk * samplesPerFrame,
                                                                        sampleCount: samplesPerFrame,
                                                                        sampleRate: sampleRate,
                                                                        channels: channels,
                                                                        format: audioFormat)
                            guard audioInput.append(sampleBuffer) else {
                                state.recordFailure(SpikeError.ioFailure("audio append failed at sample "
                                                                         + String(chunk * samplesPerFrame)
                                                                         + ": "
                                                                         + String(describing: writer.error)))
                                return
                            }
                            state.recordAudioAppended()
                        } catch {
                            state.recordFailure(error)
                            return
                        }
                    }
                }
            }
        }

        // This thread only observes the supply blocks: it stops the attempt on failure or on a
        // bounded absence of progress, and it never appends while an input block is running.
        while !state.allTracksFinished {
            if let failure = state.failure {
                let detail = "supply failure: " + String(describing: failure) + " | "
                    + stallDetail(state: state, writer: writer,
                                  videoInput: videoInput, audioInput: audioInput)
                try abandonAttempt(state: state, writer: writer, attempt: attempt, stall: false,
                                   secondsWithoutProgress: 0, detail: detail)
            }
            if let forced = forcedStallAttempt, forced == attempt, state.framesAppended >= 20 {
                let detail = "forced stall hook (SPIKE_FORCE_STALL_ATTEMPT=" + String(forced)
                    + ") | " + stallDetail(state: state, writer: writer,
                                           videoInput: videoInput, audioInput: audioInput)
                try abandonAttempt(state: state, writer: writer, attempt: attempt, stall: true,
                                   secondsWithoutProgress: 0, detail: detail)
            }
            let idle = state.secondsSinceProgress
            if idle > stallTimeoutSeconds {
                let detail = stallDetail(state: state, writer: writer,
                                         videoInput: videoInput, audioInput: audioInput)
                try abandonAttempt(state: state, writer: writer, attempt: attempt, stall: true,
                                   secondsWithoutProgress: idle, detail: detail)
            }
            Thread.sleep(forTimeInterval: 0.01)
        }

        guard state.waitForSuppliersToStop(timeout: supplierStopTimeoutSeconds) else {
            throw MediaWriterTearDownRefused(
                attempt: attempt,
                framesAppended: state.framesAppended,
                audioSampleFramesAppended: state.audioSampleFramesAppended,
                waitedSeconds: supplierStopTimeoutSeconds,
                detail: "every supply block reported its track finished but a block was still active;"
                    + " refusing to finish while an append may be in flight | " + state.describe())
        }

        let semaphore = DispatchSemaphore(value: 0)
        writer.finishWriting { semaphore.signal() }
        guard semaphore.wait(timeout: .now() + finishWritingTimeoutSeconds) == .success else {
            throw MediaWriterFinishTimedOut(attempt: attempt,
                                            framesAppended: state.framesAppended,
                                            audioSampleFramesAppended: state.audioSampleFramesAppended,
                                            waitedSeconds: finishWritingTimeoutSeconds)
        }

        guard writer.status == .completed else {
            throw SpikeError.ioFailure("writer did not complete: status=\(writer.status.rawValue) "
                                       + String(describing: writer.error))
        }

        return AttemptOutcome(framesAppended: state.framesAppended,
                              audioSampleFramesAppended: state.audioSampleFramesAppended)
    }

    ///现场 values captured when an attempt is abandoned; they are part of the reported error.
    private static func stallDetail(state: SupplyState, writer: AVAssetWriter,
                                    videoInput: AVAssetWriterInput,
                                    audioInput: AVAssetWriterInput?) -> String {
        "writerStatus=" + String(writer.status.rawValue)
            + " writerError=" + String(describing: writer.error)
            + " videoReady=" + String(videoInput.isReadyForMoreMediaData)
            + " audioReady=" + (audioInput.map { String($0.isReadyForMoreMediaData) } ?? "n/a")
            + " | " + state.describe()
    }


    /// Stops supply and only then tears the attempt down.
    ///
    /// `cancelWriting` and `finishWritingWithCompletionHandler:` must not run while an append is in
    /// flight, so this waits — bounded — for every supply block to leave AVAssetWriter before
    /// touching the writer. When the budget expires it refuses the tear-down instead of racing the
    /// append, and the file write ends with `MediaWriterTearDownRefused`.
    ///
    /// The caller's attempt always ends by throwing.
    private static func abandonAttempt(state: SupplyState, writer: AVAssetWriter, attempt: Int,
                                       stall: Bool, secondsWithoutProgress: Double,
                                       detail: String) throws -> Never {
        state.requestStop()
        guard state.waitForSuppliersToStop(timeout: supplierStopTimeoutSeconds) else {
            throw MediaWriterTearDownRefused(attempt: attempt,
                                             framesAppended: state.framesAppended,
                                             audioSampleFramesAppended: state.audioSampleFramesAppended,
                                             waitedSeconds: supplierStopTimeoutSeconds,
                                             detail: detail)
        }
        writer.cancelWriting()
        if stall {
            throw MediaWriterStall(attempt: attempt,
                                   framesAppended: state.framesAppended,
                                   audioSampleFramesAppended: state.audioSampleFramesAppended,
                                   secondsWithoutProgress: secondsWithoutProgress,
                                   detail: detail)
        }
        throw SpikeError.ioFailure("supply failed before the file was complete: " + detail)
    }
    private static func makePixelBuffer(pool: CVPixelBufferPool, mode: SpikeMode, frameIndex: Int) -> CVPixelBuffer? {
        return renderPixelBuffer(pool: pool, mode: mode, frameIndex: frameIndex)
    }

    private static func renderPixelBuffer(pool: CVPixelBufferPool, mode: SpikeMode, frameIndex: Int) -> CVPixelBuffer? {
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
        guard let pixelBuffer = buffer else { return nil }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let context = CGContext(data: CVPixelBufferGetBaseAddress(pixelBuffer),
                                      width: SpikeSpec.width,
                                      height: SpikeSpec.height,
                                      bitsPerComponent: 8,
                                      bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                                      space: RenderPalette.colorSpace,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                                  | CGBitmapInfo.byteOrder32Little.rawValue) else {
            return nil
        }
        FrameRenderer.render(mode: mode, frameIndex: frameIndex, into: context)
        return pixelBuffer
    }

    private static func makeAudioFormat(sampleRate: Double, channels: Int) throws -> CMAudioFormatDescription {
        var asbd = AudioStreamBasicDescription(mSampleRate: sampleRate,
                                               mFormatID: kAudioFormatLinearPCM,
                                               mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                               mBytesPerPacket: UInt32(4 * channels),
                                               mFramesPerPacket: 1,
                                               mBytesPerFrame: UInt32(4 * channels),
                                               mChannelsPerFrame: UInt32(channels),
                                               mBitsPerChannel: 32,
                                               mReserved: 0)
        var format: CMAudioFormatDescription?
        let status = CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd,
                                                   layoutSize: 0, layout: nil,
                                                   magicCookieSize: 0, magicCookie: nil,
                                                   extensions: nil, formatDescriptionOut: &format)
        guard status == noErr, let format else {
            throw SpikeError.ioFailure("cannot create LPCM format description (status \(status))")
        }
        return format
    }

    private static func makeAudioSampleBuffer(mixed: [Float], startSample: Int, sampleCount: Int,
                                              sampleRate: Double, channels: Int,
                                              format: CMAudioFormatDescription) throws -> CMSampleBuffer {
        let interleavedCount = sampleCount * channels
        var interleaved = [Float](repeating: 0, count: interleavedCount)
        for index in 0..<sampleCount {
            let source = startSample + index
            let value = source < mixed.count ? mixed[source] : 0
            for channel in 0..<channels {
                interleaved[index * channels + channel] = value
            }
        }

        let byteCount = interleavedCount * MemoryLayout<Float>.size
        var blockBuffer: CMBlockBuffer?
        let createStatus = CMBlockBufferCreateWithMemoryBlock(allocator: nil,
                                                             memoryBlock: nil,
                                                             blockLength: byteCount,
                                                             blockAllocator: nil,
                                                             customBlockSource: nil,
                                                             offsetToData: 0,
                                                             dataLength: byteCount,
                                                             flags: 0,
                                                             blockBufferOut: &blockBuffer)
        guard createStatus == kCMBlockBufferNoErr, let blockBuffer else {
            throw SpikeError.ioFailure("cannot create audio block buffer (status \(createStatus))")
        }
        let copyStatus = interleaved.withUnsafeBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return -1 }
            return CMBlockBufferReplaceDataBytes(with: base, blockBuffer: blockBuffer,
                                                 offsetIntoDestination: 0, dataLength: byteCount)
        }
        guard copyStatus == kCMBlockBufferNoErr else {
            throw SpikeError.ioFailure("cannot fill audio block buffer (status \(copyStatus))")
        }

        var sampleBuffer: CMSampleBuffer?
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(sampleRate)),
                                        presentationTimeStamp: CMTime(value: CMTimeValue(startSample),
                                                                      timescale: CMTimeScale(sampleRate)),
                                        decodeTimeStamp: .invalid)
        let sampleSize = 4 * channels
        let status = CMSampleBufferCreateReady(allocator: nil,
                                              dataBuffer: blockBuffer,
                                              formatDescription: format,
                                              sampleCount: sampleCount,
                                              sampleTimingEntryCount: 1,
                                              sampleTimingArray: &timing,
                                              sampleSizeEntryCount: 1,
                                              sampleSizeArray: [sampleSize],
                                              sampleBufferOut: &sampleBuffer)
        guard status == noErr, let sampleBuffer else {
            throw SpikeError.ioFailure("cannot create audio sample buffer (status \(status))")
        }
        return sampleBuffer
    }
}

/// Progress, failure and stop state shared by the two supply blocks and the observing thread.
///
/// Each input has exactly one serial queue, so a track's own counters are only ever advanced by
/// that track's block; the lock protects what both queues plus the observer can touch.
private final class SupplyState {
    enum Track: Hashable { case video, audio }

    private let lock = NSLock()
    private let expectedTracks: Set<Track>
    private let videoFrameCount: Int
    private let audioChunkCount: Int
    private let samplesPerFrame: Int

    private var videoFrameIndex = 0
    private var audioChunkIndex = 0
    private var framesAppendedCount = 0
    private var audioSamplesAppendedCount = 0
    private var finishedTracks: Set<Track> = []
    private var activeSuppliers: Set<Track> = []
    private var heldTracks: Set<Track> = []
    private var videoBlockInvocations = 0
    private var audioBlockInvocations = 0
    private var stopped = false
    private var storedFailure: Error?
    private var lastProgress = Date()

    init(videoFrameCount: Int, audioChunkCount: Int, samplesPerFrame: Int) {
        self.videoFrameCount = videoFrameCount
        self.audioChunkCount = audioChunkCount
        self.samplesPerFrame = samplesPerFrame
        self.expectedTracks = audioChunkCount > 0 ? [.video, .audio] : [.video]
    }

    var framesAppended: Int { locked { framesAppendedCount } }
    var audioSampleFramesAppended: Int { locked { audioSamplesAppendedCount } }
    var failure: Error? { locked { storedFailure } }
    var isStopped: Bool { locked { stopped } }
    var allTracksFinished: Bool { locked { finishedTracks.count == expectedTracks.count } }
    var secondsSinceProgress: Double { locked { Date().timeIntervalSince(lastProgress) } }

    func nextVideoFrameIndex() -> Int? { locked { videoFrameIndex < videoFrameCount ? videoFrameIndex : nil } }
    func nextAudioChunkIndex() -> Int? { locked { audioChunkIndex < audioChunkCount ? audioChunkIndex : nil } }

    func recordVideoAppended() {
        locked {
            videoFrameIndex += 1
            framesAppendedCount += 1
            lastProgress = Date()
        }
    }

    func recordAudioAppended() {
        locked {
            audioChunkIndex += 1
            audioSamplesAppendedCount += samplesPerFrame
            lastProgress = Date()
        }
    }

    func recordFailure(_ error: Error) {
        locked { if storedFailure == nil { storedFailure = error } }
    }

    func finish(_ track: Track) {
        locked { _ = finishedTracks.insert(track) }
    }

    /// Test-only: parks the first invocation of the given track for `seconds`. The block stays in
    /// flight, which is exactly what the observer sees while a block is inside a writer call.
    func holdFirstInvocation(of track: Track, seconds: Double) {
        guard seconds > 0 else { return }
        let shouldHold = locked { heldTracks.insert(track).inserted }
        if shouldHold { Thread.sleep(forTimeInterval: seconds) }
    }

    func requestStop() {
        locked { stopped = true }
    }

    /// Runs one invocation of a supply block, tracking how many are in flight so the observing
    /// thread never calls finishWriting or cancelWriting while an append could be running.
    func withSupplier(_ track: Track, _ body: () -> Void) {
        locked {
            activeSuppliers.insert(track)
            switch track {
            case .video: videoBlockInvocations += 1
            case .audio: audioBlockInvocations += 1
            }
        }
        defer { locked { _ = activeSuppliers.remove(track) } }
        body()
    }

    /// Waits, bounded, until every supply block has left AVAssetWriter calls.
    ///
    /// Returns false when the budget expires: an append may still be running, so the caller must not
    /// cancel or finish the writer (AVAssetWriterInput.h forbids that concurrency).
    func waitForSuppliersToStop(timeout: Double) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if locked({ activeSuppliers.isEmpty }) { return true }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 0.002)
        }
    }

    /// Compact现场 description used both in the error and in report.json.
    func describe() -> String {
        locked {
            let active = activeSuppliers.map { $0 == .video ? "video" : "audio" }.sorted()
            return "videoFrames=" + String(videoFrameIndex) + "/" + String(videoFrameCount)
                + " audioChunks=" + String(audioChunkIndex) + "/" + String(audioChunkCount)
                + " videoBlockInvocations=" + String(videoBlockInvocations)
                + " audioBlockInvocations=" + String(audioBlockInvocations)
                + " activeSupplyBlocks=[" + (active.isEmpty ? "none" : active.joined(separator: ",")) + "]"
        }
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
