package com.okrn.autofill

import android.content.Intent
import android.os.Bundle
import android.service.autofill.Dataset
import android.util.Log
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * The OnlyKey sheet in front of the browser, opened by the "OnlyKey" row
 * ([OkAutofillService]). The app's own ReactHost renders the OkRNAutofill root (the Password
 * Manager plugin's JS): the store opens there, the person picks an entry, and JS calls back
 * through [AutofillModule] - [fill] hands the form its values, [cancel] leaves it empty.
 * As CredProviderActivity does for passkeys.
 *
 * It also opens for a SAVE: after "Save to OnlyKey?" the typed login arrives here, JS shows it,
 * seals it into the store on Save, and [done] closes the sheet with nothing sent back.
 */
class AutofillAuthActivity : ReactActivity() {

  data class Pending(
    /* "fill": a form waits for values; "save": a submitted form's values wait to be kept;
       "phrase": a wallet's phrase box waits for a derived phrase's words */
    val mode: String,
    val domain: String,
    val packageName: String,
    val usernameId: AutofillId? = null,
    val passwordId: AutofillId? = null,
    val username: String = "",
    val password: String = "",
    val phraseId: AutofillId? = null,
    val codeId: AutofillId? = null,
    /* an app form: the SHA-256 of each signing certificate of the app asking */
    val certs: List<String> = emptyList(),
  )

  var pending: Pending? = null
    private set

  override fun getMainComponentName(): String = "OkRNAutofill"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    /* the app's theme, by name: this module cannot see the app's resources when it builds */
    val theme = resources.getIdentifier("AppTheme", "style", packageName)
    if (theme != 0) setTheme(theme)
    super.onCreate(savedInstanceState)
    current = this
    pending = read(intent)
    if (pending == null) cancel()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    current = this
    pending = read(intent)
  }

  override fun onDestroy() {
    if (current === this) current = null
    super.onDestroy()
  }

  @Suppress("DEPRECATION")
  private fun read(i: Intent?): Pending? = readOnly(i)?.copy(certs = i?.getStringArrayListExtra(OkAutofillService.EXTRA_CERTS) ?: emptyList())

  @Suppress("DEPRECATION")
  private fun readOnly(i: Intent?): Pending? {
    if (i == null) return null
    if (i.action == OkAutofillService.ACTION_CODE) {
      val box = i.getParcelableExtra<AutofillId>(OkAutofillService.EXTRA_CODE_ID) ?: return null
      return Pending(
        mode = "code",
        domain = i.getStringExtra(OkAutofillService.EXTRA_DOMAIN) ?: "",
        packageName = i.getStringExtra(OkAutofillService.EXTRA_PACKAGE) ?: "",
        codeId = box,
      )
    }
    if (i.action == OkAutofillService.ACTION_PHRASE) {
      val box = i.getParcelableExtra<AutofillId>(OkAutofillService.EXTRA_PHRASE_ID) ?: return null
      return Pending(mode = "phrase", domain = "", packageName = i.getStringExtra(OkAutofillService.EXTRA_PACKAGE) ?: "", phraseId = box)
    }
    if (i.action == OkAutofillService.ACTION_SAVE) {
      val pw = i.getStringExtra(OkAutofillService.EXTRA_PASSWORD) ?: return null
      return Pending(
        mode = "save",
        domain = i.getStringExtra(OkAutofillService.EXTRA_DOMAIN) ?: "",
        packageName = i.getStringExtra(OkAutofillService.EXTRA_PACKAGE) ?: "",
        username = i.getStringExtra(OkAutofillService.EXTRA_USERNAME) ?: "",
        password = pw,
      )
    }
    /* a login form (a password field, maybe a username), or a username box alone */
    val password = i.getParcelableExtra<AutofillId>(OkAutofillService.EXTRA_PASSWORD_ID)
    val user = i.getParcelableExtra<AutofillId>(OkAutofillService.EXTRA_USERNAME_ID)
    if (password == null && user == null) return null
    return Pending(
      mode = "fill",
      domain = i.getStringExtra(OkAutofillService.EXTRA_DOMAIN) ?: "",
      packageName = i.getStringExtra(OkAutofillService.EXTRA_PACKAGE) ?: "",
      usernameId = user,
      passwordId = password,
    )
  }

  /** The picked entry's values into the form, and the sheet closes. */
  fun fill(username: String?, password: String?) {
    val p = pending
    if (p == null) {
      cancel()
      return
    }
    @Suppress("DEPRECATION")
    val b = Dataset.Builder(OkAutofillService.row(this, "OnlyKey"))
    var any = false
    /* a phrase or a code: it goes into the one box (JS passes it as the second value) */
    val box = p.phraseId ?: p.codeId
    if (box != null && !password.isNullOrEmpty()) {
      b.setValue(box, AutofillValue.forText(password)); any = true
    }
    if (p.usernameId != null && !username.isNullOrEmpty()) {
      b.setValue(p.usernameId, AutofillValue.forText(username)); any = true
    }
    if (p.passwordId != null && !password.isNullOrEmpty()) {
      b.setValue(p.passwordId, AutofillValue.forText(password)); any = true
    }
    if (!any) {
      cancel()
      return
    }
    Log.i(OkAutofillService.TAG, "filled")
    setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, b.build()))
    pending = null
    finish()
  }

  /** A save handled (kept or declined) - nothing goes back to the form. */
  fun done() {
    pending = null
    setResult(RESULT_OK)
    finish()
  }

  fun cancel() {
    Log.i(OkAutofillService.TAG, "cancelled")
    pending = null
    setResult(RESULT_CANCELED)
    finish()
  }

  companion object {
    @Volatile
    var current: AutofillAuthActivity? = null
  }
}
