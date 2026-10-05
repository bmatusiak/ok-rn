package com.okrn

/*
 * WHAT A RELEASE BUILD MAY WRITE TO LOGCAT (log audit, spec order 2026-10-04).
 *
 * Logcat is read by anything with adb or a crash reporter, without touching the
 * phone. A production build therefore logs the SHAPE of what happened (a state,
 * a length, a fixed reason) and never: Bluetooth MAC addresses, paired host names,
 * the package of the app asking for a passkey, Edge seq/budget numbers, or raw
 * error text (an exception message can carry anything it was built from).
 *
 * Debug builds keep the detail - it is what makes a bench report readable - so
 * every helper is a pass-through when BuildConfig.DEBUG.
 */
object LogSafe {
  private val MAC = Regex("(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}")

  /** Debug: unchanged. Release: every MAC address replaced by "<device>". */
  fun scrub(s: String): String = if (BuildConfig.DEBUG) s else s.replace(MAC, "<device>")

  /** Debug: the detail. Release: the stand-in (a name, a package, a number). */
  fun detail(detail: String?, standIn: String = "<hidden>"): String =
    if (BuildConfig.DEBUG) (detail ?: "null") else standIn

  /** Debug: the exception's message. Release: only its class - the message can hold anything. */
  fun error(e: Throwable): String = if (BuildConfig.DEBUG) "${e.javaClass.simpleName}: ${e.message}" else e.javaClass.simpleName
}
