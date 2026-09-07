Android handles USB HID natively via the `android.hardware.usb` API without requiring any special licenses or MFi programs.

Because Android handles direct USB host connections natively, you can build a **Native Kotlin/Java Module** for React Native to manage device discovery, permissions, reading input endpoints, and writing to output endpoints.

---

### Step 1: Android Manifest Configuration

Android requires explicit intent filters so your app can request USB host access from the OS.

1. Open `android/app/src/main/AndroidManifest.xml`.
2. Ensure USB Host feature declaration and permission intent filters are present inside `<activity>`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-feature android:name="android.hardware.usb.host" android:required="true" />

    <application ...>
        <activity android:name=".MainActivity" ...>
            <!-- Add this intent filter to automatically prompt app when USB device attaches -->
            <intent-filter>
                <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
            </intent-filter>
            <meta-data 
                android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" 
                android:resource="@xml/device_filter" />
        </activity>
    </application>
</manifest>

```

3. Create the device filter at `android/app/src/main/res/xml/device_filter.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Replace vendor-id and product-id with your target hardware (decimal format) -->
    <usb-device vendor-id="4660" product-id="22136" />
</resources>

```

---

### Step 2: Write the Native Kotlin Module

Create a custom Native Module using Android's `UsbManager`, `UsbDeviceConnection`, and asynchronous transfer threads.

Create `UsbHidModule.kt` inside `android/app/src/main/java/com/yourapp/`:

```kotlin
package com.yourapp

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.*
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.Executors

class UsbHidModule(private val reactContext: ReactApplicationContext) : 
    ReactContextBaseJavaModule(reactContext) {

    private var usbManager: UsbManager = reactContext.getSystemService(Context.USB_SERVICE) as UsbManager
    private var usbConnection: UsbDeviceConnection? = null
    private var inEndpoint: UsbEndpoint? = null
    private var outEndpoint: UsbEndpoint? = null
    private var isReading = false
    private val executor = Executors.newSingleThreadExecutor()

    override fun getName(): String = "UsbHidModule"

    // 1. Discover and Connect to HID Device
    @ReactMethod
    fun connectDevice(vendorId: Int, productId: Int, promise: Promise) {
        val deviceList = usbManager.deviceList
        val targetDevice = deviceList.values.find { it.vendorId == vendorId && it.productId == productId }

        if (targetDevice == null) {
            promise.reject("ERR_DEVICE_NOT_FOUND", "No matching HID device connected")
            return
        }

        // Request permission if not already granted
        if (!usbManager.hasPermission(targetDevice)) {
            val permissionIntent = PendingIntent.getBroadcast(
                reactContext, 0, Intent("com.yourapp.USB_PERMISSION"), PendingIntent.FLAG_IMMUTABLE
            )
            usbManager.requestPermission(targetDevice, permissionIntent)
            promise.reject("ERR_PERMISSION_REQUIRED", "Permission requested from user")
            return
        }

        // Find the HID Interface (typically Class 3)
        var hidInterface: UsbInterface? = null
        for (i in 0 until targetDevice.interfaceCount) {
            val iface = targetDevice.getInterface(i)
            if (iface.interfaceClass == UsbConstants.USB_CLASS_HID) {
                hidInterface = iface
                break
            }
        }

        val intf = hidInterface ?: targetDevice.getInterface(0)
        val connection = usbManager.openDevice(targetDevice)

        if (connection != null && connection.claimInterface(intf, true)) {
            this.usbConnection = connection

            // Map Endpoints
            for (i in 0 until intf.endpointCount) {
                val ep = intf.getEndpoint(i)
                if (ep.direction == UsbConstants.USB_DIR_IN) {
                    inEndpoint = ep
                } else if (ep.direction == UsbConstants.USB_DIR_OUT) {
                    outEndpoint = ep
                }
            }

            startReadingThread()
            promise.resolve(true)
        } else {
            promise.reject("ERR_CLAIM_FAILED", "Failed to claim USB interface")
        }
    }

    // 2. Asynchronously Read Input Endpoints
    private fun startReadingThread() {
        isReading = true
        executor.execute {
            val ep = inEndpoint ?: return@execute
            val conn = usbConnection ?: return@execute
            val buffer = ByteArray(ep.maxPacketSize)

            while (isReading) {
                // Bulk / Interrupt Transfer (Timeout set to 1000ms)
                val bytesRead = conn.bulkTransfer(ep, buffer, buffer.size, 1000)
                if (bytesRead > 0) {
                    val receivedData = WritableNativeArray()
                    for (i in 0 until bytesRead) {
                        receivedData.pushInt(buffer[i].toInt() and 0xFF)
                    }
                    sendEvent("OnHidDataReceived", receivedData)
                }
            }
        }
    }

    // 3. Write Output Reports (WRITE)
    @ReactMethod
    fun sendReport(payload: ReadableArray, promise: Promise) {
        val conn = usbConnection
        val ep = outEndpoint

        if (conn == null || ep == null) {
            promise.reject("ERR_NOT_CONNECTED", "USB Output endpoint not available")
            return
        }

        val bytes = ByteArray(payload.size())
        for (i in 0 until payload.size()) {
            bytes[i] = payload.getInt(i).toByte()
        }

        executor.execute {
            val bytesWritten = conn.bulkTransfer(ep, bytes, bytes.size, 1000)
            if (bytesWritten >= 0) {
                promise.resolve(bytesWritten)
            } else {
                promise.reject("ERR_WRITE_FAILED", "Failed to write payload down to USB device")
            }
        }
    }

    private fun sendEvent(eventName: String, params: Any?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }
}

