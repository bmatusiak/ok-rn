# A non-spec item in the HID descriptor broke the Bluetooth keyboard

Measured on the bench phone against a Windows 11 host (NITRO16), 2026-09-13.

## What happens

The keyboard publishes fine. `registerApp` succeeds, the screen reaches
`registered`, and Windows discovers the phone and pairs with it. Then every
connection attempt does this:

    ConnectionState: STATE_CONNECTING
    ... a few seconds ...
    ConnectionState: STATE_DISCONNECTED

and the screen reads `disconnected - NITRO16 is not connected`. Tried with a
stale bond and again with a bond made fresh while the app was already
registered, so the host had the HID SDP record in front of it at bond time.
Same result.

Windows lists the phone with a PHONE icon, not a keyboard.

## Why, as far as the phone can say

    $ adb shell getprop | grep class_of_device
    [bluetooth.device.class_of_device]: [90,2,12]

0x5A020C. Major device class = (CoD >> 8) & 0x1F = 2, which is PHONE; minor
= 3, smartphone. A keyboard is major class 5 (peripheral) with the keyboard
minor bit set.

So the SDP record says keyboard and the Class of Device says smartphone, and
Windows believes the CoD - which is what the icon is drawn from, and what it
uses to decide what kind of thing it just paired with. A host that classified
the bond as a phone refuses an incoming HID channel from it.

The app is not doing anything wrong that is visible from here. The SDP settings
are right: `SUBCLASS1_KEYBOARD`, and a standard boot-keyboard report descriptor
(8-byte reports, modifiers + reserved + six keys, LED output report).

## Why it is not fixable in the app

Class of Device is a property of the ADAPTER, not of a profile registration.
`bluetooth.device.class_of_device` is a system property read by the Bluetooth
stack at init and owned by it; `BluetoothAdapter` exposes no setter, and there
is no public Android API for an app to change it. Registering a
`BluetoothHidDevice` app publishes the SDP record and nothing else - the phone
goes on telling the world it is a phone.

## What is NOT the problem

- **The bridge.** Fixed separately, see
  FINDING-the-bluetooth-bridge-died-with-its-screen.md. Not this.
- **Capture.** The app decodes the key's own typing correctly: pressing a slot
  filled "Typed by the key" with `test`, 8 reports, decoded as usa english. The
  inbound half works end to end; only the outbound link is dead.
- **The descriptor or subclass.** Both correct, see above.

## Tested the explainer's flow too

EXPLAINER/android-bluetooth-keyboard.md never calls `connect()`: it registers
the SDP app, makes the phone discoverable, and lets the HOST open the
connection. Worth trying, because our Connect button dials out and the stack
logs from it show A2DP and AVRCP service discovery rather than anything HID -
Android routing it as a generic device connection.

So the phone was put in exactly that state: unregistered, registered clean, no
outbound connect. Windows did not connect in on its own over 30 seconds, which
is expected - a host does not spontaneously dial a paired HID device. Then the
host was told to Connect from Windows' own Bluetooth settings.

Windows reported **"device error"**. On the phone, what actually happened with
the host was:

    btif_av.cc  ProcessEvent: state=Idle peer=xx:xx:xx:xx:db:fb   (A2DP)
    connection_manager.cc  on_connection_complete: Le connection complete
    btif_dm.cc  btif_on_gatt_results: New GATT over LE UUIDs for xx:xx:xx:xx:db:fb
    gap_ble.cc  client_connect_cback: No active GAP service found for peer

A2DP - classic audio - and GATT over LE. In BOTH directions, across every
attempt, there is not one line from `bta_hd`, `hidd`, `HidDeviceService` or any
other HID tag. The HID channel is never opened by anybody.

That is the shape of a host that bonded with a PHONE and is connecting the
profiles a phone has. It finds audio and it finds LE GATT, it does not look for
a keyboard, and it reports an error when nothing it expected is there.

## Where to look next

The connect attempt produces no HID stack logging at all - `bta_hd`, `hidd`,
`HidDeviceService` are all silent - while the same tap does produce A2DP and
AVRCP service discovery against the host. That is worth understanding before
concluding the CoD is the whole story: it suggests the connect is being routed
as a generic device connection rather than a HID one, which would be an Android
behaviour rather than a Windows refusal.

Worth testing against a second host (a Mac, a Linux box, an Android tablet)
before spending more on Windows. If it connects to those, the CoD reading is
confirmed and the answer is that this feature cannot work with Windows from a
stock phone. If it fails everywhere, the cause is on this side after all.


## CORRECTION: the Class of Device was NOT the cause

Everything above was measured from the phone, and from there the CoD reading
looked decisive. It was wrong, and the way it was wrong is worth keeping.

The host is this machine. Asked directly, it says:

    Get-PnpDevice | ? InstanceId -like '*24293486EAAF*'

    OK     Bluetooth  bmatusiak
    OK     Bluetooth  Personal Area Network NAP Service
    OK     MEDIA      bmatusiak A2DP SNK
    Error  HIDClass   Bluetooth HID Device          <-- here
    OK     System     bmatusiak Hands-Free HF
    OK     Bluetooth  bmatusiak Avrcp Transport
    ... and eight more, all OK

    InstanceId : BTHENUM\{00001124-0000-1000-8000-00805F9B34FB}_VID&000100E0_...
    Service    : HidBth
    Problem    : CM_PROB_FAILED_START  -  "This device cannot start. (Code 10)"

