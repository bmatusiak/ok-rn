1. **Configure Manifest & Dynamic Permissions:** Targeting Android 12+ (API level 31+).
Declare the required Bluetooth hardware permissions in `AndroidManifest.xml` and handle runtime checks in code.

**AndroidManifest.xml**

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- Permissions for Android 12+ (API 31+) -->
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />

    <!-- Legacy Permissions for Android 11 and lower -->
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />

    <uses-feature android:name="android.hardware.bluetooth" android:required="true" />

    <application ...>
        ...
    </application>
</manifest>

```

**Runtime Permission Handler (`MainActivity.kt`)**

```kotlin
import android.Manifest
import android.os.Build
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val allGranted = permissions.entries.all { it.value }
        if (allGranted) {
            // Safe to start Bluetooth setup
        }
    }

    fun checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissionLauncher.launch(
                arrayOf(
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_ADVERTISE
                )
            )
        } else {
            requestPermissionLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION
                )
            )
        }
    }
}

```


2. **Create the HID Keycode Translation Constants:** Translates standard key inputs into USB HID scan codes.
USB HID controllers send raw scan codes rather than ASCII characters. Create an helper file `HidKeycodes.kt` to manage translation.

```kotlin
object HidKeycodes {
    // Modifiers (Byte 0)
    const val MODIFIER_NONE: Byte = 0x00
    const val MODIFIER_LEFT_CTRL: Byte = (1 shl 0).toByte()
    const val MODIFIER_LEFT_SHIFT: Byte = (1 shl 1).toByte()
    const val MODIFIER_LEFT_ALT: Byte = (1 shl 2).toByte()
    const val MODIFIER_LEFT_GUI: Byte = (1 shl 3).toByte() // Windows Key
    const val MODIFIER_RIGHT_CTRL: Byte = (1 shl 4).toByte()
    const val MODIFIER_RIGHT_SHIFT: Byte = (1 shl 5).toByte()

    // Keycodes (Byte 2-7)
    const val KEY_NONE: Byte = 0x00
    const val KEY_A: Byte = 0x04
    const val KEY_B: Byte = 0x05
    const val KEY_C: Byte = 0x06
    const val KEY_D: Byte = 0x07
    const val KEY_E: Byte = 0x08
    const val KEY_F: Byte = 0x09
    const val KEY_G: Byte = 0x0A
    const val KEY_H: Byte = 0x0B
    const val KEY_I: Byte = 0x0C
    const val KEY_J: Byte = 0x0D
    const val KEY_K: Byte = 0x0E
    const val KEY_L: Byte = 0x0F
    const val KEY_M: Byte = 0x10
    const val KEY_N: Byte = 0x11
    const val KEY_O: Byte = 0x12
    const val KEY_P: Byte = 0x13
    const val KEY_Q: Byte = 0x14
    const val KEY_R: Byte = 0x15
    const val KEY_S: Byte = 0x16
    const val KEY_T: Byte = 0x17
    const val KEY_U: Byte = 0x18
    const val KEY_V: Byte = 0x19
    const val KEY_W: Byte = 0x1A
    const val KEY_X: Byte = 0x1B
    const val KEY_Y: Byte = 0x1C
    const val KEY_Z: Byte = 0x1D

    const val KEY_1: Byte = 0x1E
    const val KEY_2: Byte = 0x1F
    const val KEY_3: Byte = 0x20
    const val KEY_4: Byte = 0x21
    const val KEY_5: Byte = 0x22
    const val KEY_6: Byte = 0x23
    const val KEY_7: Byte = 0x24
    const val KEY_8: Byte = 0x25
    const val KEY_9: Byte = 0x26
    const val KEY_0: Byte = 0x27

    const val KEY_ENTER: Byte = 0x28
    const val KEY_ESCAPE: Byte = 0x29
    const val KEY_BACKSPACE: Byte = 0x2A
    const val KEY_TAB: Byte = 0x2B
    const val KEY_SPACE: Byte = 0x2C

