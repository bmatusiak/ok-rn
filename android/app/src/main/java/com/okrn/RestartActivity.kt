package com.okrn

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/**
 * Relaunches the app, from a process that is not the one being replaced.
 *
 * WHY THIS EXISTS AT ALL. The firmware's thread only exits through the AIRCR
 * trap and cannot be replaced in-process: it is linked statically into the same
 * .so as the JNI, so there is no way to reset its globals short of a new
 * process, and resetting them by hand would mean changing firmware that is
 * meant to stay original. A dead firmware therefore needs a new process, and
 * the app has to be able to ask for one.
 *
 * WHY IT IS NOT SIMPLER. Two simpler things were tried and measured on device,
 * and neither works on a modern Android:
 *
 *   startActivity(makeRestartActivityTask) then exit()  - the process dies
 *   before the launch is accepted, and background-activity-start rules drop it.
 *   The process went and nothing came back.
 *
 *   An AlarmManager PendingIntent, then exit()  - the alarm outlives the
 *   process, but the activity start it carries is still a background start and
 *   is refused just the same. Same result: process gone, nothing returned.
 *
 * The rule being enforced is that a background process may not start an
 * activity. So the start has to come from something in the FOREGROUND - which
 * is what this is. It runs in its own process (android:process=":restart"), so
 * killing the main one leaves it alive and visible, and an activity start from
 * a visible activity is allowed. It launches the real app and finishes itself.
 */
class RestartActivity : Activity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    /*
     * A beat before relaunching, so the caller's process is actually gone.
     * MainActivity is singleTask: starting it while the old process still holds
     * the task resumes that task instead of creating a new one, and the point
     * of all this is a NEW PROCESS.
     */
    Handler(Looper.getMainLooper()).postDelayed({
      val launch = packageManager.getLaunchIntentForPackage(packageName)
      if (launch != null) {
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        startActivity(launch)
      }
      finish()
      // This helper has done its one job; do not leave its process behind.
      Runtime.getRuntime().exit(0)
    }, RELAUNCH_DELAY_MS)
  }

  companion object {
    private const val RELAUNCH_DELAY_MS = 500L
  }
}
