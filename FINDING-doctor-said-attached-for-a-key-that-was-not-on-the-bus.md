# FINDING: doctor said "attached (host mode)" for a key whose last USB event was a disconnect

**Measured:** 2026-09-11, bench phone (Samsung, `R5CW31M0WCB`), full e2e run
started at 02:05 with `node tools/doctor.js` printed first.

## What was seen

    onlykey     attached (host mode)          ← doctor, at the start of the run
    ...
    suite: hardKey
    usb devices visible: 0                    ← the suite, 9 minutes later
    ○ a real key is attached, or there is nothing to measure -> no OnlyKey on the USB bus
    ✗ every interface is identified BY ITS USAGE PAGE, not by luck -> Error: no key was found

Seven hard-key tests failed for want of a key that a tool had just called
attached. The This Key tab had been saying "no hard key attached" since the
01:26 relaunch, which nobody read as a contradiction because doctor said
otherwise.

## Why

`dumpsys usb` has two places the word ONLYKEY appears, and doctor read the
wrong one.

- `host_manager={ connections=[ … ] }` is a **history**: one entry per USB
  event, `mode=0` for a connect (with `manufacturer=7504 product=24828` for
  the key) and `mode=-1` for a disconnect, by device address, oldest first.
  The tail of it on the bench read: address `001/017` connected, then
  `001/017`, `001/015`, `001/016`, `001/014` all disconnected in the same
  second - the OTG hub and everything on it went away together.
- `settings_manager={ … }` keeps the **permission filter** of every device
  the user ever granted: `product_name=ONLYKEY`, `serial_number=1000000000`,
  forever, whether or not it is plugged in.

`onlykeyRow()` sliced the output from `host_manager` to the END and tested
`/product_name=ONLYKEY|vendor_id=7504|1d50/` on that, which always finds the
permission record. It had never said "not on the bus" for a key that had
once been granted.

`device_manager.host_connected=false` in the same dump was the other tell:
the phone was not acting as a USB host at all.

## Fix

`tools/doctor.js` now replays the connection history: a map of address →
"is this the key", set on `mode=0` and deleted on `mode=-1`, and "attached"
means an address that is still up belongs to vendor 7504. The section is
bounded at `port_manager=` so the permission record is never in it.

## What it does not fix

The key IS off the bus. Android's last word on it is a disconnect of the
whole hub, and nothing in software re-enumerates a USB device the phone no
longer sees - it needs to be unplugged and plugged back in at the phone.
Until that happens every hard-key suite skips or fails honestly, and the
73 that passed in the same run are the soft key's.

## Correction, later the same day

The key was never off the bus. It was in the OTHER phone.

Two phones were on adb from 01:26: a Samsung (`R5CW31M0WCB`, USB and
wireless) and a Pixel 6a (`bluejay`, wireless). Every hard-key run that
passed earlier had used the only phone adb listed - the Pixel - and when the
second one appeared, every tool got pinned to the Samsung by serial on the
assumption that the USB-attached phone was the bench phone. It was not. The
Samsung's `dumpsys usb` history, read as "the hub dropped at 01:25", is
stamped by the Samsung's own clock and describes a hub unplugged from it
about three and a half days earlier; the "same moment" was a coincidence of
reading it at 01:26.

The doctor fix above stands on its own: the tool did say "attached" for a
phone whose port was empty, from a stale permission record. What it did not
do, and now does, is name the phone it read. The rule that follows: when
adb lists more than one device, the serial has to be the phone the KEY is
in, and the way to know is the user or the port state, not which cable
happens to reach the PC.
