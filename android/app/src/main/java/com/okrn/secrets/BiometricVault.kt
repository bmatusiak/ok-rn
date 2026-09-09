package com.okrn.secrets

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets that only a biometric can open.
 *
 * The prompt is not the protection. Anything gated on a boolean returned from
 * native code is gated on a boolean, and a boolean can be made to say true. The
 * protection is that the AES key lives in the Android Keystore with
 * `setUserAuthenticationRequired(true)`, so the ciphertext cannot be decrypted
 * WITHOUT a successful authentication - not by this app, not by anything that
 * can read the app's files, and not by a rooted shell that copies them
 * elsewhere. The key material never leaves the Keystore, and on most hardware
 * never leaves the secure element.
 *
 * ## What it is used for here
 *
 * Two things, and they want the same machinery:
 *
 *   revealing a secret the app already holds - a slot password, a derived key -
 *   where the biometric is a gate in front of something on screen, and
 *
 *   remembering the device PIN, so unlocking the key does not mean typing seven
 *   digits on a keypad every time.
 *
 * ## The PIN one is a REAL trade-off, and the UI says so
 *
 * An OnlyKey is two factors: the key you have and the PIN you know. When the
 * key IS the phone and the PIN is stored on that same phone, both factors are
 * in one place, and whoever can pass the biometric has both. That is a
 * defensible choice - it is roughly what a phone's own lock screen offers - and
 * it is not one to make on someone's behalf without saying it plainly.
 *
 * ## Enrolling a new fingerprint destroys the key
 *
 * `setInvalidatedByBiometricEnrollment(true)`, deliberately. Otherwise adding a
 * fingerprint after a secret is stored would let the new finger open it, which
 * turns "my biometric" into "any biometric added later by whoever has the
 * unlocked phone". The cost is that the stored secret is lost when biometrics
 * change, and `load` reports that as its own case rather than as a failure.
 */
class BiometricVault(private val context: Context) {

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val PREFS = "com.okrn.biometric"
        private const val TRANSFORM = "AES/GCM/NoPadding"

        /** GCM's nonce, prepended to the ciphertext. 12 bytes, as usual. */
        private const val IV_BYTES = 12

