package app.siyue.offlineclock

import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class SiyueOfflineClockModule : Module() {
  companion object {
    private val processEpoch: String = UUID.randomUUID().toString().lowercase()
  }

  override fun definition() = ModuleDefinition {
    Name("SiyueOfflineClock")

    Function("snapshot") {
      mapOf(
        "bootId" to processEpoch,
        "elapsedRealtimeMs" to SystemClock.elapsedRealtime().toDouble()
      )
    }
  }
}
