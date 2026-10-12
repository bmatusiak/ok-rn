package com.okrn.autofill

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.autofill.AutofillManager
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * The JS side of Autofill: the sheet's request, its answer, and the turn-on.
 *
 * A plain native module (not a codegen TurboModule): codegen specs live in the app module, and
 * this module is its own Gradle module so it can be removed with the plugin. RN reaches it
 * through its TurboModule interop, on by default with the new architecture.
 */
class AutofillModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  override fun getName(): String = NAME

  /** {domain, packageName, username, password} of the form the sheet is open for, or null. */
  @ReactMethod
  fun getPendingRequest(promise: Promise) {
    val p = AutofillAuthActivity.current?.pending
    if (p == null) {
      promise.resolve(null)
      return
    }
    promise.resolve(Arguments.createMap().apply {
      putString("mode", p.mode)
      putString("domain", p.domain)
      putString("packageName", p.packageName)
      putBoolean("username", p.usernameId != null)
      putBoolean("password", p.passwordId != null)
      /* a save hands JS what was typed, to seal; a fill hands nothing */
      if (p.mode == "save") {
        putString("savedUsername", p.username)
        putString("savedPassword", p.password)
      }
    })
  }

  @ReactMethod
  fun fill(username: String?, password: String?, promise: Promise) {
    val a = AutofillAuthActivity.current
    if (a == null) {
      promise.reject("E_NO_SHEET", "the autofill sheet is gone")
      return
    }
    a.runOnUiThread {
      a.fill(username, password)
      promise.resolve(true)
    }
  }

  /** The save sheet is finished (kept or declined). */
  @ReactMethod
  fun done(promise: Promise) {
    val a = AutofillAuthActivity.current
    if (a == null) {
      promise.resolve(false)
      return
    }
    a.runOnUiThread {
      a.done()
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun cancel(promise: Promise) {
    val a = AutofillAuthActivity.current
    if (a == null) {
      promise.resolve(false)
      return
    }
    a.runOnUiThread {
      a.cancel()
      promise.resolve(true)
    }
  }

  /** {supported, enabled}: whether the phone has autofill, and whether OnlyKey is its service. */
  @ReactMethod
  fun status(promise: Promise) {
    val m = context.getSystemService(AutofillManager::class.java)
    promise.resolve(Arguments.createMap().apply {
      putBoolean("supported", m?.isAutofillSupported == true)
      putBoolean("enabled", isEnabled(m))
    })
  }

  /*
   * Three answers to "is OnlyKey the phone's autofill service?", any one is enough. The first
   * alone was wrong on the Pixel (Android 17, 2026-10-11): after the app was updated, the system's
   * own isServiceEnabled() threw a NullPointerException inside system_server on every call, so it
   * answered false while the setting named OnlyKey and Chrome was sending it requests.
   */
  private fun isEnabled(m: AutofillManager?): Boolean {
    val ours = context.packageName
    if (runCatching { m?.hasEnabledAutofillServices() == true }.getOrDefault(false)) return true
    if (Build.VERSION.SDK_INT >= 28 &&
      runCatching { m?.autofillServiceComponentName?.packageName == ours }.getOrDefault(false)
    ) return true
    val setting = runCatching { Settings.Secure.getString(context.contentResolver, "autofill_service") }.getOrNull()
    return setting?.substringBefore('/') == ours
  }

  /** The phone's "choose the autofill service" screen, with OnlyKey offered. */
  @ReactMethod
  fun openSettings(promise: Promise) {
    val intent = Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:${context.packageName}"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_SETTINGS", e.message ?: "the autofill settings did not open", e)
    }
  }

  companion object {
    const val NAME = "OkAutofill"
  }
}

class AutofillPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == AutofillModule.NAME) AutofillModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      AutofillModule.NAME to ReactModuleInfo(
        /* name = */ AutofillModule.NAME,
        /* className = */ AutofillModule::class.java.name,
        /* canOverrideExistingModule = */ false,
        /* needsEagerInit = */ false,
        /* isCxxModule = */ false,
        /* isTurboModule = */ false,
      ),
    )
  }
}
