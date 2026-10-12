package com.okrn.autofill

import android.app.PendingIntent
import android.app.assist.AssistStructure.ViewNode
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.text.InputType
import android.util.Log
import android.view.View
import android.view.autofill.AutofillId
import android.widget.RemoteViews

/**
 * The phone's autofill asks this about every form. It finds the password field (and the username
 * field before it), the site (`webDomain`, from a browser) or the app (its package), and answers
 * with ONE row - "OnlyKey" - whose tap opens [AutofillAuthActivity]. The row carries no values:
 * a secret leaves the app only after the person picks an entry on the sheet (Brad, 2026-10-11:
 * always open OnlyKey's sheet).
 *
 * Nothing here knows a password, and nothing is logged but which kinds of field were found.
 */
class OkAutofillService : AutofillService() {

  private class Fields {
    var username: AutofillId? = null
    var password: AutofillId? = null
    /* the last plain text field seen before the password - a login form's username, usually */
    var textBefore: AutofillId? = null
    var webDomain: String? = null
    /* a one-time-code box (2FA): its autocomplete, Android's OTP hints, or its name */
    var codeBox: AutofillId? = null
    /* a multi-line box, or one named for a seed / phrase / mnemonic (a wallet's restore field) */
    var phraseBox: AutofillId? = null
    /* for the log line: how many text fields, and what they call themselves */
    var texts = 0
    val hints = mutableListOf<String>()
  }

  override fun onFillRequest(
    request: FillRequest,
    cancellationSignal: CancellationSignal,
    callback: FillCallback,
  ) {
    val structure = request.fillContexts.lastOrNull()?.structure
    if (structure == null) {
      callback.onSuccess(null)
      return
    }
    val caller = structure.activityComponent?.packageName ?: ""
    callerNow = caller
    inlineNow = if (Build.VERSION.SDK_INT >= 30) request.inlineSuggestionsRequest else null
    /* never offer to fill the app's own fields: its secrets are typed by the person, here */
    if (caller == packageName) {
      callback.onSuccess(null)
      return
    }
    val f = Fields()
    for (i in 0 until structure.windowNodeCount) walk(structure.getWindowNodeAt(i).rootViewNode, f)
    webNow = !f.webDomain.isNullOrEmpty()
    /*
     * What each form looks like, without its values: which app asked, how many text fields, and
     * their hints / html types. This is how an app's form (a wallet's recovery-phrase box, Brad
     * 2026-10-11) is found to be asking at all, and what it calls its fields.
     */
    /* debug builds only: which apps the person fills is nobody's business in a release log */
    if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
      Log.i(TAG, "request from $caller: ${f.texts} text field(s), hints ${f.hints.distinct()}, " +
        "web ${!f.webDomain.isNullOrEmpty()}")
    }
    val password = f.password
    if (password == null) {
      /*
       * A WALLET'S PHRASE BOX (Brad, 2026-10-11: Atomic Wallet's restore screen asks the autofill
       * service about one textarea, in an app, with no password field). An app's form whose only
       * text field is multi-line, or is named for a seed / phrase / mnemonic, gets the OnlyKey
       * phrase row; the sheet derives the chosen phrase and fills its words. A website's lone box
       * (a search field) never does.
       */
      /*
       * A 2FA CODE BOX (Brad, 2026-10-11: "for codes, i would like to autofill totp for sites"):
       * the field says it is a one-time code, so the row is offered by itself, as on a login form;
       * the sheet lists the codes saved for this site and fills the one picked, as it is now.
       */
      val code = f.codeBox
      if (code != null) {
        Log.i(TAG, "fill request: a code box, ${if (f.webDomain.isNullOrEmpty()) "an app" else "a web page"}")
        callback.onSuccess(codeResponse(caller, f.webDomain ?: "", code))
        return
      }
      val phrase = f.phraseBox
      if (phrase != null && f.texts == 1 && f.webDomain.isNullOrEmpty()) {
        Log.i(TAG, "fill request: a phrase box, an app")
        callback.onSuccess(phraseResponse(caller, phrase))
        return
      }
      /*
       * ASKED BY HAND (long-press > Autofill) on a form with no password field - the first page of a
       * two-step sign-in, a username box alone (Brad, 2026-10-11: "contents cant be autofilled" on
       * one). The person asked, so OnlyKey answers: the sheet fills the picked entry's username;
       * the password page that follows gets the usual row. Never by itself on such a form - every
       * search box would offer it.
       */
      val manual = (request.flags and FillRequest.FLAG_MANUAL_REQUEST) != 0
      val box = f.username ?: f.textBefore
      if (manual && box != null) {
        Log.i(TAG, "fill request: a username box alone, asked by hand")
        callback.onSuccess(usernameResponse(caller, f.webDomain ?: "", box))
        return
      }
      callback.onSuccess(null)
      return
    }
    val username = f.username ?: f.textBefore
    Log.i(TAG, "fill request: password field, username field ${if (username != null) "found" else "none"}, " +
      if (f.webDomain.isNullOrEmpty()) "an app" else "a web page")

