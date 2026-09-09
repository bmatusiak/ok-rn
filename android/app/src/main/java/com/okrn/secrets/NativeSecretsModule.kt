package com.okrn.secrets

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.specs.NativeSecretsSpec

/**
 * Clipboard and window protection for secrets on screen.
 *
 * Both halves need Android APIs that JavaScript cannot reach: the clipboard's
 * sensitive flag lives on ClipDescription's extras, and FLAG_SECURE is a window
 * flag only the Activity can set.
 */
class NativeSecretsModule(reactContext: ReactApplicationContext) :
  NativeSecretsSpec(reactContext) {

  private val main = Handler(Looper.getMainLooper())

  /**
   * What we last put on the clipboard.
   *
   * Kept so the timer can check before clearing. Clearing unconditionally would
   * throw away whatever the user copied from another app in the meantime, which
   * is a password manager stealing the clipboard rather than protecting it.
   */
  private var lastCopied: String? = null
  private var clearTask: Runnable? = null

  private fun clipboard(): ClipboardManager? =
    reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager

  override fun copySensitive(text: String, clearAfterMs: Double, promise: Promise) {
    main.post {
      try {
        val cm = clipboard()
        if (cm == null) {
          promise.reject(ERR, "no clipboard service")
          return@post
        }

        val clip = ClipData.newPlainText("", text)

        /*
         * Android 13+ shows a preview of whatever was copied. Without this the
         * system displays the password the app deliberately kept masked.
         *
         * The constant is API 33, so it is referenced through its literal name
         * only on versions that have it - and reported back, because on older
         * versions there is no flag AND no preview, which is a different thing
         * from having failed to set it.
         */
        var marked = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          clip.description.extras = PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
          }
          marked = true
        }

        cm.setPrimaryClip(clip)
        lastCopied = text

        clearTask?.let { main.removeCallbacks(it) }
        clearTask = null

        val delay = clearAfterMs.toLong()
        if (delay > 0) {
          /*
           * On the main handler rather than a coroutine so the timer survives
           * the JS bundle reloading - a dev reload must not leave a password on
           * the clipboard forever.
           */
          val task = Runnable { clearIfOurs() }
          clearTask = task
          main.postDelayed(task, delay)
        }

        promise.resolve(marked)
      } catch (e: Exception) {
        promise.reject(ERR, e.message ?: "copy failed", e)
      }
    }
  }

  override fun clearClipboard(promise: Promise) {
    main.post {
      try {
        promise.resolve(clearIfOurs())
      } catch (e: Exception) {
        promise.reject(ERR, e.message ?: "clear failed", e)
      }
    }
  }

  /** @return true if the clipboard held our text and was cleared. */
  private fun clearIfOurs(): Boolean {
    val cm = clipboard() ?: return false
    val ours = lastCopied ?: return false

    val current = cm.primaryClip?.takeIf { it.itemCount > 0 }
      ?.getItemAt(0)?.text?.toString()
    if (current != ours) {
      /* Someone else owns it now. Leave it alone, but stop tracking. */
      lastCopied = null
      return false
    }

    /*
     * An empty clip rather than clearPrimaryClip(): the latter is API 28+ and
     * throws on some OEM builds when no clip is set. Replacing with an empty
     * sensitive clip is available everywhere and has the same effect from the
     * user's side.
     */
    val empty = ClipData.newPlainText("", "")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      empty.description.extras = PersistableBundle().apply {
        putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
      }
    }
    cm.setPrimaryClip(empty)
    lastCopied = null
    return true
  }

  override fun setScreenshotsBlocked(blocked: Boolean, promise: Promise) {
    val activity = getCurrentActivity()
    if (activity == null) {
      promise.reject(ERR, "no activity; the app is not in the foreground")
      return
    }
    main.post {
      try {
        if (blocked) {
          activity.window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
          )
        } else {
          activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject(ERR, e.message ?: "could not change FLAG_SECURE", e)
      }
    }
  }

  override fun screenshotsBlocked(promise: Promise) {
    val activity = getCurrentActivity()
    if (activity == null) {
      promise.resolve(false)
      return
    }
    val flags = activity.window.attributes.flags
    promise.resolve((flags and WindowManager.LayoutParams.FLAG_SECURE) != 0)
  }

  override fun invalidate() {
    clearTask?.let { main.removeCallbacks(it) }
    clearTask = null
    /*
     * The app going away is not a reason to leave a password on the clipboard.
     * Best effort - the context may already be torn down.
     */
    try { clearIfOurs() } catch (_: Exception) { }
    super.invalidate()
  }

  companion object {
    const val ERR = "E_SECRETS"
  }
}
