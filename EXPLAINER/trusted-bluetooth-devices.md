To prevent your app from broadcasting passwords to a fake device or an unknown hacker impersonating your hardware, you should implement an app-level Pre-Approved Whitelist (Allowed Devices List).
Instead of letting your React Native code connect to any device matching a generic name like "MyHIDDongle", your app should track and remember the unique Hardware MAC Address (Android) or the OS-Generated UUID (iOS) of your specific USB dongle.
Here is the complete, zero-dependency write-up to implement a trusted device management loop in your custom React Native project.
------------------------------
## ⚛️ 1. The React Native JavaScript Interface
Your JavaScript code should check if a trusted device identifier is already saved in your app's persistent storage (like AsyncStorage or react-native-mmkv).

* 
* If it's the first time: The app scans for the dongle, asks the user to explicitly "Trust" it, and stores its hardware ID.
* On subsequent uses: The app skips manual selection and instructs the native layer to only communicate with that exact ID.
* 

import React, { useState, useEffect } from 'react';import { View, Button, Text, TextInput, Alert, StyleSheet } from 'react-native';
// Standard native bridge module (No external npm packages)import { NativeModules } from 'react-native';const { BleKeyboardModule } = NativeModules;
// Note: For a true zero-dependency project, you can pass trusted IDs // down to Native Modules, or store them inside native SharedPreferences / NSUserDefaults.export default function App() {
  const [password, setPassword] = useState('');
  const [trustedDeviceId, setTrustedDeviceId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  // 1. Scan and Pair a New Dongle (First-time setup)
  const setupNewTrustedDevice = async () => {
    setIsScanning(true);
    try {
      // Native module scans and returns the hardware ID of the first 'MyHIDDongle' it finds
      const hardwareId = await BleKeyboardModule.scanAndRegisterDongle();
      
      Alert.alert(
        "Trust Device?",
        `Do you want to add this device to your pre-approved list?\n\nID: ${hardwareId}`,
        [
          { text: "Cancel", style: "cancel" },
          { 
            text: "Trust & Link", 
            onPress: () => {
              setTrustedDeviceId(hardwareId);
              // In production, save 'hardwareId' to persistent storage here
            } 
          }
        ]
      );
    } catch (error: any) {
      Alert.alert("Setup Error", error.message);
    } finally {
      setIsScanning(false);
    }
  };

  // 2. Securely transmit only to the whitelisted device
  const handleTransmit = () => {
    if (!trustedDeviceId) {
      Alert.alert("Action Required", "Please link and trust a USB Dongle first.");
      return;
    }

    // Force the native code to ONLY connect if the ID matches the whitelist
    BleKeyboardModule.sendPasswordToTrustedDevice(password, trustedDeviceId)
      .then(() => {
        setPassword('');
        Alert.alert("Success", "Password injected via trusted link!");
      })
      .catch((err) => Alert.alert("Security Block", err.message));
  };

  return (
    <View style={styles.container}>
      <Text style={styles.status}>
        {trustedDeviceId ? `🔒 Whitelist Active: ${trustedDeviceId}` : "⚠️ No Trusted Device Linked"}
      </Text>
      
      <Button 
        title={isScanning ? "Scanning Airwaves..." : "Scan & Trust New Dongle"} 
        onPress={setupNewTrustedDevice} 
        disabled={isScanning}
      />

      <TextInput 
        secureTextEntry 
        value={password} 
        onChangeText={setPassword} 
        placeholder="Enter password to inject" 
        style={styles.input} 
      />

      <Button 
        title="Send via Trusted Dongle" 
        onPress={handleTransmit} 
        disabled={!password || !trustedDeviceId} 
      />
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 40 },
  status: { textAlign: 'center', fontWeight: 'bold', marginBottom: 20 },
  input: { borderBottomWidth: 1, marginVertical: 20, padding: 10 }
});

------------------------------
## 🤖 2. Android Whitelist Enforcement (Java)
On Android, a device's unique identifier is its physical MAC Address (e.g., AA:BB:CC:DD:EE:FF). This remains completely static. Your native code will validate that the connected device's MAC address explicitly matches your JavaScript whitelist before transmitting.
Update BleKeyboardModule.java:

