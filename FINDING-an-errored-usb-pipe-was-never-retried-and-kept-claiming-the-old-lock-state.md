# An errored USB pipe was never retried, and went on claiming the old lock state

**Found** 2026-09-17 on the bench Pixel 6a, freshly factory reset and updated
from Android 16 to **Android 17**, with a hard key behind a powered hub.
Reported as "I have the key unlocked now, but the app thinks it's locked", and
"it still acted up until I restarted the app".

## What was actually wrong

Two faults, one line apart, and neither was in the key.

**1. `error` was a dead end.** `useKey.ts` re-opened the pipe only from
`'stopped'`:

    if (hardState === 'stopped' && !hardBusy && !UsbPipe.isRunning()) {

with a comment explaining that an `'error'` is deliberately not retried in a
loop. Not looping was right; never asking again was not. One failed open
stranded the app until it was relaunched — while the key sat plugged in and the
bus reported it perfectly.

**2. `error` kept everything it knew.** `useHardKey.ts` reset `device`,
`identity`, `capabilities` and the console answers on `'disconnected'`, but on
`'error'` it only set the state. So the app kept displaying the last lock state
it had seen, for a pipe it could no longer read.

Together: replug → pipe dies → re-open errors once → never retried → the screen
goes on saying **"Locked"**, with a PIN prompt, for a key the owner has since
unlocked. The key was right. The app was stale.

## What the bus actually said

Worth recording, because every layer below the app was healthy and it took a
while to believe that:

    dumpsys usb → host_manager.devices:
      name=/dev/bus/usb/001/003  vendor_id=7504  product_id=24828  product_name=ONLYKEY

`7504`/`24828` is `0x1d50`/`0x60fc`, matching `res/xml/device_filter.xml`
exactly, and `permissions_manager` already listed that node granted to the
app's uid. A manual Connect opened all four interfaces first try — keyboard,
fido, vendor, seremu — and the vendor interface immediately carried the 1 Hz
state broadcast.

Nothing was wrong except that nobody asked twice.

## The fix

- `useHardKey.ts`: `'error'` now clears `device`/`identity`/`capabilities` the
  same way `'disconnected'` does. An errored pipe knows nothing.
- `useKey.ts`: a separate effect retries from `'error'` with backoff — 2s, 4s,
  8s, capped at 30s — and only while a matching key is on the bus. The counter
  resets once the pipe runs.

## Two traps for whoever reads this next

**`doctor.js` says `onlykey attached (host mode)` from the USB EVENT LOG**,
which is history. It said "attached" throughout, and it was not evidence the
device was on the bus. `dumpsys usb → host_manager.devices` is the current
list. (See also FINDING-doctor-said-attached-for-a-key-that-was-not-on-the-bus.)

**A replug does NOT necessarily re-lock the key**, so do not reach for that as
the explanation. It was assumed during diagnosis that pulling the key
power-cycles it and it returns locked, and on this bench that was WRONG: the key
sits in a powered hub, the hub was what got cycled, and the key never lost
power. The recovery log reads

    usb connected: vid=0x1d50 pid=0x60fc, keyboard=0, fido=1, vendor=2, seremu=3
    OKCONNECT ok: "UNLOCKEDv3.0.4-testc"

straight after a detach/attach. Assuming otherwise sent the diagnosis sideways
and briefly talked the owner out of something they had reported correctly. Ask
the vendor interface instead: `49 4e 49 54 49 41 4c 49 5a 45 44` is
INITIALIZED, meaning provisioned and locked, and an UNLOCKED broadcast carries
the version with it.

## Verified fixed

Measured the same day, key behind the powered hub, hub cycled:

    10:11:46  usb error: <all four endpoints> stopped answering
    10:11:46  usb disconnected: device detached
    10:11:50  device attached
    10:11:54  usb connecting: opening usb device
    10:11:54  usb connected: vid=0x1d50 pid=0x60fc, keyboard=0, fido=1, vendor=2, seremu=3
    10:11:54  OKCONNECT ok: "UNLOCKEDv3.0.4-testc"

Eight seconds, unattended. Before the fix this needed an app relaunch.
