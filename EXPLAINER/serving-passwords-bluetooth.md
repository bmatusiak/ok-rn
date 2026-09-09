To achieve this without using external npm packages (like react-native-ble-plx), you have to bypass JavaScript libraries and write a custom React Native Native Module.
By doing this, you communicate directly with iOS's CoreBluetooth framework and Android's native BluetoothAdapter framework using Java/Kotlin and Objective-C/Swift.
Here is how you bridge vanilla React Native code to native platform BLE APIs to send your passwords to the hardware dongle.
------------------------------
## ⚛️ 1. The React Native JavaScript Interface
Since you are not using third-party dependencies, you will expose a custom native module named BleKeyboardModule.

import { NativeModules, Button, View, TextInput, Alert } from 'react-native';const { BleKeyboardModule } = NativeModules;
export default function App() {
  const [password, setPassword] = React.useState('');

  const handleTransmit = () => {
    // Invoke the zero-dependency native implementation directly
    BleKeyboardModule.sendPassword(password)
      .then(() => {
        setPassword('');
        Alert.alert("Success", "Sent over raw native BLE!");
      })
      .catch((err) => Alert.alert("Error", err.message));
  };

  return (
    <View style={{ padding: 50 }}>
      <TextInput secureTextEntry value={password} onChangeText={setPassword} placeholder="Password" />
      <Button title="Transmit Securely" onPress={handleTransmit} disabled={!password} />
    </View>
  );
}

------------------------------
## 🤖 2. Android Zero-Dependency Implementation (Java)
On Android, you use the standard Android SDK Bluetooth APIs. You will create two files inside your android/app/src/main/java/com/yourprojectname/ folder.
## BleKeyboardModule.java

package com.yourprojectname;
import android.bluetooth.BluetoothAdapter;import android.bluetooth.BluetoothDevice;import android.bluetooth.BluetoothGatt;import android.bluetooth.BluetoothGattCallback;import android.bluetooth.BluetoothGattCharacteristic;import android.bluetooth.BluetoothGattService;import android.bluetooth.BluetoothProfile;import com.facebook.react.bridge.ReactApplicationContext;import com.facebook.react.bridge.ReactContextBaseJavaModule;import com.facebook.react.bridge.ReactMethod;import com.facebook.react.bridge.Promise;import java.util.UUID;
public class BleKeyboardModule extends ReactContextBaseJavaModule {
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothGatt bluetoothGatt;
    private final UUID SERVICE_UUID = UUID.fromString("12345678-1234-5678-1234-567812345678");
    private final UUID CHAR_UUID = UUID.fromString("87654321-4321-8765-4321-876543210987");

    public BleKeyboardModule(ReactApplicationContext reactContext) {
        super(reactContext);
        bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
    }

    @Override
    public String getName() {
        return "BleKeyboardModule";
    }

    @ReactMethod
    public void sendPassword(final String password, final Promise promise) {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            promise.reject("BLE_ERROR", "Bluetooth disabled or unavailable");
            return;
        }

        // Hardcoded or dynamically scanned dongle address. 
        // For simplicity, replacing with a dummy example MAC address:
        BluetoothDevice device = bluetoothAdapter.getRemoteDevice("AA:BB:CC:DD:EE:FF");

        bluetoothGatt = device.connectGatt(getReactApplicationContext(), false, new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    gatt.discoverServices();
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    promise.reject("BLE_DISCONNECT", "Disconnected from dongle");
                }
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
            public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    promise.resolve(true);
                    gatt.disconnect();
                } else {
                    promise.reject("WRITE_FAIL", "Failed payload injection");
                }
            }
        });
    }
}

## BleKeyboardPackage.java (Registers the Module)

package com.yourprojectname;import com.facebook.react.ReactPackage;import com.facebook.react.bridge.NativeModule;import com.facebook.react.bridge.ReactApplicationContext;import com.facebook.react.uimanager.ViewManager;import java.util.ArrayList;import java.util.Collections;import java.util.List;
public class BleKeyboardPackage implements ReactPackage {
    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
        return Collections.emptyList();
    }
    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
        List<NativeModule> modules = new ArrayList<>();
        modules.add(new BleKeyboardModule(reactContext));
        return modules;
    }
}

