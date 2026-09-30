package com.okrn.credprovider

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.credentials.CredentialManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
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

  /*
   * The activity tracks itself (CredProviderActivity.current) rather than being
   * looked up through currentActivity. React's idea of the current activity
   * lags the one that just launched, and the credential surface asks for its
   * request the instant it mounts - so the lookup raced, and lost.
   */
  private fun activity(): CredProviderActivity? =
    CredProviderActivity.current
      ?: reactApplicationContext.currentActivity as? CredProviderActivity

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

  /*
   * WHETHER CHROME CAN ACTUALLY USE US - three facts, never a guess.
   *
   *   supported          the build carries the provider and Android is 14+
   *                      (CredProviderGate.enabled()).
   *   enabled            Android lists this app as an ENABLED credential
   *                      provider. Only the user can switch that, in Settings;
   *                      an app cannot write it (a protected secure setting).
   *   settingsAvailable  the phone has the Settings screen that switches it.
   *                      AOSP Android 14 does; a moto g 5G (2023) on Android 14
   *                      does not - its Settings only has the older autofill
   *                      picker, which does not list credential providers. On
   *                      such a phone the feature cannot be turned on at all,
   *                      and the app must say so instead of "yes".
   *
   * "Supported" alone is the false positive this replaces: the app said "yes"
   * on the moto, where nothing the user can do makes Chrome offer it.
   */
  override fun providerStatus(promise: Promise) {
    val map = WritableNativeMap()
    val supported = CredProviderGate.enabled()
    map.putBoolean("supported", supported)
    map.putBoolean("enabled", supported && isEnabledProvider())
    map.putBoolean("settingsAvailable", supported && settingsIntent() != null)
    promise.resolve(map)
  }

  /* Opens the screen that switches providers; false when the phone has none. */
  override fun openProviderSettings(promise: Promise) {
    val intent = settingsIntent()
    if (intent == null) {
      promise.resolve(false)
      return
    }
    try {
      reactApplicationContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      promise.resolve(true)
    } catch (e: ActivityNotFoundException) {
      promise.resolve(false)
    }
  }

  private fun isEnabledProvider(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
    val cm = reactApplicationContext.getSystemService(CredentialManager::class.java) ?: return false
    return try {
      // By name: the service class extends an Android 14 class, and naming it
      // as a class literal would load it on the older phones this module
      // also runs on.
      cm.isEnabledCredentialProviderService(
        ComponentName(reactApplicationContext.packageName, "com.okrn.credprovider.OkCredentialProviderService"),
      )
    } catch (e: RuntimeException) {
      false
    }
  }

  /*
   * With this app's package first - Settings then opens straight on it where
   * it supports that - and plain as a fallback. Resolving needs the <queries>
   * entry in the manifest (Android 11+ package visibility); without it this
   * would answer "no screen" on every phone.
   */
  private fun settingsIntent(): Intent? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return null
    val pm = reactApplicationContext.packageManager
    val withPackage = Intent(Settings.ACTION_CREDENTIAL_PROVIDER)
      .setData(Uri.parse("package:${reactApplicationContext.packageName}"))
    if (withPackage.resolveActivity(pm) != null) return withPackage
    val plain = Intent(Settings.ACTION_CREDENTIAL_PROVIDER)
    return if (plain.resolveActivity(pm) != null) plain else null
  }

  companion object {
    const val NAME = "NativeCredProvider"
  }
}
