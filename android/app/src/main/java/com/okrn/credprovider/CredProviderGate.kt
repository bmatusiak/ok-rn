package com.okrn.credprovider

import android.os.Build

/**
 * The one switch for the Credential Manager experiment, and the one place that
 * knows the experiment exists.
 *
 * Everything under this package is an experiment: letting Chrome ON THE PHONE
 * hand a WebAuthn call to this app, which relays it to the OnlyKey. It is kept
 * behind a single const so that turning it off is one edit and removing it is a
 * `rm -r` of two directories - see REMOVAL.md. This mirrors
 * NativeFidoGattModule.UNUSED_KEYSTORE_CREDENTIALS, which is how this repo has
 * already chosen to park code that is written but must not run.
 *
 * Flip [CRED_PROVIDER_EXPERIMENT] to false and the manifest entry stays put but
 * answers nothing: the service returns no entries, so Android stops offering
 * OnlyKey in the passkey sheet, and the activity refuses. That is deliberately
 * NOT the same as uninstalling the provider - a provider that throws is a
 * provider the user has to back out of, while a provider with no entries simply
 * does not appear.
 */
object CredProviderGate {

  /**
   * True while the experiment is being developed, because an experiment that is
   * off cannot be evaluated. Set to false to make the whole feature inert
   * without touching the manifest or the build.
   */
  const val CRED_PROVIDER_EXPERIMENT = true

  /** One tag for every line this package logs, so logwatch can filter on it. */
  const val TAG = "okcredprovider"

  /**
   * The provider APIs landed in Android 14 (API 34) and this app's minSdk is 24,
   * so the version check is not optional - it is the thing that keeps a class
   * that cannot load on an older phone from ever being reached. The service and
   * the activity both ask here rather than testing Build.VERSION themselves, so
   * there is exactly one answer.
   */
  @JvmStatic
  fun enabled(): Boolean =
    CRED_PROVIDER_EXPERIMENT && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
}
