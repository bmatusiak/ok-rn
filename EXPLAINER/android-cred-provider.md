## FIDO2 Virtual Security Key via Android Credential Manager
This write-up covers the architecture and implementation steps needed to build an Android application that acts as a virtual FIDO2 / Passkey Security Key directly handling authentication requests from Google Chrome (or any app) on the same device.
------------------------------
## 🏛️ System Architecture
Prior to Android 14, an app on the same device could not intercept Chrome's internal WebAuthn requests without emulating physical USB/NFC devices (which loop back poorly inside a single OS).
Starting with Android 14 (API 34), Google introduced the Credential Manager API. Under this framework:

   1. Google Chrome (the Relying Party client) requests a passkey or assertion via navigator.credentials.create() or get().
   2. The Android OS intercepts this call and routes it to the currently enabled Credential Provider.
   3. Your App (acting as the Credential Provider) displays its own biometric/PIN UI, processes the cryptographic signature via the device's hardware enclave, and forwards the WebAuthn response structure back to Chrome.

[ Google Chrome ] ---> (WebAuthn Call) ---> [ Android OS Credential Manager ]
                                                      |
                                                      v (Invokes Service)
[ Secure Enclave ] <--- (Biometric Auth) <--- [ Your Custom Provider App ]

------------------------------
## 🛠️ Step 1: Manifest & Configuration
To register your app as a system-recognized credential vendor, you must request specific permissions and declare a provider background service.
## 1. AndroidManifest.xml
Add the background service and protect it with the BIND_CREDENTIAL_PROVIDER_SERVICE permission so that only the Android system can trigger it.

<manifest xmlns:android="http://android.com"
    package="com.example.virtualfido">

    <!-- Required if you need to authenticate using device biometrics -->
    <uses-permission android:name="android.permission.USE_BIOMETRIC" />

    <application>
        <service
            android:name=".services.FidoCredentialProviderService"
            android:exported="true"
            android:permission="android.permission.BIND_CREDENTIAL_PROVIDER_SERVICE">
            <intent-filter>
                <action android:name="android.service.credentials.CredentialProviderService" />
            </intent-filter>
            <meta-data
                android:name="android.service.credentials.configuration"
                android:resource="@xml/provider_config" />
        </service>

        <!-- The interactive activity Chrome will launch to prompt the user -->
        <activity
            android:name=".ui.FidoAuthActivity"
            android:exported="false"
            android:theme="@style/Theme.Material3.DayNight.BottomSheetDialog">
        </activity>
    </application>
</manifest>

## 2. res/xml/provider_config.xml
Create a capability configuration file defining what type of data your application can manage. For FIDO2, declare the TYPE_PUBLIC_KEY_CREDENTIAL capability.

<credential-provider xmlns:android="http://android.com">
    <capabilities>
        <capability name="androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL" />
    </capabilities>
</credential-provider>

------------------------------
## 💻 Step 2: The Service Layer (CredentialProviderService)
Create a class extending CredentialProviderService. This layer receives requests invisibly in the background, extracts the challenge payload sent by Chrome, and pushes a dynamic UI option into the Android OS "Passkey Bottom Sheet".

package com.example.virtualfido.services
import android.app.PendingIntentimport android.content.Intentimport android.net.Uriimport android.os.Bundleimport android.os.CancellationSignalimport android.service.credentials.*import androidx.credentials.CredentialOptionimport com.example.virtualfido.ui.FidoAuthActivity
class FidoCredentialProviderService : CredentialProviderService() {

    override fun onBeginGetCredential(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: BeginGetCredentialCallback
    ) {
        // 1. Filter out only WebAuthn/FIDO2 authentication requests
        val fidoOptions = request.credentialOptions.filter {
            it.type == "androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL"
        }

        if (fidoOptions.isEmpty()) {
            callback.onFailure(GetCredentialException.TYPE_NO_CREDENTIAL, "No FIDO2 payloads requested.")
            return
        }

        val responseEntries = mutableListOf<CredentialEntry>()

        // 2. Loop through requests and prepare to pass data to our interactive UI activity
        fidoOptions.forEachIndexed { index, option ->
            val requestDataJson = option.candidateQueryData.getString(
                "androidx.credentials.BUNDLE_KEY_SUBTYPE_REQUEST_DATA"
            )

            val intent = Intent(this, FidoAuthActivity::class.java).apply {
                putExtra("REQUEST_JSON", requestDataJson)
                putExtra("REQUEST_TYPE", "GET") // GET implies assertion/login
            }
            
            val pendingIntent = PendingIntent.getActivity(
                this, index, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )

            // 3. Construct a visual entry row using Android Slices API to inject into system selector
            // Note: Use the Jetpack 'androidx.credentials' library utilities here for building clean slices
            val slice = createCredentialSlice(option, "Virtual FIDO Key (Local App)")
            val entry = CredentialEntry("virtual_key_$index", "androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL", slice)
            
            responseEntries.add(entry)
        }

        val response = BeginGetCredentialResponse(responseEntries)
        callback.onResponse(response)
    }

    override fun onBeginCreateCredential(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: BeginCreateCredentialCallback
    ) {
        // Logic for creating/registering a brand new credential (navigator.credentials.create)
        // Identical flow to GET: extract json, bundle into intent, open FidoAuthActivity with TYPE = "CREATE"
    }

