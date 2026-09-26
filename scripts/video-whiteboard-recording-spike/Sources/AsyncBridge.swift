import Foundation

/// Minimal bridge so the CLT-style command can use the async AVFoundation loaders
/// without making the whole tool async.
func blockOnAsync<T>(_ body: @escaping () async throws -> T) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<T>()
    Task {
        do {
            box.value = .success(try await body())
        } catch {
            box.value = .failure(error)
        }
        semaphore.signal()
    }
    semaphore.wait()
    guard let value = box.value else {
        throw SpikeError.ioFailure("async bridge produced no result")
    }
    return try value.get()
}

final class ResultBox<T> {
    var value: Result<T, Error>?
}
