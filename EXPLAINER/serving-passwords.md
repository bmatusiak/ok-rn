Here is a comprehensive blueprint for building a **Dual-Credential Provider (Passkeys + Passwords)** in a React Native application for both Android and iOS.

---

### Architectural Overview

Because system Autofill Extensions run in independent background processes isolated from the main React Native JavaScript engine:

1. **Main RN App:** Manages the vault (SQLite/MMKV), handles key sync, and writes encrypted credentials to a shared platform container.
2. **Platform Extension (Native):** Runs as a lightweight native service or extension (`CredentialProviderService` on Android, `ASCredentialProviderViewController` on iOS).
3. **Hardware Isolation:**
* **For Passkeys:** The native extension reads stored asymmetric keys and requests a signature directly from the device hardware co-processor.
* **For Passwords:** The native extension uses biometrics to release the Vault Master Key, decrypts the `username`/`password` pair in memory, and passes it to the target app.



```
  React Native App (JS Layer)
       │
       ▼ (Encrypt & Save Vault Item)
  Shared Storage Container (App Group / Encrypted File)
       │
       ├─────────────────────────────────────────┐
       ▼                                         ▼
  Android Credential Service             iOS Credential Extension
  (CredentialProviderService)            (ASCredentialProviderViewController)
       │                                         │
       └────────────────────┬────────────────────┘
                            ▼
               Unified System Picker Display
             ┌──────────────────────────────┐
             │ 🔑 user@app.com (Passkey)   │
             │ 👤 user@app.com (Password)  │
             └──────────────────────────────┘

```

---

### 🤖 Android Implementation (Android 14+ / CredentialManager)

#### 1. Manifest Configuration (`AndroidManifest.xml`)

Register your app as a system-recognized credential provider service:

```xml
<manifest xmlns:android="http://android.com" package="com.yourpackage.autofill">

    <uses-permission android:name="android.permission.USE_BIOMETRIC" />

    <application>
        <!-- The Background Provider Service -->
        <service
            android:name=".services.CustomCredentialProviderService"
            android:exported="true"
            android:permission="android.permission.BIND_CREDENTIAL_PROVIDER_SERVICE">
            <intent-filter>
                <action android:name="android.service.credentials.CredentialProviderService" />
            </intent-filter>
            <meta-data
                android:name="android.service.credentials.configuration"
                android:resource="@xml/provider_config" />
        </service>

        <!-- Auth Activity launched when user selects an item -->
        <activity
            android:name=".ui.VaultAuthActivity"
            android:exported="false"
            android:theme="@style/Theme.AppCompat.DayNight.Dialog">
        </activity>
    </application>
</manifest>

```

#### 2. Declare Dual Capabilities (`res/xml/provider_config.xml`)

Tell Android that your service supports both public key credentials (Passkeys) and traditional passwords:

```xml
<credential-provider xmlns:android="http://android.com">
    <capabilities>
        <capability name="androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL" />
        <capability name="androidx.credentials.TYPE_PASSWORD_CREDENTIAL" />
    </capabilities>
</credential-provider>

```

#### 3. Service Entry Aggregation (`CustomCredentialProviderService.kt`)

Populate entries for both Passkeys and Passwords:

```kotlin
package com.yourpackage.autofill.services

import android.app.PendingIntent
import android.content.Intent
import android.os.CancellationSignal
import android.service.credentials.*
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.PublicKeyCredentialEntry

class CustomCredentialProviderService : CredentialProviderService() {

    override fun onBeginGetCredential(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: BeginGetCredentialCallback
    ) {
        val responseEntries = mutableListOf<CredentialEntry>()
        val targetPackage = request.callingAppInfo?.packageName ?: ""

        request.credentialOptions.forEachIndexed { index, option ->
            when (option.type) {
                // 1. POPULATE PASSKEYS
                "androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL" -> {
                    val passkeys = queryVaultForPasskeys(targetPackage)
                    passkeys.forEach { passkey ->
                        val intent = Intent(this, VaultAuthActivity::class.java).apply {
                            putExtra("CRED_TYPE", "PASSKEY")
                            putExtra("CREDENTIAL_ID", passkey.id)
                            putExtra("REQUEST_JSON", option.candidateQueryData.getString("androidx.credentials.BUNDLE_KEY_SUBTYPE_REQUEST_DATA"))
                        }
                        val pendingIntent = PendingIntent.getActivity(
                            this, index, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                        )
                        
                        responseEntries.add(
                            PublicKeyCredentialEntry.Builder(
                                applicationContext, passkey.username, pendingIntent, option.candidateQueryData
                            ).build()
                        )
                    }
                }

                // 2. POPULATE PASSWORDS
                "androidx.credentials.TYPE_PASSWORD_CREDENTIAL" -> {
                    val passwords = queryVaultForPasswords(targetPackage)
                    passwords.forEach { pwd ->
                        val intent = Intent(this, VaultAuthActivity::class.java).apply {
                            putExtra("CRED_TYPE", "PASSWORD")
                            putExtra("ACCOUNT_ID", pwd.id)
                        }
                        val pendingIntent = PendingIntent.getActivity(
                            this, index + 1000, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                        )

                        responseEntries.add(
                            PasswordCredentialEntry.Builder(
                                applicationContext, pwd.username, pendingIntent, option.candidateQueryData
                            ).build()
                        )
                    }
                }
            }
        }

        val response = BeginGetCredentialResponse(responseEntries)
        callback.onResponse(response)
    }

    private fun queryVaultForPasskeys(domain: String): List<VaultItem> { /* Reading shared storage */ }
    private fun queryVaultForPasswords(domain: String): List<VaultItem> { /* Reading shared storage */ }
}
data class VaultItem(val id: String, val username: String)

```