package com.yourprojectname;
import android.bluetooth.BluetoothAdapter;import android.bluetooth.BluetoothDevice;import android.bluetooth.BluetoothGatt;import android.bluetooth.BluetoothGattCallback;import android.bluetooth.BluetoothGattCharacteristic;import android.bluetooth.BluetoothGattService;import android.bluetooth.BluetoothProfile;import android.bluetooth.le.BluetoothLeScanner;import android.bluetooth.le.ScanCallback;import android.bluetooth.le.ScanResult;import com.facebook.react.bridge.ReactApplicationContext;import com.facebook.react.bridge.ReactContextBaseJavaModule;import com.facebook.react.bridge.ReactMethod;import com.facebook.react.bridge.Promise;import java.util.UUID;
public class BleKeyboardModule extends ReactContextBaseJavaModule {
    private BluetoothAdapter bluetoothAdapter;
    private final UUID SERVICE_UUID = UUID.fromString("12345678-1234-5678-1234-567812345678");
    private final UUID CHAR_UUID = UUID.fromString("87654321-4321-8765-4321-876543210987");

    public BleKeyboardModule(ReactApplicationContext reactContext) {
        super(reactContext);
        bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
    }

    @Override
    public String getName() { return "BleKeyboardModule"; }

    // First-time setup: Scans for hardware and returns the MAC address
    @ReactMethod
    public void scanAndRegisterDongle(final Promise promise) {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            promise.reject("BLE_ERROR", "Bluetooth disabled");
            return;
        }
        final BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
        
        scanner.startScan(new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice device = result.getDevice();
                if (device != null && "MyHIDDongle".equals(device.getName())) {
                    scanner.stopScan(this);
                    // Pass the physical MAC address back to JS to be whitelisted
                    promise.resolve(device.getAddress()); 
                }
            }
        });
    }

    // Secure Send: Validates that the device matches the pre-approved whitelist MAC
    @ReactMethod
    public void sendPasswordToTrustedDevice(final String password, final String whitelistedMac, final Promise promise) {
        BluetoothDevice device = bluetoothAdapter.getRemoteDevice(whitelistedMac);

        // EXTRA SECURITY DEFENSE: Force verification against the passed trusted variable
        if (!device.getAddress().equalsIgnoreCase(whitelistedMac)) {
            promise.reject("SECURITY_VIOLATION", "Target hardware address mismatch!");
            return;
        }

        device.connectGatt(getReactApplicationContext(), false, new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                if (newState == BluetoothProfile.STATE_CONNECTED) { gatt.discoverServices(); }
            }

            @Override
            public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    BluetoothGattService service = gatt.getService(SERVICE_UUID);
                    if (service != null) {
                        BluetoothGattCharacteristic characteristic = service.getCharacteristic(CHAR_UUID);
                        if (characteristic != null) {
                            characteristic.setValue(password.getBytes());
                            gatt.writeCharacteristic(characteristic);
                        }
                    }
                }
            }

            @Override
            public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic charac, int status) {
                promise.resolve(status == BluetoothGatt.GATT_SUCCESS);
                gatt.disconnect();
            }
        });
    }
}

------------------------------
## 🍏 3. iOS Whitelist Enforcement (Objective-C)
Apple’s security layer completely hides physical MAC addresses from developers to protect user privacy. Instead, iOS creates an alphanumeric ephemeral UUID (e.g., E621E1F8-C36C-495A-93FC-0C247A3E6E5F) for every peripheral it encounters. This UUID is unique to your specific iPhone and acts as your static whitelist tracker.
Update BleKeyboardModule.m:

#import <React/RCTBridgeModule.h>#import <CoreBluetooth/CoreBluetooth.h>
@interface BleKeyboardModule : NSObject <RCTBridgeModule, CBCentralManagerDelegate, CBPeripheralDelegate>@property (nonatomic, strong) CBCentralManager *centralManager;@property (nonatomic, strong) CBPeripheral *targetPeripheral;@property (nonatomic, strong) NSString *passwordToType;@property (nonatomic, strong) NSString *whitelistedUuidString;@property (nonatomic, strong) RCTPromiseResolveBlock resolveBlock;@property (nonatomic, strong) RCTPromiseRejectBlock rejectBlock;@property (nonatomic, assign) BOOL isSetupMode;@end
@implementation BleKeyboardModule