        const val STATUS_AVAILABLE = "available"
        const val STATUS_NONE_ENROLLED = "none-enrolled"
        const val STATUS_NO_HARDWARE = "no-hardware"
        const val STATUS_UNAVAILABLE = "unavailable"
    }

    private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** One Keystore key per alias, so forgetting one cannot open another. */
    private fun keyName(alias: String) = "com.okrn.biometric.$alias"

    /**
     * Why a biometric can or cannot be used.
     *
     * The distinction between "none enrolled" and "no hardware" is the whole
     * reason this returns a string: one is fixable by the person holding the
     * phone, and the other never will be.
     */
    fun status(): String {
        val manager = BiometricManager.from(context)
        val allowed = BiometricManager.Authenticators.BIOMETRIC_STRONG
        return when (manager.canAuthenticate(allowed)) {
            BiometricManager.BIOMETRIC_SUCCESS -> STATUS_AVAILABLE
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> STATUS_NONE_ENROLLED
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> STATUS_NO_HARDWARE
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> STATUS_UNAVAILABLE
            else -> STATUS_UNAVAILABLE
        }
    }

    fun has(alias: String): Boolean = prefs().contains(alias)

    /**
     * Forget the ciphertext AND destroy the key.
     *
     * Both, and in that order. Leaving the key behind would leave a Keystore
     * entry that outlives the secret it protected; leaving the ciphertext
     * behind with the key gone would leave bytes nothing can ever read, which
     * looks like a stored secret to `has()` and is not one.
     */
    fun forget(alias: String): Boolean {
        prefs().edit().remove(alias).apply()
        return try {
            val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            if (store.containsAlias(keyName(alias))) store.deleteEntry(keyName(alias))
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * A key that cannot be used without a fresh authentication.
     *
     * Recreated for each store, so re-saving a secret starts a new key rather
     * than reusing one whose authentication history is unknown.
     */
    private fun createKey(alias: String): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        if (store.containsAlias(keyName(alias))) store.deleteEntry(keyName(alias))

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            keyName(alias),
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            /*
             * The whole point. Without this the Keystore key is merely
             * hardware-backed, and hardware-backed is not the same as
             * "requires a person".
             */
            .setUserAuthenticationRequired(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    setInvalidatedByBiometricEnrollment(true)
                }
            }
            .build()

        generator.init(spec)
        return generator.generateKey()
    }

    private fun loadKey(alias: String): SecretKey? {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        return store.getKey(keyName(alias), null) as? SecretKey
    }

    /**
     * Prompt, then run [work] with the authenticated cipher.
     *
     * The cipher is handed to BiometricPrompt as a CryptoObject and comes back
     * AUTHORISED. That is what ties the prompt to the cryptography: a caller
     * cannot skip the prompt and use the cipher anyway, because the Keystore
     * refuses a key whose authentication has not happened.
     */
    private fun prompt(
        activity: FragmentActivity,
        cipher: Cipher,
        title: String,
        subtitle: String,
        onError: (String) -> Unit,
        onSuccess: (Cipher) -> Unit,
    ) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setNegativeButtonText("Cancel")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .build()

        val executor = androidx.core.content.ContextCompat.getMainExecutor(activity)
        val biometricPrompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationError(code: Int, message: CharSequence) {
                    // The message is the system's own wording, which names the
                    // reason better than a code this app would map badly.
                    onError(message.toString())
                }

                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val authorised = result.cryptoObject?.cipher
                    if (authorised == null) {
                        onError("the prompt succeeded without an authorised cipher")
                    } else {
                        onSuccess(authorised)
                    }
                }

                override fun onAuthenticationFailed() {
                    /*
                     * NOT an error. A finger that did not match is one attempt;
                     * the prompt stays up and the person tries again. Reporting
                     * it would close the prompt from underneath them.
                     */
                }
            },
        )
        biometricPrompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    /** Encrypt and save. Prompts, because using the key at all requires it. */
    fun store(
        activity: FragmentActivity,
        alias: String,
        secret: String,
        title: String,
        subtitle: String,
        onError: (String) -> Unit,
        onSuccess: () -> Unit,
    ) {
        val key = try {
            createKey(alias)
        } catch (e: Exception) {
            onError("could not create a key: ${e.message}")
            return
        }

        val cipher = Cipher.getInstance(TRANSFORM)
        try {
            cipher.init(Cipher.ENCRYPT_MODE, key)
        } catch (e: Exception) {
            onError("could not start encryption: ${e.message}")
            return
        }

        prompt(activity, cipher, title, subtitle, onError) { authorised ->
            try {
                val ct = authorised.doFinal(secret.toByteArray(Charsets.UTF_8))
                // iv || ciphertext, so one string carries everything needed.
                val packed = authorised.iv + ct
                prefs().edit()
                    .putString(alias, Base64.encodeToString(packed, Base64.NO_WRAP))
                    .apply()
                onSuccess()
            } catch (e: Exception) {
                onError("could not encrypt: ${e.message}")
            }
        }
    }

    /** Prompt, then decrypt. */
    fun load(
        activity: FragmentActivity,
        alias: String,
        title: String,
        subtitle: String,
        onError: (String) -> Unit,
        onSuccess: (String) -> Unit,
    ) {
        val stored = prefs().getString(alias, null)
        if (stored == null) {
            onError("nothing is stored under \"$alias\"")
            return
        }

        val packed = try {
            Base64.decode(stored, Base64.NO_WRAP)
        } catch (e: Exception) {
            onError("the stored value is not readable")
            return
        }
        if (packed.size <= IV_BYTES) {
            onError("the stored value is too short to be a sealed secret")
            return
        }

        val key = try {
            loadKey(alias)
        } catch (e: Exception) {
            /*
             * A KeyPermanentlyInvalidatedException lands here, and it is not a
             * failure to explain away: the biometrics changed, so the key was
             * destroyed on purpose and the secret is gone. Saying that lets a
             * caller offer to store it again.
             */
            null
        }
        if (key == null) {
            forget(alias)
            onError("the stored secret was cleared because this device's biometrics changed")
            return
        }

        val cipher = Cipher.getInstance(TRANSFORM)
        try {
            val iv = packed.copyOfRange(0, IV_BYTES)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
        } catch (e: Exception) {
            forget(alias)
            onError("the stored secret was cleared because this device's biometrics changed")
            return
        }

        prompt(activity, cipher, title, subtitle, onError) { authorised ->
            try {
                val pt = authorised.doFinal(packed.copyOfRange(IV_BYTES, packed.size))
                onSuccess(String(pt, Charsets.UTF_8))
            } catch (e: Exception) {
                onError("could not decrypt: ${e.message}")
            }
        }
    }
}