(Make sure to add packages.add(new BleKeyboardPackage()); into your MainApplication.java or MainActivity.kt setup).
------------------------------
## 🍏 3. iOS Zero-Dependency Implementation (Objective-C)
On iOS, you leverage Apple's built-in CoreBluetooth framework. Create a file named BleKeyboardModule.m inside your Xcode workspace project folder.
## BleKeyboardModule.m

#import <React/RCTBridgeModule.h>#import <CoreBluetooth/CoreBluetooth.h>
@interface BleKeyboardModule : NSObject <RCTBridgeModule, CBCentralManagerDelegate, CBPeripheralDelegate>@property (nonatomic, strong) CBCentralManager *centralManager;@property (nonatomic, strong) CBPeripheral *targetPeripheral;@property (nonatomic, strong) NSString *passwordToType;@property (nonatomic, strong) RCTPromiseResolveBlock resolveBlock;@property (nonatomic, strong) RCTPromiseRejectBlock rejectBlock;@end
@implementation BleKeyboardModule

RCT_EXPORT_MODULE();

RCT_EXPORT_METHOD(sendPassword:(NSString *)password resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
    self.passwordToType = password;
    self.resolveBlock = resolve;
    self.rejectBlock = reject;
    
    // Fire up Apple's native Central Manager without dependencies
    self.centralManager = [[CBCentralManager alloc] initWithDelegate:self queue:nil];
}
// Check Bluetooth hardware state
- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    if (central.state == CBManagerStatePoweredOn) {
        [self.centralManager scanForPeripheralsWithServices:@[[CBUUID UUIDWithString:@"12345678-1234-5678-1234-567812345678"]] options:nil];
    } else {
        self.rejectBlock(@"BLE_OFF", @"Bluetooth is turned off", nil);
    }
}
// Found the Dongle
- (void)centralManager:(CBCentralManager *)central didDiscoverPeripheral:(CBPeripheral *)peripheral advertisementData:(NSDictionary<NSString *,id> *)advertisementData RSSI:(NSNumber *)RSSI {
    [self.centralManager stopScan];
    self.targetPeripheral = peripheral;
    self.targetPeripheral.delegate = self;
    [self.centralManager connectPeripheral:peripheral options:nil];
}
// Connected to Dongle
- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
    [peripheral discoverServices:@[[CBUUID UUIDWithString:@"12345678-1234-5678-1234-567812345678"]]];
}
// Found Services
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
    for (CBService *service in peripheral.services) {
        [peripheral discoverCharacteristics:@[[CBUUID UUIDWithString:@"87654321-4321-8765-4321-876543210987"]] forService:service];
    }
}
// Found Characteristics -> Write Password
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service error:(NSError *)error {
    for (CBCharacteristic *characteristic in service.characteristics) {
        NSData *data = [self.passwordToType dataUsingEncoding:NSUTF8StringEncoding];
        // Send data directly to hardware 
        [peripheral writeValue:data forCharacteristic:characteristic type:CBCharacteristicWriteWithResponse];
    }
}
// Done!
- (void)peripheral:(CBPeripheral *)peripheral didWriteValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
    if (error) {
        self.rejectBlock(@"WRITE_FAIL", error.localizedDescription, error);
    } else {
        self.resolveBlock(@YES);
    }
    [self.centralManager cancelPeripheralConnection:peripheral];
}
@end

## 📋 Required OS Configurations
Even without dependencies, the mobile operating systems require permission settings to compile and run:

* Android (AndroidManifest.xml): You must include <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" /> and <uses-permission android:name="android.permission.BLUETOOTH_SCAN" />.
* iOS (Info.plist): You must add the key NSBluetoothAlwaysUsageDescription with a user-facing string explaining why the app handles hardware transmissions.

Would you like me to walk through how the hardware microcontroller code changes if you want to optimize it for handling raw chunks of text instead of character-by-character iterations?

