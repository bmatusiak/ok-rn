# A DUO has two pads, and its third button is both at once

**Severity:** high for any host that presses buttons on a DUO — button 3 does
nothing, and button 2 answers as something else
**Status:** handled. The emulator reproduces both behaviours, and
`capabilities().buttons` reports 3 so callers stop at the right number.
**Applies to:** OnlyKey DUO, all firmware that supports it (v3.0.0 and later)

## What the firmware does

`okcore.cpp`'s touch-sense loop has **no third branch for a DUO**. It reads the
two pads as buttons 2 and 1, and each branch then checks whether the OTHER one
is also held:

```c
else if (touchread2 > ...) {
    button_selected = '2';
    if (onlykeyhw == OK_HW_DUO) {
        if (touchread3 > ...) { button_3_on++; button_3_off = 0; }
        else { button_3_off++; if (button_3_off > 2) button_3_on = 0; }
    }
}
```

and symmetrically in the `touchread3` branch. The `touchread1`, `4`, `5` and `6`
branches are each guarded `onlykeyhw != OK_HW_DUO`, so those pads produce no
button at all.

**And two of the reads are crossed.** `rngloop()` samples the pads into six
globals, and on a DUO:

```c
if (onlykeyhw == OK_HW_DUO) {
    touchread2 = touchRead(TOUCHPIN5);
    touchread5 = touchRead(TOUCHPIN2);
} else {
    touchread2 = touchRead(TOUCHPIN2);
    touchread5 = touchRead(TOUCHPIN5);
}
```

So on a DUO, "button 2" is whatever TOUCHPIN5 reports.

## How it presented

Both were found the first time the emulator was staged as a DUO
(`OKEMU_MODEL=duo`), by a probe that walks every button and reads back what the
firmware says it was:

```
mapping: {"1":1,"2":null,"3":null,"4":null,"5":null,"6":null}
✗ every button arrives as itself -> pressing button 2 registered as null
```

Button 1 worked because TOUCHPIN3 is the same pad on both models. Button 2 was
being answered on the pad the firmware reads as button 5, so the press landed
nowhere. Button 3 was worse than wrong: there is no pad to hold.

This is the same class as `FINDING-touchpin-order-is-not-button-order.md` — the
first version of that probe asked only "did the firmware react", pressed button
1, and passed while the device logged something else entirely.

## What was done

`android/okemu/src/ok_hal.cpp` now branches on `onlykeyhw` — the same variable
the firmware branches on, so if its detection or its `DEFINED_HWID` override
changes, the HAL follows rather than drifting:

- a DUO's button 2 answers on TOUCHPIN5 and its button 4 on TOUCHPIN2, matching
  the crossed reads
- a DUO's button 3 reports **both pads held**, which is what a finger on each
  does and the only way the firmware's counter advances

With that, the probe reads `{"1":1,"2":2,"3":3,"4":null,"5":null,"6":null}` and
**the DUO passes 66 of 67 with one skip.**

The probe now walks `capabilities().buttons` and separately asserts that every
pad BEYOND that count stays silent — a device that answered button 5 would be
one whose mapping had drifted back to the classic table.

## What this means above the HAL

A host cannot present a DUO's third button as a button. It is a chord, and a
screen that draws three keys has to send two presses for the third — or say so.
Nothing in `ok-rn` draws a DUO keypad yet, so this is recorded before that
screen is written rather than after.

The skip is the PIN-buffer cleanup: a DUO carries its PIN in the message body,
so presses never enter a password buffer and there is nothing to roll over.
