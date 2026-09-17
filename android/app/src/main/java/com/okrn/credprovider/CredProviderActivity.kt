package com.okrn.credprovider

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.PendingIntentHandler

/**
 * Where the user's choice lands: the system launches this once OnlyKey has been
 * picked out of the passkey sheet.
 *
 * MILESTONE 1 - this class deliberately does no crypto and never touches a key.
 * It reports what the framework actually handed over and then refuses. Two
 * things have to be true before writing a line of WebAuthn/CTAP translation,
 * and neither can be established by reading documentation:
 *
 *   1. That Chrome on this phone will offer a third-party provider at all, for
 *      a real relying party. If it will not, the whole approach is dead and no
 *      translation code would ever have run.
 *
 *   2. Whether `clientDataHash` arrives non-null. Chrome is a PRIVILEGED caller
 *      and is allowed to compute clientDataJSON itself and pass only the hash.
 *      When it does, those exact bytes must be what gets signed, and the
 *      response must NOT carry a clientDataJSON of our own making - the browser
 *      already has the real one, and a second one that differs by so much as a
 *      key order is an origin mismatch at the relying party. Guessing this
 *      wrong is the single most likely way for a working-looking build to be
 *      rejected by webauthn.io, so it is measured first.
 *
 * Refusing is done through PendingIntentHandler rather than by finishing with
 * RESULT_CANCELED, so Chrome is told the attempt failed instead of being left
 * to time out.
 */
@RequiresApi(34)
class CredProviderActivity : Activity() {

  /*
   * The caller's web origin is NOT read here, and cannot be: CallingAppInfo.origin
   * is internal in androidx.credentials 1.5.0. The only public route is
   * getOrigin(privilegedAllowlist), which takes a JSON allowlist of browsers
   * that are trusted to speak for a web origin, and returns non-null only for a
   * caller on that list.
   *
   * That is not an obstacle, it is the design telling us something: a privileged
   * browser is exactly the case where clientDataHash arrives filled in, and in
   * that case the origin is already baked into the clientDataJSON the browser
   * kept. We never need to reconstruct it. The allowlist only becomes necessary
   * if this provider is ever asked to MINT clientDataJSON for a browser, which
   * is precisely what milestone 2 is designed to avoid.
   */

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    if (!CredProviderGate.enabled()) {
      refuse("the OnlyKey credential provider experiment is switched off")
      return
    }

    when (intent?.action) {
      OkCredentialProviderService.ACTION_GET -> reportGet()
      OkCredentialProviderService.ACTION_CREATE -> reportCreate()
      else -> refuse("launched with no action: ${intent?.action}")
    }
  }

  /** navigator.credentials.get() - signing in. */
  private fun reportGet() {
    val request = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
    if (request == null) {
      // Almost always FLAG_MUTABLE missing on the PendingIntent.
      refuse("no ProviderGetCredentialRequest in the intent")
      return
    }

    Log.i(
      CredProviderGate.TAG,
      "GET from ${request.callingAppInfo.packageName}",
    )

    request.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>()
      .forEachIndexed { i, option ->
        // The hash is the whole question - see the class comment. Its presence
        // and length are logged, never its bytes.
        Log.i(
          CredProviderGate.TAG,
          "GET option[$i] clientDataHash=" +
            (option.clientDataHash?.let { "present(${it.size}B)" } ?: "NULL") +
            " requestJson=${option.requestJson}",
        )
      }

    refuse("milestone 1: plumbing only, the key was not asked")
  }

  /** navigator.credentials.create() - registering. */
  private fun reportCreate() {
    val request = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
    if (request == null) {
      refuse("no ProviderCreateCredentialRequest in the intent")
      return
    }

    Log.i(
      CredProviderGate.TAG,
      "CREATE from ${request.callingAppInfo.packageName}",
    )

    val callingRequest = request.callingRequest
    if (callingRequest is CreatePublicKeyCredentialRequest) {
      Log.i(
        CredProviderGate.TAG,
        "CREATE clientDataHash=" +
          (callingRequest.clientDataHash?.let { "present(${it.size}B)" } ?: "NULL") +
          " requestJson=${callingRequest.requestJson}",
      )
    } else {
      Log.i(CredProviderGate.TAG, "CREATE non-publickey request: ${callingRequest.type}")
    }

    refuseCreate("milestone 1: plumbing only, the key was not asked")
  }

  private fun refuse(why: String) {
    Log.i(CredProviderGate.TAG, "refusing GET: $why")
    val result = Intent()
    PendingIntentHandler.setGetCredentialException(result, GetCredentialUnknownException(why))
    setResult(RESULT_OK, result)
    finish()
  }

  private fun refuseCreate(why: String) {
    Log.i(CredProviderGate.TAG, "refusing CREATE: $why")
    val result = Intent()
    PendingIntentHandler.setCreateCredentialException(result, CreateCredentialUnknownException(why))
    setResult(RESULT_OK, result)
    finish()
  }
}
