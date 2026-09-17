package com.okrn.credprovider

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableNativeMap
import com.okrn.specs.NativeCredProviderSpec

/**
 * The pipe between the system-launched activity and the JS that does the work.
 *
 * EXPERIMENT - see REMOVAL.md.
 *
 * Every call reaches for `currentActivity` rather than holding a reference.
 * Holding one would leak the activity for the life of the ReactHost, which
 * outlives this sheet by design - the host is shared with MainActivity and
 * stays warm. Reaching for it can fail, and that failure is reported rather
 * than swallowed: if the activity is gone there is nobody left to answer
 * Chrome, and pretending otherwise would hang the page.
 */
class NativeCredProviderModule(reactContext: ReactApplicationContext) :
  NativeCredProviderSpec(reactContext) {

  override fun getName() = NAME

  private fun activity(): CredProviderActivity? =
    reactApplicationContext.currentActivity as? CredProviderActivity

  override fun getPendingRequest(promise: Promise) {
    val act = activity()
    if (act == null) {
      promise.reject("no_activity", "the credential activity is no longer in the foreground")
      return
    }
    val pending = act.pending
    val map = WritableNativeMap()
    if (pending == null) {
      // Not an error. Rotating, or coming back to a sheet that already
      // answered, both land here, and the screen should say so rather than
      // throw.
      map.putString("action", "NONE")
      map.putString("callerPackage", "")
      map.putString("requestJson", "")
      map.putString("clientDataHashB64", "")
    } else {
      map.putString("action", pending.action)
      map.putString("callerPackage", pending.callerPackage)
      map.putString("requestJson", pending.requestJson)
      map.putString("clientDataHashB64", pending.clientDataHashB64)
    }
    promise.resolve(map)
  }

  override fun respond(responseJson: String, promise: Promise) {
    val act = activity()
    if (act == null) {
      promise.reject("no_activity", "the credential activity is no longer in the foreground")
      return
    }
    // Resolve BEFORE finishing. complete() calls finish(), and a promise
    // settled after the activity is gone is a promise JS never sees.
    promise.resolve(true)
    act.runOnUiThread { act.complete(responseJson) }
  }

  override fun fail(message: String, promise: Promise) {
    val act = activity()
    if (act == null) {
      promise.reject("no_activity", "the credential activity is no longer in the foreground")
      return
    }
    promise.resolve(true)
    act.runOnUiThread { act.fail(message) }
  }

  companion object {
    const val NAME = "NativeCredProvider"
  }
}