---

### 🍏 iOS Implementation (`AuthenticationServices`)

To support iOS, add a **Credential Provider Extension** target to your Xcode workspace:

1. In Xcode: **File** → **New** → **Target** → **Credential Provider Extension**.
2. Configure **App Groups** on both your main React Native target and the new Extension target (`group.com.yourcompany.app`).

#### `CredentialProviderViewController.swift`

```swift
import AuthenticationServices

class CredentialProviderViewController: ASCredentialProviderViewController {

    override fun prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        let domain = serviceIdentifiers.first?.identifier ?? ""
        var credentialEntries: [ASCredential] = []

        // 1. Fetch matching Passkeys from Shared App Group Storage
        let passkeys = VaultStorage.getPasskeys(for: domain)
        for passkey in passkeys {
            let passkeyCredential = ASPasskeyCredentialIdentity(
                relyingPartyIdentifier: domain,
                userName: passkey.username,
                recordIdentifier: passkey.id,
                userHandle: passkey.userHandleData
            )
            credentialEntries.append(passkeyCredential)
        }

        // 2. Fetch matching Passwords from Shared App Group Storage
        let passwords = VaultStorage.getPasswords(for: domain)
        for pwd in passwords {
            let passwordCredential = ASPasswordCredentialIdentity(
                serviceIdentifier: ASCredentialServiceIdentifier(identifier: domain, type: .domain),
                user: pwd.username,
                recordIdentifier: pwd.id
            )
            credentialEntries.append(passwordCredential)
        }

        // Present aggregated options in iOS sheet
        self.extensionContext.completeRequest(withSelectedCredentials: credentialEntries)
    }

    // Called when the user selects a credential from the list
    override fun provideCredentialWithoutUserInteraction(for identity: ASCredentialIdentity) {
        if let passkeyIdentity = identity as? ASPasskeyCredentialIdentity {
            // Unseal Secure Enclave ECC Private key & Sign challenge
            let assertion = SignEngine.signPasskeyChallenge(recordId: passkeyIdentity.recordIdentifier!)
            self.extensionContext.completeAssertionRequest(with: assertion)
        } else if let passwordIdentity = identity as? ASPasswordCredentialIdentity {
            // Unseal Master Key via Biometrics & Decrypt string
            let plaintextPassword = VaultStorage.decryptPassword(recordId: passwordIdentity.recordIdentifier!)
            let credential = ASPasswordCredential(user: passwordIdentity.user, password: plaintextPassword)
            self.extensionContext.completeRequest(withSelectedCredential: credential)
        }
    }
}

```

---

### 🔐 Secure Enclave & Storage Strategy

| Credential Type | Key Storage Location | Auth Flow |
| --- | --- | --- |
| **Passkey (FIDO2)** | Key pair generated & stored inside **Secure Enclave / StrongBox**. | TEE/Enclave signs assertion directly. Private key never leaves hardware. |
| **Password** | DB stored encrypted on disk (`AES-GCM-256`) using Master Key. | Biometrics release Master Key from Enclave → DB row decrypted in memory → Payload sent to OS. |

---

### Shared DB Access in React Native

To ensure both your React Native JS engine and native extensions can read the vault:

* **iOS:** Use `NSUserDefaults(suiteName: "group.com.yourcompany.app")` or write encrypted SQLite files to the shared container directory obtained via `FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:)`.
* **Android:** Store the encrypted SQLite database in the application's shared internal context (`context.createPackageContext`), allowing both the main application process and background service process to query it.