    val sheet = Intent(this, AutofillAuthActivity::class.java).apply {
      putStringArrayListExtra(EXTRA_CERTS, certsFor(callerNow))
      putExtra(EXTRA_DOMAIN, f.webDomain ?: "")
      putExtra(EXTRA_PACKAGE, caller)
      putExtra(EXTRA_USERNAME_ID, username)
      putExtra(EXTRA_PASSWORD_ID, password)
    }
    /* MUTABLE: the system adds the form's structure to the intent before it starts the sheet */
    val flags = PendingIntent.FLAG_CANCEL_CURRENT or
      (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    val sender = PendingIntent.getActivity(this, nextRequest++, sheet, flags).intentSender

    @Suppress("DEPRECATION")
    val dataset = dataset(ROW_TEXT, listOfNotNull(username, password), sender)
    /*
     * SAVE (Brad, 2026-10-11: "see if autofill can automatically save passwords to the app while
     * using chrome, like offer to save it to our app"): the save info makes the phone offer
     * "Save to OnlyKey?" once the form is submitted; onSaveRequest below takes it from there.
     */
    val saveTypes = android.service.autofill.SaveInfo.SAVE_DATA_TYPE_PASSWORD or
      (if (username != null) android.service.autofill.SaveInfo.SAVE_DATA_TYPE_USERNAME else 0)
    val save = android.service.autofill.SaveInfo.Builder(saveTypes, listOfNotNull(username, password).toTypedArray())
      /* a web login often ends by navigating away rather than "submitting" the fields */
      .setFlags(android.service.autofill.SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
      .build()
    callback.onSuccess(FillResponse.Builder().addDataset(dataset).setSaveInfo(save).build())
  }

  /** The OnlyKey code row for a one-time-code box: the sheet fills the picked entry's current code. */
  private fun codeResponse(caller: String, domain: String, box: AutofillId): FillResponse {
    val sheet = Intent(this, AutofillAuthActivity::class.java).apply {
      putStringArrayListExtra(EXTRA_CERTS, certsFor(callerNow))
      action = ACTION_CODE
      putExtra(EXTRA_DOMAIN, domain)
      putExtra(EXTRA_PACKAGE, caller)
      putExtra(EXTRA_CODE_ID, box)
    }
    val flags = PendingIntent.FLAG_CANCEL_CURRENT or
      (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    val sender = PendingIntent.getActivity(this, nextRequest++, sheet, flags).intentSender
    @Suppress("DEPRECATION")
    val dataset = dataset(ROW_CODE, listOf(box), sender)
    return FillResponse.Builder().addDataset(dataset).build()
  }

  /** The OnlyKey row for a username box alone: the sheet fills only the username. */
  private fun usernameResponse(caller: String, domain: String, box: AutofillId): FillResponse {
    val sheet = Intent(this, AutofillAuthActivity::class.java).apply {
      putStringArrayListExtra(EXTRA_CERTS, certsFor(callerNow))
      putExtra(EXTRA_DOMAIN, domain)
      putExtra(EXTRA_PACKAGE, caller)
      putExtra(EXTRA_USERNAME_ID, box)
    }
    val flags = PendingIntent.FLAG_CANCEL_CURRENT or
      (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    val sender = PendingIntent.getActivity(this, nextRequest++, sheet, flags).intentSender
    @Suppress("DEPRECATION")
    val dataset = dataset(ROW_TEXT, listOf(box), sender)
    return FillResponse.Builder().addDataset(dataset).build()
  }

  /** The one OnlyKey phrase row for a wallet's phrase box; its tap opens the sheet in phrase mode. */
  private fun phraseResponse(caller: String, box: AutofillId): FillResponse {
    val sheet = Intent(this, AutofillAuthActivity::class.java).apply {
      putStringArrayListExtra(EXTRA_CERTS, certsFor(callerNow))
      action = ACTION_PHRASE
      putExtra(EXTRA_PACKAGE, caller)
      putExtra(EXTRA_PHRASE_ID, box)
    }
    val flags = PendingIntent.FLAG_CANCEL_CURRENT or
      (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    val sender = PendingIntent.getActivity(this, nextRequest++, sheet, flags).intentSender
    @Suppress("DEPRECATION")
    val dataset = dataset(ROW_PHRASE, listOf(box), sender)
    return FillResponse.Builder().addDataset(dataset).build()
  }

  /**
   * The person said yes to "Save to OnlyKey?": the sheet opens with what was typed, shows the
   * site and username, and seals it into the store only on Save there. The values travel to the
   * sheet in this app's own intent; nothing is kept here.
   */
  override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
    val structure = request.fillContexts.lastOrNull()?.structure
    callerNow = structure?.activityComponent?.packageName ?: ""
    if (structure == null || Build.VERSION.SDK_INT < 28) {
      callback.onSuccess()
      return
    }
    val f = Fields()
    for (i in 0 until structure.windowNodeCount) walk(structure.getWindowNodeAt(i).rootViewNode, f)
    webNow = !f.webDomain.isNullOrEmpty()
    val password = f.password?.let { valueOf(structure, it) }
    if (password.isNullOrEmpty()) {
      callback.onSuccess()
      return
    }
    val username = (f.username ?: f.textBefore)?.let { valueOf(structure, it) } ?: ""
    Log.i(TAG, "save request: password, username ${if (username.isEmpty()) "none" else "given"}")
    val sheet = Intent(this, AutofillAuthActivity::class.java).apply {
      putStringArrayListExtra(EXTRA_CERTS, certsFor(callerNow))
      action = ACTION_SAVE
      putExtra(EXTRA_DOMAIN, f.webDomain ?: "")
      putExtra(EXTRA_PACKAGE, structure.activityComponent?.packageName ?: "")
      putExtra(EXTRA_USERNAME, username)
      putExtra(EXTRA_PASSWORD, password)
    }
    val flags = PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE
    callback.onSuccess(PendingIntent.getActivity(this, nextRequest++, sheet, flags).intentSender)
  }

  /* the text a field holds at save time */
  private fun valueOf(structure: android.app.assist.AssistStructure, id: AutofillId): String? {
    var out: String? = null
    fun find(node: ViewNode) {
      if (out != null) return
      if (node.autofillId == id) {
        out = node.autofillValue?.takeIf { it.isText }?.textValue?.toString()
        return
      }
      for (i in 0 until node.childCount) find(node.getChildAt(i))
    }
    for (i in 0 until structure.windowNodeCount) find(structure.getWindowNodeAt(i).rootViewNode)
    return out
  }

  /* the keyboard's inline-suggestion request of the current fill request (Android 11+), if any */
  private var inlineNow: Any? = null

  /**
   * One OnlyKey row: the dropdown's, and - when the keyboard asks (Android 11+) - the same row as
   * a chip in its suggestion strip. Either opens the sheet; neither carries a value.
   */
  @Suppress("DEPRECATION")
  private fun dataset(text: String, ids: List<AutofillId>, sender: android.content.IntentSender): Dataset {
    val b = Dataset.Builder(row(this, text))
    val inline = if (Build.VERSION.SDK_INT >= 30) inlineFor(text) else null
    for (id in ids) {
      if (inline != null && Build.VERSION.SDK_INT >= 30) b.setValue(id, null, row(this, text), inline as android.service.autofill.InlinePresentation)
      else b.setValue(id, null)
    }
    b.setAuthentication(sender)
    return b.build()
  }

  /* the chip, in the keyboard's style; null when the keyboard did not ask or cannot draw v1 */
  @androidx.annotation.RequiresApi(30)
  private fun inlineFor(text: String): Any? {
    val req = inlineNow as? android.view.inputmethod.InlineSuggestionsRequest ?: return null
    val spec = req.inlinePresentationSpecs.firstOrNull() ?: return null
    if (!androidx.autofill.inline.UiVersions.getVersions(spec.style).contains(androidx.autofill.inline.UiVersions.INLINE_UI_VERSION_1)) return null
    /* a long press on the chip opens the app - the attribution Android asks every chip for */
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    val attribution = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE)
    val content = androidx.autofill.inline.v1.InlineSuggestionUi.newContentBuilder(attribution).setTitle(text).build()
    return android.service.autofill.InlinePresentation(content.slice, spec, false)
  }

  /* the app the current request is for (set at the top of each request; the service runs one at a time) */
  private var callerNow = ""
  /* the web page of the current request, if any: an app form's certificates matter, a browser's do not */
  private var webNow = false

  /**
   * The SHA-256 of each signing certificate of the app asking (spec: an app matches by package AND
   * certificate). Empty for a web page - the browser's certificate says nothing about the site.
   */
  private fun certsFor(pkg: String): ArrayList<String> {
    val out = ArrayList<String>()
    if (webNow || pkg.isEmpty()) return out
    try {
      val sigs = if (Build.VERSION.SDK_INT >= 28) {
        val info = packageManager.getPackageInfo(pkg, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES)
        val si = info.signingInfo ?: return out
        if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory
      } else {
        @Suppress("DEPRECATION")
        packageManager.getPackageInfo(pkg, android.content.pm.PackageManager.GET_SIGNATURES).signatures
      }
      val md = java.security.MessageDigest.getInstance("SHA-256")
      sigs?.forEach { sig -> out.add(md.digest(sig.toByteArray()).joinToString("") { "%02x".format(it) }) }
    } catch (e: Exception) {
      Log.w(TAG, "no signing certificate for the asking app")
    }
    return out
  }

  private fun walk(node: ViewNode, f: Fields) {
    if (f.webDomain.isNullOrEmpty() && !node.webDomain.isNullOrEmpty()) f.webDomain = node.webDomain
    val id = node.autofillId
    if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT) {
      f.texts += 1
      if (f.codeBox == null && isCodeBox(node)) f.codeBox = id
      if (f.phraseBox == null && isPhraseBox(node)) f.phraseBox = id
      node.autofillHints?.let { f.hints.addAll(it) }
      htmlAttr(node, "type")?.let { f.hints.add("html:" + it) }
      htmlAttr(node, "autocomplete")?.let { f.hints.add("ac:" + it) }
      when {
        isPassword(node) -> if (f.password == null) f.password = id
        f.password == null && isUsername(node) -> if (f.username == null) f.username = id
        f.password == null && node.visibility == View.VISIBLE -> f.textBefore = id
      }
    }
    for (i in 0 until node.childCount) walk(node.getChildAt(i), f)
  }

  private fun htmlAttr(node: ViewNode, name: String): String? =
    node.htmlInfo?.attributes?.firstOrNull { it.first.equals(name, ignoreCase = true) }?.second

  private fun isPassword(node: ViewNode): Boolean {
    if (node.autofillHints?.any { it.contains("password", ignoreCase = true) } == true) return true
    if (htmlAttr(node, "type").equals("password", ignoreCase = true)) return true
    val t = node.inputType
    val variation = t and InputType.TYPE_MASK_VARIATION
    return when (t and InputType.TYPE_MASK_CLASS) {
      InputType.TYPE_CLASS_TEXT -> variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
      InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
      else -> false
    }
  }

  private fun isCodeBox(node: ViewNode): Boolean {
    val hints = node.autofillHints?.toList() ?: emptyList()
    if (hints.any { Regex("otp|one-time-code|2fa", RegexOption.IGNORE_CASE).containsMatchIn(it) }) return true
    if (htmlAttr(node, "autocomplete").equals("one-time-code", ignoreCase = true)) return true
    val named = listOfNotNull(node.idEntry) + listOf("name", "id").mapNotNull { htmlAttr(node, it) }
    return named.any { Regex("otp|totp|2fa|mfa|one.?time|auth.?code|verification.?code", RegexOption.IGNORE_CASE).containsMatchIn(it) }
  }

  private fun isPhraseBox(node: ViewNode): Boolean {
    /* a web view in an app reports a textarea as its tag, or as type=textarea (Atomic Wallet) */
    if (node.htmlInfo?.tag.equals("textarea", ignoreCase = true)) return true
    if (htmlAttr(node, "type").equals("textarea", ignoreCase = true)) return true
    if ((node.inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0) return true
    val named = (listOfNotNull(node.idEntry, node.hint) + (node.autofillHints?.toList() ?: emptyList()) +
      listOf("name", "id", "placeholder", "aria-label").mapNotNull { htmlAttr(node, it) })
    return named.any { Regex("seed|phrase|mnemonic|recovery|secret words", RegexOption.IGNORE_CASE).containsMatchIn(it) }
  }

  private fun isUsername(node: ViewNode): Boolean {
    val hints = node.autofillHints
    if (hints?.any { it.contains("username", true) || it.contains("email", true) } == true) return true
    val html = listOf("type", "autocomplete", "name", "id").mapNotNull { htmlAttr(node, it) }
    if (html.any { it.contains("email", true) || it.contains("user", true) || it.contains("login", true) }) return true
    val variation = node.inputType and InputType.TYPE_MASK_VARIATION
    return (node.inputType and InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT &&
      (variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS || variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS)
  }

  companion object {
    const val TAG = "OkAutofill"
    const val EXTRA_DOMAIN = "com.okrn.autofill.DOMAIN"
    const val EXTRA_PACKAGE = "com.okrn.autofill.PACKAGE"
    const val EXTRA_USERNAME_ID = "com.okrn.autofill.USERNAME_ID"
    const val EXTRA_PASSWORD_ID = "com.okrn.autofill.PASSWORD_ID"
    const val EXTRA_CERTS = "com.okrn.autofill.CERTS"
    const val ACTION_SAVE = "com.okrn.autofill.SAVE"
    const val EXTRA_USERNAME = "com.okrn.autofill.USERNAME"
    const val EXTRA_PASSWORD = "com.okrn.autofill.PASSWORD"
    const val ROW_TEXT = "OnlyKey - passwords"
    const val ROW_PHRASE = "OnlyKey - wallet phrase"
    const val ROW_CODE = "OnlyKey - code"
    const val ACTION_CODE = "com.okrn.autofill.CODE"
    const val EXTRA_CODE_ID = "com.okrn.autofill.CODE_ID"
    const val ACTION_PHRASE = "com.okrn.autofill.PHRASE"
    const val EXTRA_PHRASE_ID = "com.okrn.autofill.PHRASE_ID"
    private var nextRequest = 1

    /** The dropdown row (a RemoteViews: the autofill UI draws it, not this app). */
    fun row(context: android.content.Context, text: String): RemoteViews =
      RemoteViews(context.packageName, R.layout.okrn_autofill_item).apply {
        setTextViewText(R.id.okrn_autofill_text, text)
      }
  }
}
