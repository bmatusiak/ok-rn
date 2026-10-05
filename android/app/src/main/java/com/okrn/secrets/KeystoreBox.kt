package com.okrn.secrets

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Bytes sealed under an Android Keystore key that never leaves the Keystore,
 * and that opens WITHOUT a prompt.
 *
 * WHY NO BIOMETRIC (Part T, Bluetooth pairing): what this holds - the phone's
 * X-Wing pairing key and each paired computer's pairing secret - is needed
 * every time a computer connects, and a computer connects while the phone sits
 * in a pocket (an agent's push, a gpg signature). A prompt there would mean no
 * connection at all. BiometricVault is the one to use when a person must be
 * present; this one is for "the app's files alone must not be enough".
 *
 * What it protects against: a copy of the app's data (a backup, a rooted read
 * of /data, a file left behind) holds only ciphertext - the key stays in the
 * Keystore (hardware-backed where the phone has it) and is not exportable.
 * What it does not: code running inside this app, which can call open().
 *
 * The caller keeps the ciphertext (AsyncStorage); this class keeps nothing but
 * the key. Format: [iv 12][AES-256-GCM ct + tag 16], hex across the bridge.
 */
class KeystoreBox {
    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }

    private fun keyName(alias: String) = "com.okrn.box.$alias"

    private fun store(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    /** The alias's key, made on first use. Never recreated while it exists: that would strand every sealed blob. */
    private fun key(alias: String): SecretKey {
        (store().getKey(keyName(alias), null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                keyName(alias),
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                /* the Keystore picks the IV, so a caller can never reuse one */
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    fun seal(alias: String, plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key(alias))
        val iv = cipher.iv
        check(iv.size == IV_BYTES) { "unexpected IV length ${iv.size}" }
        return iv + cipher.doFinal(plain)
    }

    /** Throws when the blob was not sealed by this alias's key (or was changed). */
    fun open(alias: String, sealed: ByteArray): ByteArray {
        require(sealed.size > IV_BYTES + TAG_BITS / 8) { "sealed data is too short" }
        val key = store().getKey(keyName(alias), null) as? SecretKey
            ?: throw IllegalStateException("no key for this box - it was forgotten or never made")
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
        return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    /** Destroy the key: everything sealed under it is unreadable from now on. */
    fun forget(alias: String): Boolean {
        val s = store()
        if (!s.containsAlias(keyName(alias))) return false
        s.deleteEntry(keyName(alias))
        return true
    }
}
