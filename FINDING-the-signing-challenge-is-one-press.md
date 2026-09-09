# The three-digit signing challenge is one press, and the digits are never computed

**Severity:** medium — a security property that is weaker than it looks, and a
client that assumes otherwise leaves stray presses that type passwords
**Status:** open — upstream behaviour, selected by a preference; the library now
lets a caller stop as soon as the device answers
**Applies to:** upstream — `OnlyKey.ino:806-821`, `okcore.cpp:7571-7587`

## What it looks like it does

Before signing or decrypting, the firmware derives three button numbers from a
SHA-256 over exactly the bytes it was sent, and the user presses those three:

```c
sha256_final(&msg_hash, temp);
Challenge_button1 = (temp[0]  % 6) + '0' + 1;
Challenge_button2 = (temp[15] % 6) + '0' + 1;
Challenge_button3 = (temp[31] % 6) + '0' + 1;
```

The host can compute the same digits, so it knows which buttons to prompt for,
and a host that is signing something *different* from what it displayed derives
digits that do not match. That is the point of it.

## What it actually does here

Those three lines are in the **else** of:

```c
if ((is_bit_set(derived_key_challenge_mode, 0)) || stored_key_challenge_mode) {
    CRYPTO_AUTH = 3;
} else {
    ...compute Challenge_button1/2/3...
}                                                   // okcore.cpp:7571-7587
```

so when the slot's challenge-mode preference is set, **the digits are never
computed at all**. And the press handler accepts the operation on any of five
alternatives, of which two need no particular button:

```c
} else if ((CRYPTO_AUTH == 3 && button_selected == Challenge_button3 && isfade && packet_buffer_details[0])
        || (derived_key_challenge_mode == 1 && isfade && packet_buffer_details[0])
        || (stored_key_challenge_mode  == 1 && isfade && packet_buffer_details[0])
        || ...) {                                   // OnlyKey.ino:821
```

`stored_key_challenge_mode == 1` on its own satisfies it. **Any single press of
any button confirms.**

## Measured

On the emulated device, signing a payload whose digits were **1-6-6**, pressing
button **2**:

```
firmware: ["OKSIGN MESSAGE RECEIVED",
           "OKECDSA_EDDSA SIGN MESSAGE RECEIVED",
           "Challenge3 entered2"]
refusal: null
```

A signature came back. `Challenge3 entered2` names the branch and the button:
the third-challenge branch, satisfied by button 2, against a challenge of 1-6-6.

The obvious test — "three wrong buttons are refused" — therefore **fails**, and
writing it as an assertion would have been asserting a property the device does
not have. The e2e suite asserts what is true in both modes instead: that
*something* must be pressed, and that no press means no signature.

## Two consequences

**The name is backwards from the behaviour.** A preference called
`stored_key_challenge_mode` set to 1 gives the *weaker* confirmation — one press
instead of three digits. Anyone reading the desktop app's Preferences tab would
reasonably conclude the opposite. Which value a device ships with is worth
checking before relying on the digits for anything.

**Pressing all three is not harmless.** The device answers after the first, and
the remaining two land on an unlocked device where a press runs `gen_press()`
and **types a slot's contents at the keyboard**. In this app the keystrokes are
captured in-process, so a stray press quietly appends a password to whatever is
listening.

## What the library does

`composite_sign` / `composite_decrypt` hand `confirm` an `isAnswered()` so a
caller can press one at a time and stop:

```js
confirm: async ({ digits, isAnswered }) => {
  for (const d of digits) {
    await OkEmu.holdTicks(d, PRESS_TICKS.TAP);
    await delay(600);
    if (isAnswered()) break;
  }
}
```

Measured on device: `pressed 1 of 1-6-6`, `confirmed after 1 press(es) of 3`.

The digits are still computed and still handed over, because a device with the
preference at 0 does enforce them and the host cannot read which mode it is in.

## Also found while measuring

Walking away from a challenge is not free. After one abandoned operation the
next `OKSIGN` came back `Error device locked` — the branch taken when
`integrityctr1 != integrityctr2` (`okcore.cpp:535`). The e2e suite runs its
no-press test last for that reason.
