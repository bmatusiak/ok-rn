## Secure Password Autofill Service via Android Autofill Framework

This write-up covers the architecture and implementation steps needed to build an Android application that acts as a custom, zero-plaintext Password Autofill Service. Passwords remain encrypted and locked until the user explicitly selects an entry and authenticates via biometrics or device credentials.

---

## 🏛️ System Architecture

Android uses the Autofill Framework (introduced in Android 8.0 / API 26) to handle credential filling across applications. Under this security model:

1. Target App (or Chrome) surfaces an input view requesting credentials.
2. The Android OS captures the view structure (`AssistStructure`) and routes it to your `AutofillService`.
3. Your App parses the layout for username and password fields and returns a locked `Dataset` containing only metadata (no plain passwords) bound to a system `PendingIntent`.
4. When the user selects the suggestion, Android launches your authentication activity. Upon successful biometric/PIN verification, your app decrypts the secret in memory and sends the completed `Dataset` back to the OS to fill the fields.

```
[ Target App / Web ] ---> (View Focused) ---> [ Android OS Autofill System ]
                                                          |
                                                          v (Invokes Service)
                                             [ Custom Autofill Service ]
                                                          |
                                                          v (Returns Locked Dataset)
[ Target Input Field ] <--- (Fills Data) <--- [ User Selects & Authenticates ]
                                                          |
                                                          v (Triggers Auth Activity)
                                             [ Decrypt Key in Secure Enclave ]

```

---

## 🛠️ Step 1: Manifest & Configuration

To register your app as an OS-recognized autofill vendor, you must request specific permissions and declare a background service.

### 1. AndroidManifest.xml

Add the service protected with the `BIND_AUTOFILL_SERVICE` permission so only the Android system can trigger it, and register the authentication activity.

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.customautofill">

    <!-- Permission required to prompt for Fingerprint / Face authentication -->
    <uses-permission android:name="android.permission.USE_BIOMETRIC" />

    <application>
        <service
            android:name=".services.CustomAutofillService"
            android:exported="true"
            android:permission="android.permission.BIND_AUTOFILL_SERVICE">
            <intent-filter>
                <action android:name="android.service.autofill.AutofillService" />
            </intent-filter>
            <meta-data
                android:name="android.service.autofill"
                android:resource="@xml/autofill_service_config" />
        </service>

        <!-- The unlock UI launched when a user taps a locked autofill entry -->
        <activity
            android:name=".ui.AutofillAuthActivity"
            android:exported="false"
            android:theme="@style/Theme.AppCompat.Light.Dialog">
        </activity>
    </application>
</manifest>

```

### 2. res/xml/autofill_service_config.xml

Create the configuration metadata file for your autofill service.

```xml
<autofill-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:settingsActivity="com.example.customautofill.ui.SettingsActivity" />

```

---

## 💻 Step 2: The Service Layer (AutofillService)

Create a class extending `AutofillService`. This layer intercepts fill requests, parses field IDs, and attaches an authentication `IntentSender` to the locked dataset instead of passing raw credentials.

```kotlin
package com.example.customautofill.services

import android.app.PendingIntent
import android.content.Intent
import android.os.CancellationSignal
import android.service.autofill.*
import android.widget.RemoteViews
import com.example.customautofill.R
import com.example.customautofill.ui.AutofillAuthActivity

class CustomAutofillService : AutofillService() {

    override fun onFillRequest(
        request: FillRequest,
        cancellationSignal: CancellationSignal,
        callback: FillCallback
    ) {
        val latestStructure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
        
        val parser = ViewNodeParser()
        parser.parseStructure(latestStructure)

        val usernameId = parser.usernameId
        val passwordId = parser.passwordId ?: return callback.onSuccess(null)

        // 1. Prepare intent to launch authentication UI when selected
        val authIntent = Intent(this, AutofillAuthActivity::class.java).apply {
            putExtra("EXTRA_USERNAME_ID", usernameId)
            putExtra("EXTRA_PASSWORD_ID", passwordId)
            putExtra("EXTRA_CREDENTIAL_ALIAS", "user_vault_alias_123")
        }

        val pendingIntent = PendingIntent.getActivity(
            this, 
            1001, 
            authIntent, 
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // 2. Build presentation layout indicating authentication is required
        val presentation = RemoteViews(packageName, R.layout.autofill_item_presentation).apply {
            setTextViewText(R.id.text_title, "Unlock user@example.com")
            setTextViewText(R.id.text_subtitle, "Tap to authenticate & fill password")
        }

        // 3. Construct locked Dataset: NULL value prevents plain password exposure
        val dataset = Dataset.Builder()
            .setValue(passwordId, null, presentation)
            .setAuthentication(pendingIntent.intentSender)
            .build()

        val response = FillResponse.Builder()
            .addDataset(dataset)
            .build()

        callback.onSuccess(response)
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        // Logic to capture and store new credentials submitted by the user
        callback.onSuccess()
    }
}

```

---

## 🔍 Step 3: View Parsing & Tree Traversal

Traverse the target app's `AssistStructure` node hierarchy to resolve `AutofillId` references for username and password fields using standard OS hints or resource ID inspection.

```kotlin
package com.example.customautofill.services

import android.app.assist.AssistStructure
import android.view.View
import android.view.autofill.AutofillId

class ViewNodeParser {
    var usernameId: AutofillId? = null
        private set
    var passwordId: AutofillId? = null
        private set