    /**
     * Converts printable ASCII chars into an HID payload pair: Pair(Modifier, KeyCode)
     */
    fun charToHid(char: Char): Pair<Byte, Byte> {
        return when (char) {
            in 'a'..'z' -> Pair(MODIFIER_NONE, (KEY_A + (char - 'a')).toByte())
            in 'A'..'Z' -> Pair(MODIFIER_LEFT_SHIFT, (KEY_A + (char - 'A')).toByte())
            in '1'..'9' -> Pair(MODIFIER_NONE, (KEY_1 + (char - '1')).toByte())
            '0' -> Pair(MODIFIER_NONE, KEY_0)
            ' ' -> Pair(MODIFIER_NONE, KEY_SPACE)
            '\n' -> Pair(MODIFIER_NONE, KEY_ENTER)
            else -> Pair(MODIFIER_NONE, KEY_NONE)
        }
    }
}

```


3. **Build the Bluetooth HID Service Controller:** Encapsulates profile initialization, SDP registration, and key reporting.
Create a dedicated class `BtKeyboardManager.kt` to interface with system-level Bluetooth APIs.

```kotlin
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothProfile
import android.content.Context
import java.util.concurrent.Executors

class BtKeyboardManager(private val context: Context) {

    private val bluetoothAdapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var hidDeviceProfile: BluetoothHidDevice? = null
    private var connectedHostDevice: BluetoothDevice? = null

    // Standard Keyboard SDP Report Descriptor
    private val hidDescriptor = byteArrayOf(
        0x05.toByte(), 0x01.toByte(), // USAGE_PAGE (Generic Desktop)
        0x09.toByte(), 0x06.toByte(), // USAGE (Keyboard)
        0xA1.toByte(), 0x01.toByte(), // COLLECTION (Application)
        0x05.toByte(), 0x07.toByte(), //   USAGE_PAGE (Keyboard)
        0x19.toByte(), 0xE0.toByte(), //   USAGE_MINIMUM (Keyboard Left Control)
        0x29.toByte(), 0xE7.toByte(), //   USAGE_MAXIMUM (Keyboard Right GUI)
        0x15.toByte(), 0x00.toByte(), //   LOGICAL_MINIMUM (0)
        0x25.toByte(), 0x01.toByte(), //   LOGICAL_MAXIMUM (1)
        0x75.toByte(), 0x01.toByte(), //   REPORT_SIZE (1)
        0x95.toByte(), 0x08.toByte(), //   REPORT_COUNT (8)
        0x81.toByte(), 0x02.toByte(), //   INPUT (Data, Var, Abs) - Modifiers
        0x95.toByte(), 0x01.toByte(), //   REPORT_COUNT (1)
        0x75.toByte(), 0x08.toByte(), //   REPORT_SIZE (8)
        0x81.toByte(), 0x01.toByte(), //   INPUT (Cnst, Var, Abs) - Reserved
        0x95.toByte(), 0x05.toByte(), //   REPORT_COUNT (5)
        0x75.toByte(), 0x01.toByte(), //   REPORT_SIZE (1)
        0x05.toByte(), 0x08.toByte(), //   USAGE_PAGE (LEDs)
        0x19.toByte(), 0x01.toByte(), //   USAGE_MINIMUM (Num Lock)
        0x29.toByte(), 0x05.toByte(), //   USAGE_MAXIMUM (Kana)
        0x91.toByte(), 0x02.toByte(), //   OUTPUT (Data, Var, Abs)
        0x95.toByte(), 0x01.toByte(), //   REPORT_COUNT (1)
        0x75.toByte(), 0x03.toByte(), //   REPORT_SIZE (3)
        0x91.toByte(), 0x01.toByte(), //   OUTPUT (Cnst, Var, Abs) - LED Padding
        0x95.toByte(), 0x06.toByte(), //   REPORT_COUNT (6)
        0x75.toByte(), 0x08.toByte(), //   REPORT_SIZE (8)
        0x15.toByte(), 0x00.toByte(), //   LOGICAL_MINIMUM (0)
        0x25.toByte(), 0x65.toByte(), //   LOGICAL_MAXIMUM (101)
        0x05.toByte(), 0x07.toByte(), //   USAGE_PAGE (Keyboard)
        0x19.toByte(), 0x00.toByte(), //   USAGE_MINIMUM (0)
        0x29.toByte(), 0x65.toByte(), //   USAGE_MAXIMUM (101)
        0x81.toByte(), 0x00.toByte(), //   INPUT (Data, Ary, Abs) - Key Array
        0xC0.toByte()                  // END_COLLECTION
    )

