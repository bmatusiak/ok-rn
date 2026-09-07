Architecting a React Native application that communicates with physical **USB Human Interface Devices (HID)** on Android requires balancing two realities:

1. **Production:** Physical Android hardware communicates with USB devices using the native `android.hardware.usb.UsbManager` framework over USB OTG.
2. **Development:** Android Studio’s Emulator runs in a virtualized QEMU layer that cannot easily pass through raw host USB endpoints without complex root setups.

To build and test your React Native UI, state management, and business logic without physical hardware attached, the optimal architecture uses a **Dual-Path Native Bridge with a TCP-backed Hardware Emulator**.

---

### Architecture Overview

```
                        ┌──────────────────────────────────────────────┐
                        │              React Native App                │
                        │             (JavaScript / TS)                │
                        └──────────────────────┬───────────────────────┘
                                               │
                                     Native Module Bridge
                                               │
                      ┌────────────────────────┴────────────────────────┐
                      │                                                 │
            BuildConfig.DEBUG                                        #else
                      │                                                 │
                      v                                                 v
        ┌───────────────────────────┐                     ┌───────────────────────────┐
        │     TCP Socket Client     │                     │     UsbManager / OTG      │
        │    (java.net.Socket)      │                     │    (Physical Hardware)    │
        └─────────────┬─────────────┘                     └─────────────┬─────────────┘
                      │                                                 │
         Virtual Loopback (10.0.2.2)                              USB OTG / Type-C
                      │                                                 │
                      v                                                 v
        ┌───────────────────────────┐                     ┌───────────────────────────┐
        │   Mac Hardware Emulator   │                     │    Physical USB Device    │
        │        (Node.js)          │                     │    (Microcontroller)      │
        └───────────────────────────┘                     └───────────────────────────┘

```

Using build configuration flags (`BuildConfig.DEBUG`), your Kotlin native module handles transport routing under the hood. Android emulators use `10.0.2.2` as a virtual loopback alias to reach `127.0.0.1` on your development host machine.

---

### Step 1: Create the Mac Hardware Emulator (Node.js)

Create a Node.js TCP server script on your Mac to simulate your physical hardware device. This script receives outbound reports from the Android emulator and periodically pushes byte arrays to emulate hardware state changes.

Create `hardware-emulator.js`:

```javascript
const net = require('net');

const PORT = 9000;
const HOST = '0.0.0.0'; // Bind to all interfaces for emulator access

const server = net.createServer((socket) => {
  console.log('📱 Android Emulator connected to TCP Hardware Emulator!');

  // 1. Periodically emit simulated input reports (e.g., sensor data/button presses)
  const timer = setInterval(() => {
    // Format: [ReportID, DataByte1, DataByte2, DataByte3]
    const mockReport = Buffer.from([0x01, Math.floor(Math.random() * 255), 0xAA, 0x55]);
    console.log('➡️ [Hardware Out -> Android In]:', Array.from(mockReport));
    socket.write(mockReport);
  }, 2500);

  // 2. Listen for commands sent from the Android React Native app
  socket.on('data', (data) => {
    const bytes = Array.from(data);
    console.log('⬅️ [Android Out -> Hardware In]:', bytes);

    // Example state logic: If JS sends command [0x01, 0xFF], send an immediate ACK response
    if (bytes[0] === 0x01 && bytes[1] === 0xFF) {
      console.log('⚡ ACK command received! Replying...');
      socket.write(Buffer.from([0x01, 0x00, 0x00, 0x00]));
    }
  });

  socket.on('close', () => {
    console.log('📱 Emulator disconnected.');
    clearInterval(timer);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Hardware Emulator running on port ${PORT}`);
  console.log('Ready for Android Emulator connections...\n');
});

```

To run the server:

```bash
node hardware-emulator.js

```

---

### Step 2: Configure Android Manifest and Filters

Add the USB host feature to `android/app/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-feature android:name="android.hardware.usb.host" android:required="true" />

    <application ...>
        <activity android:name=".MainActivity" ...>
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

Create `android/app/src/main/res/xml/device_filter.xml` to filter your target vendor and product IDs in decimal (e.g., `0x1234` -> `4660`, `0x5678` -> `22136`):

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <usb-device vendor-id="4660" product-id="22136" />
</resources>

```

---

### Step 3: Implement the Kotlin Native Module

Create `android/app/src/main/java/com/yourapp/UsbHidModule.kt`. This module uses `java.net.Socket` in debug/emulator environments and `UsbManager` for physical hardware on release builds.

```kotlin
package com.yourapp

import android.content.Context
import android.hardware.usb.*
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.util.concurrent.Executors

