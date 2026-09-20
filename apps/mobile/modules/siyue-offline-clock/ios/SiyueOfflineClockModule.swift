import Darwin
import ExpoModulesCore

private let processEpoch = UUID().uuidString.lowercased()

private func continuousMilliseconds() -> Double {
  var timebase = mach_timebase_info_data_t()
  mach_timebase_info(&timebase)
  let nanoseconds = Double(mach_continuous_time()) * Double(timebase.numer) / Double(timebase.denom)
  return nanoseconds / 1_000_000
}

public class SiyueOfflineClockModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SiyueOfflineClock")

    Function("snapshot") {
      return [
        "bootId": processEpoch,
        "elapsedRealtimeMs": continuousMilliseconds()
      ]
    }
  }
}
