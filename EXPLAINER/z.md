# Technical Feasibility & Architecture Proposal: Software-Defined FIDO2 Authenticator on Android (React Native)

## Executive Summary

This proposal outlines the technical architecture, security model, and implementation strategy for transforming a standard Android smartphone into a roaming **FIDO2 / WebAuthn Hardware Security Key** using **React Native** and **Android Native Subsystems**.

By leveraging Bluetooth Low Energy (BLE) Peripheral advertising, the Client-to-Authenticator Protocol (CTAP2), and Android’s Hardware-Backed KeyStore, an Android device can securely store cryptographic credentials and perform passwordless authentications for nearby desktop operating systems (Windows, macOS, Linux, ChromeOS) without extra hardware.

---

## Technical Architecture Overview

Modern desktop operating systems do not communicate with Bluetooth FIDO2 authenticators via standard Human Interface Device (HID) keyboard drivers. Instead, they interact via **CTAP2 over Bluetooth Low Energy (BLE) GATT Services**.

The solution uses a hybrid architecture: React Native manages the user interface and high-level workflow, while Kotlin Native Modules handle low-level BLE communication and Android KeyStore interactions.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DESKTOP HOST (PC / Mac)                         │
│  ┌────────────────────────┐         ┌──────────────────────────────┐   │
│  │ Web Browser / WebAuthn │ ──────> │  Operating System BLE Stack  │   │
│  └────────────────────────┘         └──────────────┬───────────────┘   │
└────────────────────────────────────────────────────│───────────────────┘
                                                     │
                                       CTAP2 / BLE   │ (Service: 0xFFFD)
                                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      ANDROID DEVICE (React Native)                     │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    NATIVE LAYER (Kotlin / C++)                   │  │
│  │                                                                  │  │
│  │  ┌───────────────────────────┐     ┌──────────────────────────┐  │  │
│  │  │   BLE GATT Server Engine  │     │   CTAP2 Protocol Engine  │  │  │
│  │  │ (Advertiser & MTU Buffer) │ ──> │ (CBOR Parser / Framer)   │  │  │
│  │  └───────────────────────────┘     └────────────┬─────────────┘  │  │
│  └─────────────────────────────────────────────────│────────────────┘  │
│                                                    │                   │
│  ┌─────────────────────────────────────────────────│────────────────┐  │
│  │                  APPLICATION & SECURITY LAYER                   │  │
│  │                                                 ▼                   │  │
│  │  ┌──────────────────────────┐      ┌──────────────────────────┐  │  │
│  │  │   React Native UI / State│ <──> │ Hardware KeyStore / TEE  │  │  │
│  │  │  (Biometric Approvals)   │      │ (ECC P-256 Key Pair)     │  │  │
│  │  └──────────────────────────┘      └──────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘

```

---

## Core System Components

### 1. BLE GATT Peripheral Interface

Android's `react-native-ble-plx` library operates primarily in BLE Central mode (scanning). This solution requires a custom **Kotlin Native Module** operating in **GATT Peripheral Mode**:

* **Service UUID:** Advertises the standardized FIDO Service 16-bit UUID (`0xFFFD`).
* **Characteristics:** Exposes the mandatory FIDO BLE endpoints:
* `FIDO Control Point` (Write): Receives raw CTAP commands from the desktop host.
* `FIDO Status` (Notify/Indicate): Returns framed CTAP responses back to the host.
* `FIDO Control Point Length` (Read): Negotiates maximum payload capacity (MTU).


* **Fragmentation & Framing:** Handles raw BLE packet chunking (`CMD` / `SEQ` frame structure) to pass multi-byte payloads reliably over BLE MTU boundaries.

### 2. Cryptographic & Security Subsystem

Private keys are never held in raw application memory or JS state.

* **Key Generation:** Elliptic Curve P-256 (`secp256r1`) key pairs are generated inside the **Android KeyStore** using the device's **Trusted Execution Environment (TEE)** or **StrongBox Keymaster**.
* **User Verification (UV):** The KeyStore configuration enforces hardware-level biometric checks (`setUserAuthenticationRequired(true)`).
* **Challenge Signing:** When a desktop triggers an `authenticatorGetAssertion` request, the app prompts for biometric verification (Fingerprint / Face). Once validated, the enclave signs the WebAuthn challenge payload directly in isolated hardware.

### 3. Protocol Parsing Engine

* **Format:** Processes binary CBOR (Concise Binary Object Representation) payloads.
* **Commands:** Responds to standard CTAP2 commands including `authenticatorMakeCredential` (registration) and `authenticatorGetAssertion` (authentication).
* **Execution:** Can run in C++ via TurboModules or natively in Kotlin for high-throughput processing.

---

## Security & Compliance Considerations

| Aspect | Specification | Solution / Safeguard |
| --- | --- | --- |
| **Key Storage** | Hardware Isolation | Private keys never leave the Android TEE/StrongBox hardware module. |
| **User Presence** | Biometric / PIN Gate | Mandatory prompt via Android `BiometricPrompt` before signing assertions. |
| **Attestation** | Certificate Validation | Hardware-backed key attestations prove key generation inside a verified enclave. |
| **Background Execution** | Process Persistence | Utilizes an Android Foreground Service with ongoing notification to prevent OS throttling during active sessions. |

---

## Development Roadmap

```
Phase 1: Native BLE Peripheral Module
  ├── Kotlin module for GATT Server creation
  ├── UUID Advertising (0xFFFD)
  └── MTU Negotiation & CTAP Packet Chunking Logic

Phase 2: Protocol Engine Integration
  ├── Bridge incoming/outgoing byte buffers to CTAP2 Parser
  └── Implement Command Handlers (MakeCredential / GetAssertion)

Phase 3: Hardware KeyStore & Biometrics Integration
  ├── Key Generation via Android KeyStore (ECC P-256)
  └── Wire BiometricPrompt directly to KeyStore Signing Operations

Phase 4: React Native UI & State Layer
  ├── Session Dashboard & Device Pairing Views
  └── Real-time Authentication Approval Modal

```

---

## Conclusion

Building a software-based FIDO2 authenticator on Android is fully viable by bridging custom **Kotlin BLE Peripheral drivers** with **Android's Hardware KeyStore**. This architecture turns any Android device running a React Native app into a secure, mobile passwordless security key.