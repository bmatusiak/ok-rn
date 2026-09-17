package com.okrn.credprovider

import android.app.PendingIntent
import android.content.Intent
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import androidx.credentials.provider.PublicKeyCredentialEntry

/**
 * Registers this app as a system credential provider, so that a WebAuthn call
 * made by Chrome ON THIS PHONE can be answered by the OnlyKey.
 *
 * This is the half of the problem the app did not have. The BLE authenticator
 * (com.okrn.fido) already answers a DESKTOP browser: the phone advertises as a
 * CTAP2 peripheral and the desktop drives it. A browser on the same phone
 * cannot reach that - Android does not let an app impersonate a USB or NFC
 * authenticator to a local caller - so since Android 14 the only supported door
 * is this one: register as a Credential Manager provider and be offered in the
 * system passkey sheet.
 *
 * WHAT THIS CLASS MUST NOT DO
 *
 * These callbacks fire when the app is very possibly DEAD - the system binds
 * the service, asks what credentials exist, and unbinds. Anything slow here is
 * paid for in the passkey sheet's latency, and anything that touches the key
 * here is worse than slow: opening a CTAPHID channel against a locked OnlyKey
 * has wedged one before (FINDING-a-ctaphid-channel-on-a-locked-key-wedged-it).
 *
 * So the Begin* phase does no device I/O at all. It answers "yes, OnlyKey can
 * handle this" unconditionally and hands back a PendingIntent. Every real
 * decision - is a key attached, is it locked, what does it hold - happens in
 * [CredProviderActivity] after the user has actually chosen OnlyKey. The cost
 * of answering unconditionally is that OnlyKey appears in the sheet even when
 * no key is present; the alternative costs a device probe on every WebAuthn
 * call any app on the phone makes, which is far worse.
 */
@RequiresApi(34)
class OkCredentialProviderService : CredentialProviderService() {

  /**
   * An assertion: some site wants to log the user in.
   *
   * Every public-key option gets one entry. They are not merged, because the
   * system matches the entry back to the option it came from when the user
   * picks it - that is what the option argument to the builder is for.
   */
  override fun onBeginGetCredentialRequest(
    request: BeginGetCredentialRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
  ) {
    if (!CredProviderGate.enabled()) {
      // No entries, not an exception. A provider that throws makes the user
      // dismiss an error; a provider with nothing to offer just is not there.
      callback.onResult(BeginGetCredentialResponse.Builder().build())
      return
    }

    val options = request.beginGetCredentialOptions
      .filterIsInstance<BeginGetPublicKeyCredentialOption>()

    Log.i(
      CredProviderGate.TAG,
      "beginGetCredential: ${options.size} public-key option(s) of " +
        "${request.beginGetCredentialOptions.size} total, caller=" +
        (request.callingAppInfo?.packageName ?: "unknown"),
    )

    val response = BeginGetCredentialResponse.Builder()
    options.forEachIndexed { index, option ->
      val entry = PublicKeyCredentialEntry.Builder(
        this,
        ENTRY_USERNAME,
        pendingIntentFor(ACTION_GET, index),
        option,
      ).build()
      response.addCredentialEntry(entry)
    }
    callback.onResult(response.build())
  }

  /**
   * A registration: some site wants to create a credential.
   *
   * One entry, because create has no per-credential choice to make - the
   * question is only which provider should mint it.
   */
  override fun onBeginCreateCredentialRequest(
    request: BeginCreateCredentialRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
  ) {
    if (!CredProviderGate.enabled() || request !is BeginCreatePublicKeyCredentialRequest) {
      // Passwords are somebody else's job: this provider only ever claims
      // public-key credentials, and saying so by returning nothing keeps
      // OnlyKey out of the "save password" sheet entirely.
      callback.onResult(BeginCreateCredentialResponse.Builder().build())
      return
    }

    Log.i(
      CredProviderGate.TAG,
      "beginCreateCredential: caller=" +
        (request.callingAppInfo?.packageName ?: "unknown"),
    )

    val entry = CreateEntry.Builder(ENTRY_USERNAME, pendingIntentFor(ACTION_CREATE, 0))
      .setDescription("Create the passkey on your OnlyKey")
      .build()
    callback.onResult(
      BeginCreateCredentialResponse.Builder().addCreateEntry(entry).build(),
    )
  }

  /**
   * Asked when the user wipes credential state for an app. Nothing to do: this
   * provider keeps no local state - the credentials live on the key, and the
   * key is not something Android may clear. Answering rather than ignoring it
   * matters because the framework waits on the callback.
   */
  override fun onClearCredentialStateRequest(
    request: ProviderClearCredentialStateRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<Void?, ClearCredentialException>,
  ) {
    callback.onResult(null)
  }

  /**
   * FLAG_MUTABLE is not a style choice. The system fills the request INTO this
   * intent before launching it - that is how the activity receives the thing
   * the user is consenting to. An immutable PendingIntent arrives empty and
   * PendingIntentHandler hands back null, which looks exactly like a framework
   * bug and is not one.
   *
   * Distinct request codes per entry for the same reason: two PendingIntents
   * that compare equal are the same PendingIntent, and the second entry would
   * silently reuse the first one's extras.
   */
  private fun pendingIntentFor(action: String, index: Int): PendingIntent {
    val intent = Intent(this, CredProviderActivity::class.java)
      .setAction(action)
      .setPackage(packageName)
    return PendingIntent.getActivity(
      this,
      REQUEST_CODE_BASE + index,
      intent,
      PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  companion object {
    const val ACTION_GET = "com.okrn.credprovider.GET"
    const val ACTION_CREATE = "com.okrn.credprovider.CREATE"

    /** What the row in the system sheet says. */
    private const val ENTRY_USERNAME = "OnlyKey"

    private const val REQUEST_CODE_BASE = 4200
  }
}