`0x1124` is HumanInterfaceDeviceService. Windows READ the HID SDP record, matched
it, created the node and bound Microsoft's own `HidBth` driver to it. It knows
perfectly well that this is a keyboard. The phone icon was the icon and nothing
more.

So the failure is narrower and later than "the host refuses a phone": the host
accepts the keyboard, tries to start it, and the driver fails.

## What that leaves

Windows has the node and will not retry - no new events since the 3:13 pairing,
and a connect from the phone afterwards produced nothing on the host at all.
Meanwhile Android logs zero HID stack activity for any attempt in either
direction. The L2CAP HID channels are never opened by anybody, so `HidBth`
never gets as far as reading a report descriptor - which also rules the
descriptor out, for now.

Next step needs administrator on the host: remove the errored `Bluetooth HID
Device` node (Device Manager, or `pnputil /remove-device`) so it re-enumerates
clean, then reconnect while the app is published. A Code 10 stuck from one bad
enumeration does not fix itself.

## The lesson, which is the one this project keeps relearning

Both diagnoses before this one were built entirely out of what the PHONE could
see, and both were confidently wrong - first the SDP-cache story, then the CoD
story. The host was sitting right here the whole time and could be asked in one
command. Measure the artefact, and when there are two machines, measure both.

## Narrowed: Windows never receives a report descriptor

Two corrections to the run above, both mine.

First, the app WAS published when the host re-paired. I inferred otherwise from
the app having been paused overnight by Extreme Battery Saver, and from the
login screen being up. Wrong on both counts: the pause did not kill the
process - the previous session's decoded text was still on screen - so the
native registration survived it, and registration is not something the login
screen can report. The tap I made to "publish" actually hit "Stop being a
keyboard", and the screen then said `the keyboard is no longer published`,
which is what gave it away. So the clean test - HID app registered BEFORE the
bond - did happen, and Code 10 happened anyway.

Second, the host's own registry says what is missing:

    HKLM\SYSTEM\CurrentControlSet\Enum\BTHENUM\{00001124-...}\...\Device Parameters

    Bluetooth_UniqueID      : {00001124-0000-1000-8000-00805f9b34fb}#24293486EAAF_C00000000
    ConnectionAuthenticated : 1
    ConnectionCount         : 1
    VirtuallyCabled         : 0

Authenticated bond, one connection counted, and NO cached HID report
descriptor - no HIDDescriptor value of any kind. `HidBth` cannot start a
keyboard whose descriptor it does not have, and that is the Code 10.

So this is not a refusal, not the Class of Device, and not a descriptor Windows
parsed and disliked. Windows never got a descriptor.

Candidates, in the order worth testing:

1. **A stale SDP cache on the host.** Windows caches SDP per device address,
   and the FIRST pairing of this address happened before any HID app was
   registered. Removing the device from Bluetooth settings may not clear that
   cache. Testable by pairing the phone with a host that has never seen it.
2. **Android is not putting the descriptor in the record.** Testable the same
   way, and distinguishable from (1) by the result: fails everywhere = ours.
3. The descriptor itself. Least likely now - a rejected descriptor would have
   been received first, and nothing was.

## Extreme Battery Saver tears the keyboard down

Worth its own line because it is not a bug and will still bite: with Extreme
Battery Saver on, Android paused OkRN overnight. A paused app eventually loses
the HID registration with the process, and the keyboard silently stops being a
keyboard. Exclude the app from battery optimisation before any long test.


## SOLVED

The host says it in one property, and nothing else ever did:

    Get-PnpDeviceProperty -InstanceId <hid node> -KeyName DEVPKEY_Device_DriverProblemDesc

    "The HID Report Descriptor failed validation.
     An unknown item was found in the descriptor."
    ProblemStatus 0xC000001D, ProblemCode 10

The offending item was ours. The reserved byte of the report was declared
with a usage on it, copied from Apple's descriptor:

    95 01 75 08  05 0C 09 B8  81 01     Usage Page (Consumer), Usage (Eject), Input (Const)

The HID spec's boot keyboard (Appendix B.1) has nothing there but the
constant:

    95 01 75 08              81 01

Windows' hidparse validates the descriptor BEFORE HidBth starts. It rejected
the whole thing, the driver never started, so it never opened the HID L2CAP
channels - which is why the phone saw an ACL come up, no HID connection, and
a hangup three seconds later, and why `bta_hd` logged nothing at all. Every
symptom was downstream of one decorative item.

Removed it. Rebuilt. Re-paired so Windows would re-read SDP - it caches the
record per address, so nothing changes until the bond is remade - and:

    Status : OK
    Problem: CM_PROB_NONE                      (host)
    ConnectionState: STATE_CONNECTED           (phone)

    "hello from onlykey"  ->  36 reports sent

18 characters, one press report and one release each. It typed into the host.

## What this cost, and why

Four confident wrong answers before the right one: a stale SDP cache, the
Class of Device, "Windows never received a descriptor", and a mutual-deadlock
story where each side waited for the other. Every one of them was built out of
what the PHONE could see.

The host was this machine the whole time. `Get-PnpDevice`,
`DEVPKEY_Device_DriverProblemDesc`, and Windows' own cached SDP record under
`BTHPORT\Parameters\Devices` answered in three commands what hours of adb
logcat could not - including proving the SDP record was byte-perfect, which
killed two of the wrong theories at once.

When a problem spans two machines, instrument both before theorising about
either. A one-sided measurement will always support a story; it just will not
be the true one.
