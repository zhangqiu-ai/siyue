import Foundation
import AVFoundation

struct DecodedAudio {
    let samples: [Float]          // channel 0 only; both channels carry the same signal
    let sampleRate: Double
    let channelCount: Int
    let peak: Double

    var durationSeconds: Double {
        sampleRate > 0 ? Double(samples.count) / sampleRate : 0
    }
}

enum AudioAnalysis {
    /// Decodes the audio track to 48 kHz float PCM so tone content can be measured.
    static func decode(asset: AVAsset, targetSampleRate: Double = SpikeSpec.sampleRate,
                       targetChannels: Int = SpikeSpec.channelCount) throws -> DecodedAudio {
        let track = try blockOnAsync { try await asset.loadTracks(withMediaType: .audio) }.first
        guard let track else {
            throw SpikeError.verificationFailure("no audio track to decode")
        }

        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
            AVSampleRateKey: targetSampleRate,
            AVNumberOfChannelsKey: targetChannels,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw SpikeError.verificationFailure("AVAssetReader rejected the audio output")
        }
        reader.add(output)
        guard reader.startReading() else {
            throw SpikeError.verificationFailure("AVAssetReader did not start reading audio")
        }

        var samples: [Float] = []
        var peak = 0.0
        while let sampleBuffer = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }
            var length = 0
            var pointer: UnsafeMutablePointer<Int8>?
            let status = CMBlockBufferGetDataPointer(block, atOffset: 0,
                                                    lengthAtOffsetOut: nil,
                                                    totalLengthOut: &length,
                                                    dataPointerOut: &pointer)
            guard status == kCMBlockBufferNoErr, let pointer else { continue }
            let floatCount = length / MemoryLayout<Float>.size
            let floats = UnsafeRawPointer(pointer).assumingMemoryBound(to: Float.self)
            var index = 0
            while index < floatCount {
                let value = floats[index]
                samples.append(value)
                let magnitude = abs(Double(value))
                if magnitude > peak { peak = magnitude }
                index += targetChannels
            }
        }
        if reader.status == .failed {
            throw SpikeError.verificationFailure("audio decode failed: "
                                                 + String(describing: reader.error))
        }

        return DecodedAudio(samples: samples,
                            sampleRate: targetSampleRate,
                            channelCount: targetChannels,
                            peak: peak)
    }

    /// Goertzel power for one frequency inside a time window, normalised to a sine amplitude.
    static func magnitude(samples: [Float], sampleRate: Double,
                          frequency: Double, window: Range<Double>) -> Double {
        let start = max(0, Int(window.lowerBound * sampleRate))
        let end = min(samples.count, Int(window.upperBound * sampleRate))
        guard end > start else { return 0 }
        let count = end - start
        let omega = 2 * Double.pi * frequency / sampleRate
        let coefficient = 2 * cos(omega)
        var s1 = 0.0
        var s2 = 0.0
        for index in start..<end {
            let s0 = Double(samples[index]) + coefficient * s1 - s2
            s2 = s1
            s1 = s0
        }
        let power = s1 * s1 + s2 * s2 - coefficient * s1 * s2
        return power > 0 ? power.squareRoot() / Double(count) * 2 : 0
    }

    /// Largest absolute sample value inside a time window.
    static func peak(samples: [Float], sampleRate: Double, window: Range<Double>) -> Double {
        let start = max(0, Int(window.lowerBound * sampleRate))
        let end = min(samples.count, Int(window.upperBound * sampleRate))
        guard end > start else { return 0 }
        var peak = 0.0
        for index in start..<end {
            let magnitude = abs(Double(samples[index]))
            if magnitude > peak { peak = magnitude }
        }
        return peak
    }
}
