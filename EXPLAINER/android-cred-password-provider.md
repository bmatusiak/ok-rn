## Android Password Autofill Service via Autofill Framework

This write-up covers the architecture and implementation steps needed to build an Android application that acts as a custom Password Autofill Service directly filling credentials into target apps or web views on the device.

---

## 🏛️ System Architecture

Android uses the Autofill Framework (introduced in Android 8.0 / API 26) to manage form-filling across applications. Under this framework:

1. Target App (or Chrome) surfaces an input view with autofill hints (e.g., `AUTOFILL_HINT_USERNAME`, `AUTOFILL_HINT_PASSWORD`).
2. The Android OS captures the view hierarchy (`AssistStructure`) and routes it to the active Autofill Provider.
3. Your App (acting as the `AutofillService`) parses the node tree, extracts domain/package identifiers, matches stored credentials, and returns a dataset containing `RemoteViews` to be rendered in the OS dropdown.

```
[ Target App / Web ] ---> (View Focused) ---> [ Android OS Autofill System ]
                                                          |
                                                          v (Invokes Service)
[ Secure Storage ] <--- (Fetch Passwords) <--- [ Your Custom Autofill Service ]

```

---

## 🛠️ Step 1: Manifest & Configuration

To register your app as an OS-recognized autofill vendor, you must request specific permissions and declare a background service.

### 1. AndroidManifest.xml

Add the service and protect it with the `BIND_AUTOFILL_SERVICE` permission so that only the system can trigger it.

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.customautofill">

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

        <!-- Optional UI prompt activity when authentication is required -->
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

## 💻 Step 2: Service Layer & View Parsing (AutofillService)

Create a class extending `AutofillService`. This service parses incoming screen view structures, locates username/password input nodes, and constructs the dataset response.

```kotlin
package com.example.customautofill.services

import android.app.assist.AssistStructure
import android.content.Intent
import android.os.CancellationSignal
import android.service.autofill.*
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import com.example.customautofill.R

class CustomAutofillService : AutofillService() {

    override fun onFillRequest(
        request: FillRequest,
        cancellationSignal: CancellationSignal,
        callback: FillCallback
    ) {
        val contexts = request.fillContexts
        val latestStructure = contexts.lastOrNull()?.structure ?: return callback.onSuccess(null)

        val parser = ViewNodeParser()
        parser.parseStructure(latestStructure)

        val usernameId = parser.usernameId
        val passwordId = parser.passwordId

        if (usernameId == null && passwordId == null) {
            callback.onSuccess(null)
            return
        }

        // Mock retrieved entry (in production, fetch from secure encrypted database)
        val targetPackage = latestStructure.activityComponent.packageName
        val userVal = "user@example.com"
        val passVal = "SuperSecret123!"

        val presentation = RemoteViews(packageName, R.layout.autofill_item_presentation).apply {
            setTextViewText(R.id.text_title, "Use saved login for $targetPackage")
            setTextViewText(R.id.text_subtitle, userVal)
        }

        val datasetBuilder = Dataset.Builder()

        usernameId?.let {
            datasetBuilder.setValue(it, AutofillValue.forText(userVal), presentation)
        }
        passwordId?.let {
            datasetBuilder.setValue(it, AutofillValue.forText(passVal), presentation)
        }

        val response = FillResponse.Builder()
            .addDataset(datasetBuilder.build())
            .build()

        callback.onSuccess(response)
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        // Logic to capture and save newly typed credentials submitted by the user
        callback.onSuccess()
    }
}

```

---

## 🔍 Step 3: AssistStructure View Traversal

To correctly auto-fill inputs, you must traverse the `AssistStructure` tree to locate form fields matching standard autofill hints or field names.

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

        // Fallback checks using element view classes and resource IDs
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

## 🎨 Step 4: System Presentation Layout

Create the dataset suggestion layout item (`res/layout/autofill_item_presentation.xml`) that renders inside system dropdowns.

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

1. Build and install your debug APK onto an Android 8.0+ device or emulator.
2. Enable your service in System Settings:
* **Settings** → **System** → **Languages & input** → **Autofill service** (or **Settings** → **Passwords & accounts** → **Autofill service**).


3. Select **[Your App Name]** as the active primary autofill service provider.
4. Launch any app containing a login form or open Chrome to a login page.
5. Tap an input field to trigger the OS autofill popover containing your app's custom presentation entries.