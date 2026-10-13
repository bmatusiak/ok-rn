# Technical Specification: Client-Side App Signature Verification (Android)

**Document Type:** Technical Specification & Implementation Plan

**Target Platform:** React Native (Android)

**Objective:** Detect APK tampering, unauthorized repackaging, and illegitimate distribution by verifying the app’s signing certificate at runtime.

---

## 1. Overview & Security Architecture

When an attacker decompiles an Android APK to modify code or inject malicious logic, they lose access to your private signing key. To run the modified APK, they must re-sign it using their own keystore.

By querying the Android `PackageManager` API at runtime, the application extracts the SHA-256 fingerprint of the certificate used to sign the current running APK and compares it against a known expected signature.

```
+------------------+     Queries API      +-------------------------+
| React Native UI  | -------------------> | Native Android Module   |
+------------------+                      +-------------------------+
         |                                             |
         | Checks Result                               | Reads SigningCert
         v                                             v
+------------------+                      +-------------------------+
| Backend / App    | <------------------- | Android PackageManager  |
| Integrity Engine |     SHA-256 Hash     +-------------------------+
+------------------+

```

### Security Considerations & Threat Model

* **Client-Side Bypass Risk:** Checking the signature solely within JavaScript code allows an attacker to edit the JS bundle and remove the check.
* **Mitigation:**
* Perform the check natively and validate critical operations on the **server side** (e.g., attach the hash or an encrypted payload signed with the hash to authentication or sensitive API requests).
* Enable **Hermes Bytecode compilation** and **R8/ProGuard obfuscation** to make reverse engineering harder.


* **Google Play App Signing Notice:** If using Google Play App Signing, Google strips your upload key and re-signs the APK with a production key. The hash embedded in the app must match the **App Signing Key Certificate Fingerprint** found in the **Google Play Console**, not your local `upload-key.keystore`.

---

## 2. Implementation Steps

### Step 1: Obtain Your Target Certificate SHA-256 Fingerprint

#### For Local / Release Builds (Self-Signed)

Run `keytool` on your release keystore:

```bash
keytool -list -v -keystore path/to/your-release-key.keystore -alias your-key-alias

```

Locate the output line starting with `SHA256:`. Format it as uppercase hex values separated by colons (e.g., `AA:BB:CC:DD:...`).

#### For Google Play Store Distributed Builds

1. Log in to **Google Play Console**.
2. Select your application $\rightarrow$ **Release** $\rightarrow$ **Setup** $\rightarrow$ **App Integrity**.
3. Under **App signing key certificate**, copy the **SHA-256 fingerprint**.

---

### Step 2: Create the Native Android Module

Create the following files under your project's native Android path: `android/app/src/main/java/com/<your-package-name>/`

#### File 1: `AppSignatureModule.kt`

Handles access to `PackageManager` and computes the SHA-256 digest across different Android API levels (supporting Android 9+ `GET_SIGNING_CERTIFICATES` as well as legacy versions).

```kotlin
package com.yourapp // Replace with your actual package name

import android.content.pm.PackageManager
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.MessageDigest

class AppSignatureModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "AppSignature"
    }

    @ReactMethod
    fun getAppSignature(promise: Promise) {
        try {
            val context = reactApplicationContext
            val packageName = context.packageName
            val packageManager = context.packageManager

            val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val packageInfo = packageManager.getPackageInfo(
                    packageName, 
                    PackageManager.GET_SIGNING_CERTIFICATES
                )
                val signingInfo = packageInfo.signingInfo
                if (signingInfo.hasMultipleSigners()) {
                    signingInfo.apkContentsSigners
                } else {
                    signingInfo.signingCertificateHistory
                }
            } else {
                @Suppress("DEPRECATION")
                val packageInfo = packageManager.getPackageInfo(
                    packageName, 
                    PackageManager.GET_SIGNATURES
                )
                @Suppress("DEPRECATION")
                packageInfo.signatures
            }

            if (signatures != null && signatures.isNotEmpty()) {
                val certBytes = signatures[0].toByteArray()
                val md = MessageDigest.getInstance("SHA-256")
                val digest = md.digest(certBytes)
                
                // Format byte array to uppercase colon-separated hex string
                val hexString = digest.joinToString(":") { String.format("%02X", it) }
                promise.resolve(hexString)
            } else {
                promise.reject("SIGNATURE_ERROR", "No signatures found on package.")
            }
        } catch (e: Exception) {
            promise.reject("SIGNATURE_ERROR", "Failed to retrieve signature: ${e.localizedMessage}", e)
        }
    }
}

```

#### File 2: `AppSignaturePackage.kt`

Exposes the module to the React Native bridge.

```kotlin
package com.yourapp // Replace with your actual package name

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AppSignaturePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(AppSignatureModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}

```

---

### Step 3: Register Package in Main Application

Open `android/app/src/main/java/com/<your-package-name>/MainApplication.kt` (or `.java`) and register `AppSignaturePackage`:

```kotlin
override fun getPackages(): List<ReactPackage> {
    val packages = PackageList(this).packages.toMutableList()
    // Add custom native package
    packages.add(AppSignaturePackage())
    return packages
}

```

---

### Step 4: JavaScript / TypeScript Verification Layer

Create a utility module in React Native to check signature validity at startup or during key workflows.

`src/services/security.ts`:

```typescript
import { NativeModules, Platform } from 'react-native';

const { AppSignature } = NativeModules;

// Set your expected signatures per environment
const EXPECTED_SIGNATURES = {
  development: '11:22:33:44:...', // Debug keystore hash
  production: 'AA:BB:CC:DD:...',  // Play Store / Production keystore hash
};

export async function verifyAppIntegrity(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true; // Android-specific check
  }

  try {
    const currentSignature: string = await AppSignature.getAppSignature();
    const expectedSignature = __DEV__ 
      ? EXPECTED_SIGNATURES.development 
      : EXPECTED_SIGNATURES.production;

    if (currentSignature !== expectedSignature) {
      console.error(`[Security Check Failed] Expected: ${expectedSignature}, Got: ${currentSignature}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Security Check Error]', error);
    return false;
  }
}

```

---

## 3. Integration & Testing Plan

### Verification Checklist

1. **Debug Build Test:**
* Build app locally in debug mode (`npx react-native run-android`).
* Verify `AppSignature.getAppSignature()` outputs your debug keystore SHA-256 fingerprint (usually located at `~/.android/debug.keystore`).


2. **Release Build Test:**
* Generate an APK signed with your production release key.
* Run `verifyAppIntegrity()` and confirm it matches the release signature.


3. **Tamper Test (Negative Test):**
* Take the compiled release APK, unzip it, re-sign it with a separate testing key using `apksigner`, and reinstall it.
* Confirm that `verifyAppIntegrity()` returns `false`.



---

## 4. Maintenance Notes

* **Key Rotation:** If you rotate your signing key on the Play Store, update the expected fingerprint constant in JavaScript and deploy a client app update synchronously.
* **ProGuard / R8 Rules:** If you enable code shrinking in `android/app/build.gradle`, keep the native bridge module intact by adding a keep rule in `android/app/proguard-rules.pro`:
```proguard
-keep class com.yourapp.AppSignatureModule { *; }
-keep class com.yourapp.AppSignaturePackage { *; }

```