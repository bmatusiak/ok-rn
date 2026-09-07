Connecting a USB Human Interface Device (HID) to an iOS application running React Native relies on building a **custom Native Swift Module** using Apple’s **CoreHID framework**.

Custom HID communication over USB-C or Lightning bypasses Apple's paid MFi requirement, provided the device exposes standard HID descriptors.

---

### Step 1: System Prerequisites & iOS Setup

1. **Deployment Target:** Ensure your iOS deployment target is set to **iOS 16.0+** inside Xcode, as `CoreHID` is supported on modern iOS releases.
2. **Device Hardware:** Use a physical iPhone/iPad with a USB-C port (or a Lightning to USB Camera Adapter). **The iOS Simulator does not route real USB HID endpoints.**
3. **Usage Restrictions:** Ensure your hardware does not use system-reserved usage pages (like standard mouse or keyboard), or iOS will intercept the raw bytes before your app sees them.

---

### Step 2: Implement the Swift Native Module

Because there is no off-the-shelf NPM package for CoreHID in React Native, create a Swift Bridge inside your `/ios` directory.

#### 1. Create `UsbHidModule.swift`

```swift
import Foundation
import CoreHID
import React

@objc(UsbHidModule)
class UsbHidModule: RCTEventEmitter {
  
  private var hidManager: HIDDeviceManager?
  private var activeClient: HIDDeviceClient?

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func supportedEvents() -> [String]! {
    return ["OnHidDataReceived", "OnHidDeviceStatus"]
  }

  // 1. Initialize Device Discovery
  @objc func startDiscovery() {
    Task {
      do {
        // Create matching criteria for your Vendor ID & Product ID
        let criteria = DeviceMatchingCriteria(vendorID: 0x1234, productID: 0x5678)
        
        // Request access / discover device
        let manager = HIDDeviceManager()
        let devices = try await manager.devices(matching: [criteria])
        
        if let device = devices.first {
          self.connectToDevice(device)
        }
      } catch {
        sendEvent(withName: "OnHidDeviceStatus", body: ["status": "Error", "message": error.localizedDescription])
      }
    }
  }

  // 2. Connect & Listen for Input Reports (READ)
  private func connectToDevice(_ device: HIDDevice) {
    Task {
      do {
        let client = try await HIDDeviceClient(device: device)
        self.activeClient = client
        
        sendEvent(withName: "OnHidDeviceStatus", body: ["status": "Connected"])

        // Asynchronously iterate over incoming report streams
        for await update in client.elements {
          if let valueData = update.value.data {
            let byteArray = [UInt8](valueData)
            self.sendEvent(withName: "OnHidDataReceived", body: ["data": byteArray])
          }
        }
      } catch {
        sendEvent(withName: "OnHidDeviceStatus", body: ["status": "Failed to connect"])
      }
    }
  }

  // 3. Send Output Reports (WRITE)
  @objc func sendReport(_ reportId: UInt8, dataArray: [UInt8], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let client = activeClient else {
      reject("ERR_NO_DEVICE", "No active HID device connected", nil)
      return
    }

    Task {
      do {
        let payload = Data(dataArray)
        let reportIDObj = HIDReportID(rawValue: reportId)
        
        // Write raw output report down to the USB chip
        try await client.setReport(id: reportIDObj, type: .output, data: payload)
        resolve(true)
      } catch {
        reject("ERR_WRITE_FAILED", "Failed to write HID report: \(error.localizedDescription)", error)
      }
    }
  }
}

```

#### 2. Create `UsbHidModule.m` (Objective-C Export Glue)

```objc
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(UsbHidModule, RCTEventEmitter)

RCT_EXTERN_METHOD(startDiscovery)
RCT_EXTERN_METHOD(sendReport:(nonnull NSNumber *)reportId 
                  dataArray:(NSArray *)dataArray 
                  resolver:(RCTPromiseResolveBlock)resolve 
                  rejecter:(RCTPromiseRejectBlock)reject)

@end

```

---

### Step 3: Implement in React Native (JavaScript/TypeScript)

Now, map the Native Module into React Native using an `NativeEventEmitter` to process incoming packets asynchronously and Promises to handle outbound writes.

```tsx
import React, { useEffect, useState } from 'react';
import { View, Text, Button, NativeModules, NativeEventEmitter } from 'react-native';

const { UsbHidModule } = NativeModules;
const hidEventEmitter = new NativeEventEmitter(UsbHidModule);

export default function App() {
  const [deviceStatus, setDeviceStatus] = useState<string>('Disconnected');
  const [receivedBytes, setReceivedBytes] = useState<number[]>([]);

  useEffect(() => {
    // Subscriptions for state updates and incoming USB data
    const statusSub = hidEventEmitter.addListener('OnHidDeviceStatus', (evt) => {
      setDeviceStatus(evt.status);
    });

    const dataSub = hidEventEmitter.addListener('OnHidDataReceived', (evt) => {
      console.log('Incoming HID Bytes:', evt.data);
      setReceivedBytes(evt.data);
    });

    // Begin scanning for the USB device
    UsbHidModule.startDiscovery();

    return () => {
      statusSub.remove();
      dataSub.remove();
    };
  }, []);

  // Write USB HID Data
  const sendDataToHardware = async () => {
    try {
      const reportId = 0x01; // Your defined HID Report ID
      const payload = [0xFF, 0x00, 0xAB, 0x12]; // Bytes to transfer
      
      await UsbHidModule.sendReport(reportId, payload);
      console.log('Write Successful');
    } catch (error) {
      console.error('Write failed:', error);
    }
  };

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>USB Status: {deviceStatus}</Text>
      <Text>Last Received Payload: {JSON.stringify(receivedBytes)}</Text>
      <Button title="Send Bytes Over USB" onPress={sendDataToHardware} />
    </View>
  );
}

```

---

### Step 4: Verification Check

1. Run `npx react-native run-ios --device` to deploy to a physical iPhone/iPad.
2. Connect your custom USB HID device using a USB-C cable or adapter.
3. Open Xcode Console / Metro terminal logs:
* **Verification:** Check `OnHidDeviceStatus` emits `"Connected"`.
* **Read Verification:** Verify that triggering a report on the hardware logs `Incoming HID Bytes: [...]` in Metro.
* **Write Verification:** Triggering `sendDataToHardware()` should resolve the Swift `Task` without throwing `ERR_WRITE_FAILED`.