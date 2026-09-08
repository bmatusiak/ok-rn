# The touchpin order is not the button order

**Severity:** high for anything that presses buttons (silent, plausible, wrong)
**Status:** fixed in `android/okemu/src/ok_hal.cpp`; the firmware is unchanged
**Applies to:** ours — the HAL's `okemu_touch_for_pin()`
**The firmware behaviour itself is correct and deliberate.** This is a write-up
of a trap, not of a defect in OnlyKey.

## The trap

`setup()` assigns the six touch pads in pin order
(`OnlyKey-Firmware/OnlyKey/OnlyKey.ino:268-273`):

```c
  TOUCHPIN1=1;   TOUCHPIN2=22;  TOUCHPIN3=23;
  TOUCHPIN4=17;  TOUCHPIN5=15;  TOUCHPIN6=16;
```

Reading only that, `TOUCHPIN<n>` looks like "button *n*". It is not.
`okcore.cpp:2574-2628` labels the pads, and the labels are a **permutation** of
the indices:

| touchread | pin | `button_selected` |
|---|---|---|
| `touchread1` | 1 | `'5'` |
| `touchread2` | 22 | `'2'` |
| `touchread3` | 23 | **`'1'`** |
| `touchread4` | 17 | `'3'` |
| `touchread5` | 15 | `'4'` |
| `touchread6` | 16 | `'6'` |

So the pin for button *n* is `{23, 22, 17, 15, 1, 16}[n-1]`, and only buttons 2
and 6 sit where the naming suggests. `button_selected` is what everything
downstream means by "button": it is the digit appended to the PIN
(`OnlyKey.ino:694`), the slot chosen by `gen_press()` (`:996-999`), and the
number printed by the DEBUG console.

The two lists are made of the same six pins, which is what makes the mistake
survive review — a wrong table looks exactly like a right one.

## How it presented

`okemu_set_button()` had been in the HAL since the port with **nothing calling
it**; the PIN flow reached the firmware over the DEBUG serial console instead.
Wiring it through JNI needed a pin table, and the obvious source for one is the
`TOUCHPIN1..6` block — so `kPinForButton[]` was seeded `{1, 22, 23, 17, 15, 16}`
and indexed by button.

The first on-device probe asked only whether a press was noticed at all:

```js
await OkEmu.pressButton(1, 150);   // a tap on button 1
```

```
serial after press: ["password appended with 5", "Number of keys entered for this passcode = 1"]
firmware reacted: true
Passed: 2 Failed: 0
```

**It passed.** Pressing button 1 registered as button 5, and the test that was
meant to prove the press path worked reported success while demonstrating the
bug in its own log output. Nothing else would have complained either: a PIN
entered through this path is wrong in a way indistinguishable from a mistyped
one, because a wrong digit produces no message at all.

The failure mode that matters is worse than a failed unlock. The next step is a
Confirm control for FIDO2 user presence, and `gen_press()` types **the contents
of the slot the button selects**. A Confirm wired to the wrong button does not
refuse — it approves, and types someone's password.

## What catches it

Asking the right question. The probe now presses all six and asserts each one
comes back as itself (`__e2e_tests__/buttonProbe.e2e.js`):

```
pressed 1 -> firmware said 1 (1 line(s))
...
pressed 6 -> firmware said 6 (1 line(s))
mapping: {"1":1,"2":2,"3":3,"4":4,"5":5,"6":6}
```

A press is only observable this way while the device is **locked** — that is
when `payload()` prints the digit. Once unlocked the same press runs
`gen_press()` and there is no digit to read, so the check has to run first.

## Also worth knowing, from writing that test

Pressing 1,2,3,4,5,6 to check the mapping leaves a **prefix of the PIN** in the
password buffer. The first cleanup attempt padded it to the ten-press rollover
using button 1, which spelled `1234561` — the bench device's PIN — and unlocked
it mid-test; the remaining presses then ran `gen_press()` and typed a slot
(`"Slot Number 1"`, `"Displaying Full Keybuffer"` on the console). Padding with
a digit that cannot continue the PIN avoids it. `profile1hashevaluate()` hashes
the whole buffer, so only an exact sequence matches.

Related: [the PIN buffer cannot be cleared](../node-onlykey-lib/FINDING-pin-buffer-cannot-be-cleared.md)
— `clearPinEntry()` appends before it resets, so the rollover is the only clean
way back to an empty buffer.