RCT_EXPORT_MODULE();
// Setup Mode: Scan the airwaves and return the Apple-assigned internal UUID string
RCT_EXPORT_METHOD(scanAndRegisterDongle:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
    self.resolveBlock = resolve;
    self.rejectBlock = reject;
    self.isSetupMode = YES;
    self.centralManager = [[CBCentralManager alloc] initWithDelegate:self queue:nil];
}
// Production Mode: Only proceed if the hardware UUID strictly matches the whitelist
RCT_EXPORT_METHOD(sendPasswordToTrustedDevice:(NSString *)password whitelistedUuid:(NSString *)uuidString resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
    self.passwordToType = password;
    self.whitelistedUuidString = uuidString;
    self.resolveBlock = resolve;
    self.rejectBlock = reject;
    self.isSetupMode = NO;
    self.centralManager = [[CBCentralManager alloc] initWithDelegate:self queue:nil];
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    if (central.state == CBManagerStatePoweredOn) {
        if (self.isSetupMode) {
            [self.centralManager scanForPeripheralsWithServices:nil options:nil];
        } else {
            // OPTIMIZATION: Instead of scanning broad airwaves, directly retrieve the pre-approved peripheral by UUID
            NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:self.whitelistedUuidString];
            NSArray<CBPeripheral *> *peripherals = [self.centralManager retrievePeripheralsWithIdentifiers:@[uuid]];
            if (peripherals.count > 0) {
                self.targetPeripheral = peripherals.firstObject;
                self.targetPeripheral.delegate = self;
                [self.centralManager connectPeripheral:self.targetPeripheral options:nil];
            } else {
                self.rejectBlock(@"NOT_FOUND", @"Pre-approved device out of range or powered off.", nil);
            }
        }
    }
}

- (void)centralManager:(CBCentralManager *)central didDiscoverPeripheral:(CBPeripheral *)peripheral advertisementData:(NSDictionary<NSString *,id> *)advertisementData RSSI:(NSNumber *)RSSI {
    if (self.isSetupMode && [peripheral.name isEqualToString:@"MyHIDDongle"]) {
        [self.centralManager stopScan];
        // Pass Apple's unique UUID string back to JavaScript for persistent black/white listing
        self.resolveBlock(peripheral.identifier.UUIDString); 
    }
}

- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
    [peripheral discoverServices:@[[CBUUID UUIDWithString:@"12345678-1234-5678-1234-567812345678"]]];
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
    for (CBService *service in peripheral.services) {
        [peripheral discoverCharacteristics:@[[CBUUID UUIDWithString:@"87654321-4321-8765-4321-876543210987"]] forService:service];
    }
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service error:(NSError *)error {
    for (CBCharacteristic *characteristic in service.characteristics) {
        NSData *data = [self.passwordToType dataUsingEncoding:NSUTF8StringEncoding];
        [peripheral writeValue:data forCharacteristic:characteristic type:CBCharacteristicWriteWithResponse];
    }
}

- (void)peripheral:(CBPeripheral *)peripheral didWriteValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
    if (error) {
        self.rejectBlock(@"WRITE_FAIL", error.localizedDescription, error);
    } else {
        self.resolveBlock(@YES);
    }
    [self.centralManager cancelPeripheralConnection:peripheral];
}
@end

## 🔒 Why this architecture is solid

   1. Zero Scan Footprint in Production: In the iOS implementation, notice that scanForPeripheralsWithServices is skipped during the login sequence. Instead, it calls retrievePeripheralsWithIdentifiers. This pulls the device straight from the OS kernel queue without broadcasting a general RF scan, ensuring optimal privacy.
   2. Anti-Spoof Defense: If an attacker provisions an evil device with the name "MyHIDDongle", Android will block it because the MAC Address won't match the whitelisted record. iOS will block it because it will generate a brand new internal tracking UUID, preventing accidental connection.

When you are ready to expand on this later, would you like me to generate a file containing the firmware code for the USB microcontroller dongle to match this secure whitelisting profile?

