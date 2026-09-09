# A connected Bluetooth keyboard that would not type

**Severity:** medium — the profile was connected, the app said "connecting",
and the control that types was not on screen
**Status:** fixed — the profile's own view is authoritative, and it is polled
**Applies to:** ours — `ok-rn/android/app/src/main/java/com/okrn/btkbd/`,
`ok-rn/src/hooks/useBtKeyboard.ts`

## The measurement

Pairing the Galaxy A13 5G to the Pixel 6a as a keyboard host, then reading both
views of the same link:

| source | said |
|---|---|
| `BluetoothHidDevice.getConnectedDevices()` | Galaxy A13 5G, **connected** |
| the screen's status banner | **connecting** to NITRO16 |
| `HidDeviceService` in logcat | no connection callback at all |

The host list and the banner were rendered from the same screen, at the same
moment, disagreeing.

## What was wrong

`onConnectionStateChanged` was the only thing that set the connected host, in
Kotlin and in JS both. Everything downstream hung off it: `sendReport` refused
without it, and the Typing section - the only way to ask the key to type -
was rendered only when the banner said `connected`.

So a connection the callback did not report was a keyboard that was connected,
paired, and unable to type, with nothing on screen suggesting anything was
wrong. The last state anyone had asked for was "connecting", so it looked like
it was still trying.

## Why the callback is not enough

It is a notification, not the state. It reports transitions that happen while
somebody is listening, and a connection can be made when nobody is:

- a host reconnects on its own schedule - on waking, on being unlocked, on
  being carried back into range - and none of that is prompted by the app;
- `registerApp` can be called over a link that is already up;
- the screen mounts long after the module does.

The profile knows the answer in all three cases. Asking it is one call.

## The fix

`currentHost()` in the module resolves the note first and the profile second,
so a report is sent whenever the profile has somewhere to send it:

```kotlin
private fun currentHost(): BluetoothDevice? =
  host ?: proxy?.connectedDevices?.firstOrNull()?.also { host = it }
```

and the hook stops treating `hosts()` as decoration - a host the profile lists
as connected sets the connected state, and the list is refreshed on a timer
while the keyboard is published rather than only when a callback happens to
arrive.

## Verified after

Slot 1 (`aaaaa`) typed on a tap and slot 1b (`bbbbbbbbbbbbb`) on a hold,
straight into a text field on the Galaxy - `text="aaaaabbbbbbbbbbbbb"` in its
own UI dump, 36 reports sent, and `dumpsys input` listing the Pixel as
`Device 14: bmatusiak` with a US keyboard layout.
