Architecting a React Native application that communicates with physical **USB Human Interface Devices (HID)** on iOS requires balancing two realities:

1. **Production:** iOS physical hardware communicates with USB HID devices using Apple's native `CoreHID` framework (available on iOS 16+).
2. **Development:** Xcode’s iOS Simulator runs on macOS, which intercepts raw USB HID endpoints. The Simulator **cannot passthrough real USB hardware**.

To develop and test your React Native UI, state management, and business logic without needing physical hardware attached at all times, the optimal architecture uses a **Dual-Path Native Bridge with a TCP-backed Hardware Emulator**.

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
          #if targetEnvironment(simulator)                          #else
                      │                                                 │
                      v                                                 v
        ┌───────────────────────────┐                     ┌───────────────────────────┐
        │    TCP Socket Client      │                     │     CoreHID Client        │
        │      (NWConnection)       │                     │    (Physical Hardware)    │
        └─────────────┬─────────────┘                     └─────────────┬─────────────┘
                      │                                                 │
                 Local Network                                     USB-C / Lightning
                      │                                                 │
                      v                                                 v
        ┌───────────────────────────┐                     ┌───────────────────────────┐
        │   Mac Hardware Emulator   │                     │   Physical USB Device     │
        │       (Node.js TCP)       │                     │    (Microcontroller)      │
        └───────────────────────────┘                     └───────────────────────────┘

```

By decoupling the transport layer inside Swift using compile-time directives (`#if targetEnvironment(simulator)`), your React Native JavaScript layer remains completely agnostic. It emits commands and listens for byte events identically in both environments.

---

### Step 1: Create the Mac Hardware Emulator (Node.js)

Create a Node.js TCP server script on your Mac to simulate your physical hardware device. This script receives outbound reports from the simulator and periodically pushes inbound byte arrays to emulate hardware state changes.

Create `hardware-emulator.js`:

```javascript
const net = require('net');

const PORT = 9000;
const HOST = '127.0.0.1';

const server = net.createServer((socket) => {
  console.log('📱 iOS Simulator connected to TCP Hardware Emulator!');

  // 1. Periodically emit simulated input reports (e.g., sensor data/button presses)
  const timer = setInterval(() => {
    // Format: [ReportID, DataByte1, DataByte2, DataByte3]
    const mockReport = Buffer.from([0x01, Math.floor(Math.random() * 255), 0xAA, 0x55]);
    console.log('➡️ [Hardware Out -> iOS In]:', Array.from(mockReport));
    socket.write(mockReport);
  }, 2500);

  // 2. Listen for commands sent from the iOS React Native app
  socket.on('data', (data) => {
    const bytes = Array.from(data);
    console.log('⬅️ [iOS Out -> Hardware In]:', bytes);

    // Example state logic: If JS sends command [0x01, 0xFF], send an immediate ACK response
    if (bytes[0] === 0x01 && bytes[1] === 0xFF) {
      console.log('⚡ ACK command received! Replying...');
      socket.write(Buffer.from([0x01, 0x00, 0x00, 0x00]));
    }
  });

  socket.on('close', () => {
    console.log('📱 Simulator disconnected.');
    clearInterval(timer);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Hardware Emulator running on ${HOST}:${PORT}`);
  console.log('Ready for iOS Simulator connections...\n');
});

```

To run the server:

```bash
node hardware-emulator.js

```

---

### Step 2: Implement the Swift Native Module (iOS Bridge)

Create the Swift implementation inside your iOS project (`/ios/UsbHidModule.swift`). This module uses `NWConnection` (Network framework) for TCP in the Simulator and `CoreHID` for physical devices.

```swift
import Foundation
import CoreHID
import Network
import React

@objc(UsbHidModule)
class UsbHidModule: RCTEventEmitter {

  // TCP Properties (Simulator)
  private var tcpConnection: NWConnection?
  
  // CoreHID Properties (Physical Device)
  private var activeClient: HIDDeviceClient?

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func supportedEvents() -> [String]! {
    return ["OnHidDataReceived", "OnHidDeviceStatus"]
  }

  // MARK: - Device Discovery / Connection
  @objc func startDiscovery() {
    #if targetEnvironment(simulator)
    connectToTcpEmulator(host: "127.0.0.1", port: 9000)
    #else
    startCoreHidDiscovery()
    #endif
  }

  // MARK: - Simulator Path (TCP Socket)
  private func connectToTcpEmulator(host: String, port: UInt16) {
    let hostEndpoint = NWEndpoint.Host(host)
    let portEndpoint = NWEndpoint.Port(rawValue: port)!
    
    tcpConnection = NWConnection(host: hostEndpoint, port: portEndpoint, using: .tcp)

    tcpConnection?.stateUpdateHandler = { [weak self] state in
      guard let self = self else { return }
      switch state {
      case .ready:
        self.sendEvent(withName: "OnHidDeviceStatus", body: ["status": "Connected (TCP Mock)"])
        self.listenTcpStream()
      case .failed(let error):
        self.sendEvent(withName: "OnHidDeviceStatus", body: ["status": "TCP Connection Error: \(error.localizedDescription)"])
      case .cancelled:
        self.sendEvent(withName: "OnHidDeviceStatus", body: ["status": "Disconnected"])
      default:
        break
      }
    }

    tcpConnection?.start(queue: .global())
  }