    fun parseStructure(structure: AssistStructure) {
        val nodesCount = structure.windowNodeCount
        for (i in 0 until nodesCount) {
            val node = structure.getWindowNodeAt(i).rootViewNode
            traverseNode(node)
        }
    }

    private fun traverseNode(node: AssistStructure.ViewNode) {
        val hints = node.autofillHints
        if (hints != null) {
            for (hint in hints) {
                if (hint == View.AUTOFILL_HINT_USERNAME || hint == View.AUTOFILL_HINT_EMAIL_ADDRESS) {
                    usernameId = node.autofillId
                } else if (hint == View.AUTOFILL_HINT_PASSWORD) {
                    passwordId = node.autofillId
                }
            }
        }

        // Fallback matching based on common XML view IDs
        val idEntry = node.idEntry?.lowercase() ?: ""
        if (usernameId == null && (idEntry.contains("user") || idEntry.contains("email"))) {
            usernameId = node.autofillId
        }
        if (passwordId == null && idEntry.contains("password")) {
            passwordId = node.autofillId
        }

        for (i in 0 until node.childCount) {
            traverseNode(node.getChildAt(i))
        }
    }
}

```

---

## 🔒 Step 4: Authentication & Decryption Activity

When selected, this activity prompts the user for authentication. On success, it decrypts credentials and returns the unlocked `Dataset` back to the system.

```kotlin
package com.example.customautofill.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.service.autofill.Dataset
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

class AutofillAuthActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val usernameId = intent.getParcelableExtra<AutofillId>("EXTRA_USERNAME_ID")
        val passwordId = intent.getParcelableExtra<AutofillId>("EXTRA_PASSWORD_ID")
        val credentialAlias = intent.getStringExtra("EXTRA_CREDENTIAL_ALIAS") ?: ""

        val executor = ContextCompat.getMainExecutor(this)
        val biometricPrompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                super.onAuthenticationSucceeded(result)

                // 1. Decrypt password from isolated vault storage
                val decryptedPassword = decryptSecretPassword(credentialAlias)
                val usernameValue = "user@example.com"

                // 2. Build unlocked dataset with plain values
                val datasetBuilder = Dataset.Builder()
                
                usernameId?.let {
                    datasetBuilder.setValue(it, AutofillValue.forText(usernameValue))
                }
                passwordId?.let {
                    datasetBuilder.setValue(it, AutofillValue.forText(decryptedPassword))
                }

                // 3. Send final data back to Android OS Autofill Manager
                val resultIntent = Intent().apply {
                    putExtra(AutofillManager.EXTRA_AUTHENTICATED_DATASET, datasetBuilder.build())
                }

                setResult(Activity.RESULT_OK, resultIntent)
                finish()
            }
        })

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Autofill")
            .setSubtitle("Confirm identity to decrypt and fill credentials")
            .setNegativeButtonText("Cancel")
            .build()

        biometricPrompt.authenticate(promptInfo)
    }

    private fun decryptSecretPassword(alias: String): String {
        // Fetch and decrypt key using AndroidKeyStore hardware-backed cipher
        return "DecryptedSuperSecret123!"
    }
}

```

---

## 🎨 Step 5: Dropdown Presentation Layout

Create the view layout (`res/layout/autofill_item_presentation.xml`) used to display suggestion rows within system autofill drop-down popups.

```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:orientation="vertical"
    android:padding="12dp">

    <TextView
        android:id="@+id/text_title"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:textStyle="bold"
        android:textColor="#000000"
        android:textSize="14sp" />

    <TextView
        android:id="@+id/text_subtitle"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:textColor="#666666"
        android:textSize="12sp" />
</LinearLayout>

```

---

## ⚙️ Development Testing Setup

1. Compile and install your debug APK onto an Android 8.0+ device or emulator.
2. Enable your custom autofill provider in system settings:
* **Settings** → **System** → **Languages & input** → **Autofill service** (or **Settings** → **Passwords & accounts** → **Autofill service**).


3. Toggle **[Your App Name]** to Enabled.
4. Launch an app with a login form (or open Google Chrome).
5. Focus on a username or password input field. Tap the locked suggestion row in the OS drop-down to trigger biometrics and inject the decrypted values.