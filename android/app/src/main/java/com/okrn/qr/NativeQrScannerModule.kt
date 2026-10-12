package com.okrn.qr

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.specs.NativeQrScannerSpec

/**
 * specs/NativeQrScanner.ts: starts QrScanActivity for a result and resolves with the QR code's
 * text, null when the person backs out, or rejects PERMISSION when the camera was refused.
 * One scan at a time.
 */
class NativeQrScannerModule(private val reactContext: ReactApplicationContext) : NativeQrScannerSpec(reactContext) {

  private var pending: Promise? = null

  private val listener: ActivityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestCode != REQUEST) return
      val p = pending ?: return
      pending = null
      when (resultCode) {
        Activity.RESULT_OK -> p.resolve(data?.getStringExtra(QrScanActivity.EXTRA_TEXT))
        QrScanActivity.RESULT_PERMISSION -> p.reject("PERMISSION", "the camera permission was refused")
        else -> p.resolve(null)
      }
    }
  }

  init {
    reactContext.addActivityEventListener(listener)
  }

  override fun scan(prompt: String, promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "no screen to open the camera from")
      return
    }
    if (pending != null) {
      promise.reject("BUSY", "a scan is already open")
      return
    }
    pending = promise
    activity.startActivityForResult(Intent(activity, QrScanActivity::class.java).putExtra(QrScanActivity.EXTRA_PROMPT, prompt), REQUEST)
  }

  companion object {
    private const val REQUEST = 6107
  }
}