```

#### Register Package in `UsbHidPackage.kt`

```kotlin
package com.yourapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class UsbHidPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(UsbHidModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}

```

Add `UsbHidPackage()` to your application's `MainApplication.kt` file inside `getPackages()`.

---

### Step 3: Implement in React Native (JavaScript/TypeScript)

```tsx
import React, { useEffect, useState } from 'react';
import { View, Text, Button, NativeModules, DeviceEventEmitter } from 'react-native';

const { UsbHidModule } = NativeModules;

export default function App() {
  const [status, setStatus] = useState<string>('Disconnected');
  const [data, setData] = useState<number[]>([]);

  useEffect(() => {
    // Listen to incoming HID bytes
    const subscription = DeviceEventEmitter.addListener('OnHidDataReceived', (bytes: number[]) => {
      console.log('Received Android USB bytes:', bytes);
      setData(bytes);
    });

    return () => subscription.remove();
  }, []);

  const connectToUsb = async () => {
    try {
      // Pass hex converted to integer (e.g., VendorID 0x1234 -> 4660)
      await UsbHidModule.connectDevice(0x1234, 0x5678);
      setStatus('Connected');
    } catch (err) {
      console.error(err);
      setStatus('Connection Failed');
    }
  };

  const sendData = async () => {
    try {
      const payload = [0x01, 0xFF, 0x00, 0xAA];
      await UsbHidModule.sendReport(payload);
      console.log('Sent data successfully');
    } catch (err) {
      console.error('Write failed:', err);
    }
  };

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>USB Status: {status}</Text>
      <Text>Payload: {JSON.stringify(data)}</Text>
      <Button title="Connect USB Device" onPress={connectToUsb} />
      <Button title="Send Payload" onPress={sendData} />
    </View>
  );
}

```

---

### Step 4: Verification Check

1. Connect your Android device via USB OTG adapter to your hardware target.
2. Build and run: `npx react-native run-android`.
3. Press **Connect USB Device**:
* **Verification:** Check Android permissions dialog pops up asking to allow USB access.
* **Read Verification:** After granting permission, send an input event from the device and verify bytes log to the terminal.
* **Write Verification:** Triggering `sendData()` should return the number of bytes successfully transferred down the `outEndpoint`.