    private fun createCredentialSlice(option: CredentialOption, title: String): android.app.slice.Slice {
        // Stub: In production, construct a Slice containing your app icon, account username, and title.
        return android.app.slice.Slice.Builder(Uri.parse("content://virtualfido"), 
            android.app.slice.SliceSpec("androidx.credentials.SLICE", 1)).build()
    }
}

------------------------------
## 🔒 Step 3: Hardware Enclave & Cryptography
A true security key guarantees that the private key cannot be exported or copied off the device. You must generate keys within the Android Keystore system backed by a hardware Trusted Execution Environment (TEE) or StrongBox (SE).

package com.example.virtualfido.crypto
import android.security.keystore.KeyGenParameterSpecimport android.security.keystore.KeyPropertiesimport java.security.KeyPairGeneratorimport java.security.KeyStoreimport java.security.Signature
object FidoKeyManager {
    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"

    // Generates an asymmetric ECC keypair bound to the user's Biometrics
    fun generateHardwareKey(alias: String) {
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER)
        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
        ).run {
            setDigests(KeyProperties.DIGEST_SHA256)
            // Forces the OS to require a Fingerprint/Face scan before granting signature capability
            setUserAuthenticationRequired(true)
            setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            build()
        }
        kpg.initialize(spec)
        kpg.generateKeyPair()
    }

    // signs the FIDO2 Client Data / Challenge
    fun signData(alias: String, dataToSign: ByteArray, cryptoObject: Signature): ByteArray {
        cryptoObject.update(dataToSign)
        return cryptoObject.sign()
    }
    
    fun getSignatureInstance(alias: String): Signature {
        val ks = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        val privateKey = ks.getKey(alias, null) as java.security.PrivateKey
        return Signature.getInstance("SHA256withECDSA").apply {
            initSign(privateKey)
        }
    }
}

------------------------------
## 📱 Step 4: Processing and Intercepting (FidoAuthActivity)
When the user chooses your custom credential line item from Chrome's bottom sheet, this Activity is launched. This UI parses WebAuthn JSON payloads, fires the biometric auth prompt, calls the FidoKeyManager, and bundles the payload back to the browser.

package com.example.virtualfido.ui
import android.app.Activityimport android.content.Intentimport android.os.Bundleimport androidx.appcompat.app.AppCompatActivityimport androidx.biometric.BiometricPromptimport androidx.core.content.ContextCompatimport com.example.virtualfido.crypto.FidoKeyManagerimport java.util.concurrent.Executor
class FidoAuthActivity : AppCompatActivity() {

    private lateinit var executor: Executor
    private lateinit var biometricPrompt: BiometricPrompt

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        val requestJson = intent.getStringExtra("REQUEST_JSON")
        val requestType = intent.getStringExtra("REQUEST_TYPE")
        
        executor = ContextCompat.getMainExecutor(this)
        
        // 1. Initialize Biometric UI Framework
        biometricPrompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                super.onAuthenticationSucceeded(result)
                
                // 2. User successfully authenticated! Fetch initialized crypto signature engine
                val cryptoSignature = result.cryptoObject?.signature
                
                // 3. Process the raw WebAuthn payload, extract challenge, and generate FIDO response
                val simulatedFido2ResponseJson = "{\"clientDataJSON\": \"...\", \"authenticatorData\": \"...\", \"signature\": \"...\"}"
                
                // 4. Wrap result back into expected framework structure
                val resultIntent = Intent().apply {
                    val credentialResponseBundle = Bundle().apply {
                        putString("androidx.credentials.BUNDLE_KEY_AUTHENTICATION_RESPONSE_DATA", simulatedFido2ResponseJson)
                    }
                    putExtra("android.service.credentials.extra.GET_CREDENTIAL_RESPONSE", credentialResponseBundle)
                }
                
                setResult(Activity.RESULT_OK, resultIntent)
                finish()
            }
        })

        // Trigger biometrics linked up to the Secure Enclave signature state
        val signatureEngine = FidoKeyManager.getSignatureInstance("user_key_alias")
        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Sign in via Virtual FIDO Key")
            .setSubtitle("Confirm authentication request from Chrome")
            .setNegativeButtonText("Cancel")
            .build()

        biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(signatureEngine))
    }
}

------------------------------
## ⚙️ Development Testing Setup
Because Android enforces strict platform trust isolation, any newly built app targeting this behavior must be manually enabled by the device administrator.

   1. Compile and install your debug APK onto an Android 14+ physical phone or emulator.
   2. Open the system application settings menu:
   * Settings → Passwords & accounts → Passwords, passkeys, and data services (under the Autofill settings domain).
   3. Tap on the configured primary provider and toggle [Your App Name] to Enabled.
   4. Open Google Chrome on the testing device and navigate to a WebAuthn sandbox environment such as webauthn.io.
   5. Trigger a registration or sign-in sequence. Android's native system prompt will dynamically surface your app's package name as an available processing target.

Would you like me to construct a template for parsing the CBOR/JSON payload architecture required to translate the raw parameters between Chrome and your application's signature engines?

