package com.okrn.credprovider

import android.content.Intent
import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.PendingIntentHandler
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Where the user's choice lands: the system launches this once OnlyKey has been
 * picked out of the passkey sheet.
 *
 * It is a SECOND React surface on the SAME ReactHost as MainActivity.
 * MainApplication exposes `reactHost` as a process-wide `by lazy`, so this
 * activity gets the already-warm host for free and needs no changes there. It
 * renders a different registered root ("OkRNCredProvider", see index.js) so the
 * sheet shows the credential flow rather than the whole app.
 *
 * NOT its own process - see the manifest comment. A second process would mean a
 * second ReactHost and a second okemu writing the same flash.bin.
 *
 * WHAT THIS CLASS OWNS
 *
 * Only the framework's edges: pull the request out of the Intent, hold it, and
 * put a response back. It deliberately understands nothing about WebAuthn or
 * CTAP. Every decision about what the bytes mean is made in JS, where
 * node-onlykey-lib already knows CBOR, COSE and clientPIN - duplicating any of
 * that here would be a second implementation to keep in step with the first.
 */
@RequiresApi(34)
class CredProviderActivity : ReactActivity() {

  /** Flattened for JS; see specs/NativeCredProvider.ts. */
  data class Pending(
    val action: String,
    val callerPackage: String,
    val requestJson: String,
    val clientDataHashB64: String,
  )

  var pending: Pending? = null
    private set

  override fun getMainComponentName(): String = "OkRNCredProvider"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    if (!CredProviderGate.enabled()) {
      failGet("the OnlyKey credential provider experiment is switched off")
      return
    }

    pending = when (intent?.action) {
      OkCredentialProviderService.ACTION_GET -> readGet()
      OkCredentialProviderService.ACTION_CREATE -> readCreate()
      else -> null
    }

    val p = pending
    if (p == null) {
      failGet("launched with no usable request: action=${intent?.action}")
      return
    }
    // The hash's PRESENCE is logged, never its bytes.
    Log.i(
      CredProviderGate.TAG,
      "${p.action} from ${p.callerPackage} clientDataHash=" +
        if (p.clientDataHashB64.isEmpty()) "NULL" else "present",
    )
  }

  private fun readGet(): Pending? {
    val request = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
      ?: return null
    // First public-key option only. Chrome sends exactly one; a provider that
    // tried to answer several at once could not say WHICH one it answered,
    // because the response carries a credential, not an option id.
    val option = request.credentialOptions
      .filterIsInstance<GetPublicKeyCredentialOption>()
      .firstOrNull() ?: return null
    return Pending(
      action = "GET",
      callerPackage = request.callingAppInfo.packageName,
      requestJson = option.requestJson,
      clientDataHashB64 = option.clientDataHash.toB64(),
    )
  }

  private fun readCreate(): Pending? {
    val request = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
      ?: return null
    val callingRequest = request.callingRequest as? CreatePublicKeyCredentialRequest
      ?: return null
    return Pending(
      action = "CREATE",
      callerPackage = request.callingAppInfo.packageName,
      requestJson = callingRequest.requestJson,
      clientDataHashB64 = callingRequest.clientDataHash.toB64(),
    )
  }

  /**
   * base64url, no padding - the alphabet every field in a WebAuthn JSON already
   * uses, so JS never has to convert between two base64 dialects.
   */
  private fun ByteArray?.toB64(): String =
    this?.let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) }
      ?: ""

  /** Called from the TurboModule once JS has a WebAuthn response. */
  fun complete(responseJson: String) {
    val result = Intent()
    if (pending?.action == "CREATE") {
      PendingIntentHandler.setCreateCredentialResponse(
        result,
        CreatePublicKeyCredentialResponse(responseJson),
      )
    } else {
      PendingIntentHandler.setGetCredentialResponse(
        result,
        GetCredentialResponse(PublicKeyCredential(responseJson)),
      )
    }
    Log.i(CredProviderGate.TAG, "${pending?.action ?: "GET"} answered")
    setResult(RESULT_OK, result)
    finish()
  }

  /**
   * Refuse, and say so through the framework.
   *
   * Never just finish(): a cancelled activity leaves the caller waiting on a
   * PendingIntent that will never answer, so the page hangs until the
   * framework's own timeout instead of showing the user an error.
   */
  fun fail(message: String) {
    if (pending?.action == "CREATE") failCreate(message) else failGet(message)
  }

  private fun failGet(why: String) {
    Log.i(CredProviderGate.TAG, "refusing GET: $why")
    val result = Intent()
    PendingIntentHandler.setGetCredentialException(result, GetCredentialUnknownException(why))
    setResult(RESULT_OK, result)
    finish()
  }

  private fun failCreate(why: String) {
    Log.i(CredProviderGate.TAG, "refusing CREATE: $why")
    val result = Intent()
    PendingIntentHandler.setCreateCredentialException(result, CreateCredentialUnknownException(why))
    setResult(RESULT_OK, result)
    finish()
  }
}