  private func listenTcpStream() {
    // Read packet buffers (up to 64-byte HID standard reports)
    tcpConnection?.receive(minimumIncompleteLength: 1, maximumLength: 64) { [weak self] data, _, isComplete, error in
      guard let self = self else { return }

      if let data = data, !data.isEmpty {
        let byteArray = [UInt8](data)
        self.sendEvent(withName: "OnHidDataReceived", body: ["data": byteArray])
      }

      if isComplete || error != nil {
        self.sendEvent(withName: "OnHidDeviceStatus", body: ["status": "Disconnected"])
      } else {
        // Continue looping loop to read next stream chunk
        self.listenTcpStream()
      }
    }
  }

  // MARK: - Physical Device Path (CoreHID)
  private func startCoreHidDiscovery() {
    Task {
      do {
        // Customize matching criteria to match your hardware vendor and product IDs
        let criteria = DeviceMatchingCriteria(vendorID: 0x1234, productID: 0x5678)
        let manager = HIDDeviceManager()
        let devices = try await manager.devices(matching: [criteria])
        
        if let device = devices.first {
          let client = try await HIDDeviceClient(device: device)
          self.activeClient = client
          self.sendEvent(withName: "OnHidDeviceStatus", body: ["status": "Connected"])

          // Consume input report updates
          for await update in client.elements {
            if let valueData = update.value.data {
              let byteArray = [UInt8](valueData)
              self.sendEvent(withName: "OnHidDataReceived", body: ["data": byteArray])
            }
          }
        }
      } catch {
        self.sendEvent(withName: "OnHidDeviceStatus", body: ["status": "CoreHID Error: \(error.localizedDescription)"])
      }
    }
  }

  // MARK: - Unified Write Interface
  @objc func sendReport(_ reportId: UInt8, dataArray: [UInt8], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if targetEnvironment(simulator)
    // SIMULATOR WRITE
    guard let connection = tcpConnection else {
      reject("ERR_NOT_CONNECTED", "TCP Mock server is not connected", nil)
      return
    }

    let payload = Data([reportId] + dataArray)
    connection.send(content: payload, completion: .contentProcessed({ error in
      if let error = error {
        reject("ERR_WRITE_FAILED", "TCP Write Failed: \(error.localizedDescription)", error)
      } else {
        resolve(true)
      }
    }))
    #else
    // PHYSICAL DEVICE WRITE
    guard let client = activeClient else {
      reject("ERR_NOT_CONNECTED", "No physical HID device connected", nil)
      return
    }

    Task {
      do {
        let payload = Data(dataArray)
        let reportIDObj = HIDReportID(rawValue: reportId)
        try await client.setReport(id: reportIDObj, type: .output, data: payload)
        resolve(true)
      } catch {
        reject("ERR_WRITE_FAILED", "CoreHID Write Failed: \(error.localizedDescription)", error)
      }
    }
    #endif
  }
}

```

Export the Objective-C glue in `/ios/UsbHidModule.m`:

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

### Step 3: Implement in React Native (TypeScript)

Build a clean application component that manages UI state and communicates with the native module.

```tsx
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Button, FlatList } from 'react-native';
import { NativeModules, NativeEventEmitter } from 'react-native';

const { UsbHidModule } = NativeModules;
const hidEventEmitter = new NativeEventEmitter(UsbHidModule);

export default function App() {
  const [status, setStatus] = useState<string>('Disconnected');
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    // 1. Listen for connection status changes
    const statusSub = hidEventEmitter.addListener('OnHidDeviceStatus', (evt) => {
      setStatus(evt.status);
      addLog(`Status: ${evt.status}`);
    });

    // 2. Listen for incoming raw bytes from hardware (or TCP mock)
    const dataSub = hidEventEmitter.addListener('OnHidDataReceived', (evt) => {
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
      <Text style={styles.title}>USB HID Interface</Text>
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
  logItem: { color: '#30D158', fontFamily: 'Courier', fontSize: 12, marginBottom: 4 }
});

```

---

### Step 4: Verification and Testing Workflow

1. **Start the Mock Server:** Open a terminal on your Mac and run `node hardware-emulator.js`.
2. **Launch in Simulator:** Run `npx react-native run-ios` (or press Run in Xcode targeting any iOS Simulator).
3. **Verify TCP Data Flow:**
* Watch the Node.js terminal log: `📱 iOS Simulator connected to TCP Hardware Emulator!`.
* Watch your React Native UI output incoming bytes emitted by the timer every 2.5 seconds.
* Tap **Send HID Report** in the app UI and verify the Node.js console logs the incoming write array `⬅️ [iOS Out -> Hardware In]: [1, 255, 0, 1]`.


4. **Deploy to Physical iPhone:** Connect a physical iPhone running iOS 16+ via USB and target it in Xcode. Compile and run. Xcode automatically uses the `#else` block (`CoreHID`), bypassing the TCP socket and connecting directly to the physical USB port.