class UsbHidModule(private val reactContext: ReactApplicationContext) : 
    ReactContextBaseJavaModule(reactContext) {

    // TCP Properties (Emulator)
    private var tcpSocket: Socket? = null
    private var tcpInputStream: InputStream? = null
    private var tcpOutputStream: OutputStream? = null

    // UsbManager Properties (Physical Hardware)
    private var usbManager: UsbManager = reactContext.getSystemService(Context.USB_SERVICE) as UsbManager
    private var usbConnection: UsbDeviceConnection? = null
    private var inEndpoint: UsbEndpoint? = null
    private var outEndpoint: UsbEndpoint? = null

    private var isReading = false
    private val executor = Executors.newSingleThreadExecutor()

    override fun getName(): String = "UsbHidModule"

    // MARK: - Device Discovery / Connection
    @ReactMethod
    fun startDiscovery() {
        if (BuildConfig.DEBUG) {
            // EMULATOR PATH: 10.0.2.2 maps to Mac host loopback (127.0.0.1:9000)
            connectToTcpEmulator("10.0.2.2", 9000)
        } else {
            // PHYSICAL DEVICE PATH: Native Android UsbManager
            startUsbHidDiscovery()
        }
    }

    // MARK: - Emulator Path (TCP Socket)
    private fun connectToTcpEmulator(host: String, port: Int) {
        executor.execute {
            try {
                val socket = Socket(host, port)
                this.tcpSocket = socket
                this.tcpInputStream = socket.getInputStream()
                this.tcpOutputStream = socket.getOutputStream()

                sendEvent("OnHidDeviceStatus", Arguments.createMap().apply {
                    putString("status", "Connected (TCP Mock)")
                })

                listenTcpStream()
            } catch (e: Exception) {
                sendEvent("OnHidDeviceStatus", Arguments.createMap().apply {
                    putString("status", "TCP Connection Error: ${e.localizedMessage}")
                })
            }
        }
    }

    private fun listenTcpStream() {
        isReading = true
        val buffer = ByteArray(64) // Standard 64-byte HID report buffer

        try {
            while (isReading) {
                val bytesRead = tcpInputStream?.read(buffer) ?: -1
                if (bytesRead > 0) {
                    val receivedData = WritableNativeArray()
                    for (i in 0 until bytesRead) {
                        receivedData.pushInt(buffer[i].toInt() and 0xFF)
                    }
                    sendEvent("OnHidDataReceived", Arguments.createMap().apply {
                        putArray("data", receivedData)
                    })
                } else if (bytesRead == -1) {
                    break
                }
            }
        } catch (e: Exception) {
            // Socket disconnected
        } finally {
            sendEvent("OnHidDeviceStatus", Arguments.createMap().apply {
                putString("status", "Disconnected")
            })
        }
    }

    // MARK: - Physical Device Path (UsbManager)
    private fun startUsbHidDiscovery() {
        val deviceList = usbManager.deviceList
        val targetDevice = deviceList.values.find { it.vendorId == 0x1234 && it.productId == 0x5678 }

        if (targetDevice == null) {
            sendEvent("OnHidDeviceStatus", Arguments.createMap().apply {
                putString("status", "Device Not Found")
            })
            return
        }

        val hidInterface = targetDevice.getInterface(0)
        val connection = usbManager.openDevice(targetDevice)

        if (connection != null && connection.claimInterface(hidInterface, true)) {
            this.usbConnection = connection

            for (i in 0 until hidInterface.endpointCount) {
                val ep = hidInterface.getEndpoint(i)
                if (ep.direction == UsbConstants.USB_DIR_IN) inEndpoint = ep
                else if (ep.direction == UsbConstants.USB_DIR_OUT) outEndpoint = ep
            }

            sendEvent("OnHidDeviceStatus", Arguments.createMap().apply {
                putString("status", "Connected")
            })

            listenUsbEndpoints()
        } else {
            sendEvent("OnHidDeviceStatus", Arguments.createMap().apply {
                putString("status", "Failed to Claim Interface")
            })
        }
    }

    private fun listenUsbEndpoints() {
        isReading = true
        executor.execute {
            val ep = inEndpoint ?: return@execute
            val conn = usbConnection ?: return@execute
            val buffer = ByteArray(ep.maxPacketSize)

            while (isReading) {
                val bytesRead = conn.bulkTransfer(ep, buffer, buffer.size, 1000)
                if (bytesRead > 0) {
                    val receivedData = WritableNativeArray()
                    for (i in 0 until bytesRead) {
                        receivedData.pushInt(buffer[i].toInt() and 0xFF)
                    }
                    sendEvent("OnHidDataReceived", Arguments.createMap().apply {
                        putArray("data", receivedData)
                    })
                }
            }
        }
    }

    // MARK: - Unified Write Interface
    @ReactMethod
    fun sendReport(reportId: Int, payload: ReadableArray, promise: Promise) {
        if (BuildConfig.DEBUG) {
            // EMULATOR WRITE
            executor.execute {
                try {
                    val stream = tcpOutputStream
                    if (stream == null) {
                        promise.reject("ERR_NOT_CONNECTED", "TCP Mock server is not connected")
                        return@execute
                    }

                    val bytes = ByteArray(payload.size() + 1)
                    bytes[0] = reportId.toByte()
                    for (i in 0 until payload.size()) {
                        bytes[i + 1] = payload.getInt(i).toByte()
                    }

                    stream.write(bytes)
                    stream.flush()
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.reject("ERR_WRITE_FAILED", "TCP Write Error: ${e.localizedMessage}")
                }
            }
        } else {
            // PHYSICAL DEVICE WRITE
            executor.execute {
                val conn = usbConnection
                val ep = outEndpoint

                if (conn == null || ep == null) {
                    promise.reject("ERR_NOT_CONNECTED", "No physical HID device connected")
                    return@execute
                }

                val bytes = ByteArray(payload.size())
                for (i in 0 until payload.size()) {
                    bytes[i] = payload.getInt(i).toByte()
                }

                val bytesWritten = conn.bulkTransfer(ep, bytes, bytes.size, 1000)
                if (bytesWritten >= 0) {
                    promise.resolve(bytesWritten)
                } else {
                    promise.reject("ERR_WRITE_FAILED", "USB Transfer failed")
                }
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

Register the module inside `android/app/src/main/java/com/yourapp/UsbHidPackage.kt`:

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

Add `UsbHidPackage()` to `MainApplication.kt` inside your `getPackages()` declaration.

---

### Step 4: Implement in React Native (TypeScript)

Build a clean application component that manages UI state and communicates with the native module.

```tsx
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Button, FlatList, DeviceEventEmitter } from 'react-native';
import { NativeModules } from 'react-native';

const { UsbHidModule } = NativeModules;

export default function App() {
  const [status, setStatus] = useState<string>('Disconnected');
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    // 1. Listen for connection status changes
    const statusSub = DeviceEventEmitter.addListener('OnHidDeviceStatus', (evt) => {
      setStatus(evt.status);
      addLog(`Status: ${evt.status}`);
    });

    // 2. Listen for incoming raw bytes from hardware (or TCP mock)
    const dataSub = DeviceEventEmitter.addListener('OnHidDataReceived', (evt) => {
      const hexString = evt.data.map((b: number) => `0x${b.toString(16).padStart(2, '0').toUpperCase()}`).join(' ');
      addLog(`READ: [ ${hexString} ]`);
    });

    // Start discovering device/mock
    UsbHidModule.startDiscovery();

    return () => {
      statusSub.remove();
      dataSub.remove();
    };
  }, []);

  const addLog = (msg: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 19)]);
  };

  const handleSendQuery = async () => {
    try {
      const reportId = 0x01;
      const payload = [0xFF, 0x00, 0x01]; // Command payload

      await UsbHidModule.sendReport(reportId, payload);
      addLog(`WRITE SUCCESS: Report ${reportId}`);
    } catch (error: any) {
      addLog(`WRITE ERROR: ${error.message}`);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>USB HID Interface (Android)</Text>
      <Text style={styles.status}>Status: <Text style={styles.statusValue}>{status}</Text></Text>

      <View style={styles.buttonContainer}>
        <Button title="Send HID Report [0x01, 0xFF]" onPress={handleSendQuery} />
      </View>

      <Text style={styles.logTitle}>Data Stream Logs:</Text>
      <FlatList
        data={logs}
        keyExtractor={(_, index) => index.toString()}
        renderItem={({ item }) => <Text style={styles.logItem}>{item}</Text>}
        style={styles.logList}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 60, paddingHorizontal: 20, backgroundColor: '#F5F5F7' },
  title: { fontSize: 22, fontWeight: 'bold', marginBottom: 10 },
  status: { fontSize: 16, marginBottom: 20 },
  statusValue: { fontWeight: '600', color: '#007AFF' },
  buttonContainer: { marginBottom: 20 },
  logTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 10 },
  logList: { flex: 1, backgroundColor: '#1C1C1E', borderRadius: 8, padding: 10 },
  logItem: { color: '#30D158', fontFamily: 'monospace', fontSize: 12, marginBottom: 4 }
});

```

---

### Step 5: Verification and Testing Workflow

1. **Start the Mock Server:** Open a terminal on your Mac and run `node hardware-emulator.js`.
2. **Launch in Android Emulator:** Run `npx react-native run-android`.
3. **Verify TCP Data Flow:**
* Watch the Node.js terminal log: `📱 Android Emulator connected to TCP Hardware Emulator!`.
* Watch your React Native UI output incoming bytes emitted by the timer every 2.5 seconds.
* Tap **Send HID Report** in the app UI and verify the Node.js console logs the incoming write array `⬅️ [Android Out -> Hardware In]: [1, 255, 0, 1]`.


4. **Deploy to Physical Hardware:** Build a release APK or run on a physical device with USB OTG attached. The native code automatically falls back to `UsbManager` and streams data directly from the USB hardware port.