    private val serviceListener = object : BluetoothProfile.ServiceListener {
        @SuppressLint("MissingPermission")
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
            if (profile == BluetoothProfile.HID_DEVICE) {
                hidDeviceProfile = proxy as BluetoothHidDevice
                registerSdpApp()
            }
        }

        override fun onServiceDisconnected(profile: Int) {
            if (profile == BluetoothProfile.HID_DEVICE) {
                hidDeviceProfile = null
                connectedHostDevice = null
            }
        }
    }

    private val hidCallback = object : BluetoothHidDevice.Callback() {
        override fun onConnectionStateChanged(device: BluetoothDevice, state: Int) {
            if (state == BluetoothProfile.STATE_CONNECTED) {
                connectedHostDevice = device
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                connectedHostDevice = null
            }
        }
    }

    @SuppressLint("MissingPermission")
    fun initialize() {
        bluetoothAdapter?.getProfileProxy(
            context,
            serviceListener,
            BluetoothProfile.HID_DEVICE
        )
    }

    @SuppressLint("MissingPermission")
    private fun registerSdpApp() {
        val sdpSettings = BluetoothHidDeviceAppSdpSettings(
            "Android Remote Keyboard",
            "Virtual Keyboard input via Android",
            "AndroidProvider",
            BluetoothHidDevice.SUBCLASS1_KEYBOARD,
            hidDescriptor
        )

        hidDeviceProfile?.registerApp(
            sdpSettings,
            null,
            null,
            Executors.newSingleThreadExecutor(),
            hidCallback
        )
    }

    /**
     * Sends a Key Down event followed immediately by a Key Up event
     */
    @SuppressLint("MissingPermission")
    fun sendKey(keyCode: Byte, modifier: Byte = HidKeycodes.MODIFIER_NONE) {
        val device = connectedHostDevice ?: return
        val hidProfile = hidDeviceProfile ?: return

        // 1. Key Down
        val keyDownReport = byteArrayOf(
            modifier,
            0x00,
            keyCode,
            0x00, 0x00, 0x00, 0x00, 0x00
        )
        hidProfile.sendReport(device, 0, keyDownReport)

        // 2. Key Up (Release All Keys)
        val keyUpReport = byteArrayOf(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
        hidProfile.sendReport(device, 0, keyUpReport)
    }

    /**
     * Helper to send an entire string sequentially
     */
    fun sendString(text: String) {
        text.forEach { char ->
            val (modifier, keycode) = HidKeycodes.charToHid(char)
            if (keycode != HidKeycodes.KEY_NONE) {
                sendKey(keycode, modifier)
                Thread.sleep(15) // Brief delay to ensure host registers separate strokes
            }
        }
    }

    @SuppressLint("MissingPermission")
    fun teardown() {
        hidDeviceProfile?.unregisterApp()
        bluetoothAdapter?.closeProfileProxy(BluetoothProfile.HID_DEVICE, hidDeviceProfile)
    }
}

```


4. **Establish Connection to Windows PC:** Pairing workflow for Windows.
1. Call `btManager.initialize()` in your Activity after verifying runtime permissions.
2. Make the Android device discoverable via system settings or programmatically using `Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE)`.
3. Open **Settings → Bluetooth & Devices** on Windows.
4. Click **Add Device → Bluetooth**.
5. Select your Android phone. Once paired, Windows automatically installs the system **HID Keyboard Device** drivers.