# Publishing a Bluetooth keyboard does not make it reachable

**Severity:** medium — the feature registers, reports "registered", and cannot
be paired with; nothing says why
**Status:** handled — the app asks for discoverability and states the
re-pairing requirement
**Applies to:** Android / Bluetooth Classic HID. Not a defect in the firmware
or in this app; a platform shape that is easy to build a dead feature on top of.

## What was expected

`BluetoothHidDevice.registerApp()` succeeds, `onAppStatusChanged` fires with
`isRegistered = true`, and the phone is a keyboard. That much is true, and it
is where an implementation naturally stops.

## What is actually needed

**1. Registering does not make the phone discoverable.**

It makes the phone *answer*. A host that has never seen it cannot add it,
because Android is not discoverable by default and nothing about publishing a
HID profile changes that. `ScanMode` stays `SCAN_MODE_CONNECTABLE` until
something asks for `ACTION_REQUEST_DISCOVERABLE`, which shows the system's own
consent dialog — an app cannot set it.

Measured on a Pixel 6a: after `register()` succeeded and the UI read
`registered`, `dumpsys bluetooth_manager` still reported
`SCAN_MODE_CONNECTABLE`. After the request was allowed it read
`SCAN_MODE_CONNECTABLE_DISCOVERABLE`.

**2. An existing bond does not carry the keyboard.**

A host already paired with the phone — as a phone, over OBEX or audio — will
refuse an incoming HID connection, because it never agreed to accept this
device as an input device. It fails at L2CAP configuration, not at the
application layer, so there is nothing to catch:

```
hidd_on_l2cap_error: connection of config failed, now disconnect
hidd_l2cif_disconnect: Unable to disconnect L2CAP cid:82
HidDeviceService: Connection state is unchanged, ignoring
```

and the profile simply reports `STATE_DISCONNECTED`. The fix is on the host:
remove the old pairing, then add the phone again so the bond is created for a
keyboard.

**3. The name the host shows is not the SDP name.**

`BluetoothHidDeviceAppSdpSettings` takes a name — "OnlyKey" here — and it goes
in the service record, which a host does not put in its device list. What it
lists is the ADAPTER name, whatever the phone is called in its own Bluetooth
settings. Telling the user to look for "OnlyKey" sends them hunting for
something that will not be on screen; this phone appears as `bmatusiak`.

## Why it is worth writing down

All three fail in the same direction. The profile registers, the state reads
`registered`, no call returns an error, and nothing can connect — the same
shape as the firmware's silent refusals catalogued elsewhere in this file. A
"working" Bluetooth keyboard that no computer can find looks identical to one
nobody has tried to pair with yet.

## What the app does about it

`requestDiscoverable(seconds)` alongside `register()`, the adapter's real name
shown in the pairing instructions via `localName()`, and the re-pairing
requirement stated on the screen rather than left to be discovered.
