import Foundation
import AVFoundation

/// Two independent mono audio buses captured by the recorder:
/// - local bus: the recorder device microphone (440 Hz, audible 0-2 s and 4-6 s)
/// - remote bus: the other participants arriving through the call (1200 Hz + 1800 Hz, 2-4 s and 4-6 s)
enum AudioSynthesis {
    static let totalFrames = Int((SpikeSpec.durationSeconds * SpikeSpec.sampleRate).rounded())
    private static let fadeSeconds = 0.02

    private static func envelope(window: Range<Double>, at seconds: Double) -> Double {
        guard seconds >= window.lowerBound, seconds < window.upperBound else { return 0 }
        let fadeIn = min(1.0, (seconds - window.lowerBound) / fadeSeconds)
        let fadeOut = min(1.0, (window.upperBound - seconds) / fadeSeconds)
        return min(fadeIn, fadeOut)
    }

    static func localBus() -> [Float] {
        (0..<totalFrames).map { index in
            let t = Double(index) / SpikeSpec.sampleRate
            var value = 0.0
            for window in SpikeSpec.localActiveWindows {
                let gain = envelope(window: window, at: t)
                guard gain > 0 else { continue }
                value += SpikeSpec.localToneAmplitude * sin(2 * Double.pi * SpikeSpec.localToneHz * t) * gain
            }
            return Float(value)
        }
    }

    static func remoteBus() -> [Float] {
        (0..<totalFrames).map { index in
            let t = Double(index) / SpikeSpec.sampleRate
            var value = 0.0
            for window in SpikeSpec.remoteActiveWindows {
                let gain = envelope(window: window, at: t)
                guard gain > 0 else { continue }
                value += SpikeSpec.remoteToneAmplitude * sin(2 * Double.pi * SpikeSpec.remoteToneAHz * t) * gain
                value += SpikeSpec.remoteToneAmplitude * sin(2 * Double.pi * SpikeSpec.remoteToneBHz * t) * gain
            }
            return Float(value)
        }
    }

    /// What the recording should contain: local microphone plus remote participants mixed.
    /// A hard limiter keeps the sum inside the float range without changing the two tones.
    static func masterMix(local: [Float], remote: [Float]) -> [Float] {
        let limit: Double = 0.95
        return (0..<min(local.count, remote.count)).map { index in
            let sum = Double(local[index]) + Double(remote[index])
            return Float(max(-limit, min(limit, sum)))
        }
    }

    /// Writes an isolated source bus as a 16-bit stereo WAV so the two inputs can be inspected separately.
    static func writeWAV(samples: [Float], to url: URL) throws {
        try? FileManager.default.removeItem(at: url)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: SpikeSpec.sampleRate,
            AVNumberOfChannelsKey: SpikeSpec.channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings,
                                  commonFormat: .pcmFormatFloat32, interleaved: false)
        let chunkSize = 4096
        var offset = 0
        while offset < samples.count {
            let count = min(chunkSize, samples.count - offset)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                                frameCapacity: AVAudioFrameCount(count)) else {
                throw SpikeError.ioFailure("cannot allocate PCM buffer for \(url.lastPathComponent)")
            }
            buffer.frameLength = AVAudioFrameCount(count)
            for channel in 0..<Int(file.processingFormat.channelCount) {
                guard let destination = buffer.floatChannelData?[channel] else { continue }
                for index in 0..<count {
                    destination[index] = samples[offset + index]
                }
            }
            try file.write(from: buffer)
            offset += count
        }
    }
}

enum SpikeError: Error, CustomStringConvertible {
    case ioFailure(String)
    case usage(String)
    case verificationFailure(String)

    var description: String {
        switch self {
        case .ioFailure(let message): return "io failure: " + message
        case .usage(let message): return "usage: " + message
        case .verificationFailure(let message): return "verification failure: " + message
        }
    }
}
