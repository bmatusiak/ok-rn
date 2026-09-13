# A hard-key override outlives the hard key

Measured on the bench phone, 2026-09-13, on the login path.

## What happened

With a key plugged in, the login screen's `Hard key | Soft Key` row was set to
Hard key. That writes `ok-rn/key-source/override = 'usb'` to AsyncStorage.

Then the key came out. The app stayed on the hard-key branch of the PIN screen:

    Locked
    Enter your PIN on the key's own buttons.
    [Back]

No keypad, no LED, and the selection row GONE - it only draws when a key is
attached, because with nothing plugged in there is no second key to offer. So
the one control that could have switched back was hidden by the same fact that
made switching back necessary.

`adb logcat` confirmed the key was really gone:

    I ReactNativeJS: [hardkey] usb disconnected: device detached: /dev/bus/usb/001/003
    I libpixelusb-UsbDataSessionMonitor: Update device state host1: not attached

## Why

`useKey`'s `backend` let an override beat everything, deliberately:

>  An override beats everything, including a key that is not plugged in - if
>  someone has forced the hard key, showing them the soft one instead would be
>  answering a different question than they asked.

That reasoning holds while both keys exist. It stops holding the moment the
hard key is pulled: the override then names something that is not on the bus,
so the app sits on a dead handle telling you to press buttons on a key that is
in your pocket. It is not answering the user's question any more - the thing
they pointed at is gone.

The override also PERSISTS, so this survived a relaunch. A phone that had never
seen a key since boot would still come up forced to `usb`.

## Fixed

`useKey.ts` clears a `usb` override when `attached` goes false, through
`setOverride(null)` so the stored value goes too.

Only that direction clears. An override to the SOFT key is never stranded - the
soft key is always running - so a deliberate choice of it survives an unplug.

`attached === false` rather than falsy: `null` means USB has not answered yet,
which is true on every launch, and clearing on that would throw the choice away
before it had been tested once.

## The general shape

This is the second time in one evening that a control was hidden by the
condition that made it necessary - see also the soft key's LED going dark while
the pill still said `running`. A screen that derives its controls from device
state needs to ask whether the state that removes a control can also be the
state you need it in.
