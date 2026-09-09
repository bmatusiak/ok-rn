# Accented characters were typed as their bare base key

**Severity:** medium — silent, and produces a wrong password rather than no password
**Status:** fixed — `okemu_deadkey_for()` ported into the keyboard override
**Applies to:** ours — `android/okemu/core-override/okemu_usb.cpp`

## What happens on a layout with dead keys

`keylayouts.c` encodes an accented character as an accent plus a base key, with
the accent in bits **above** the six that reach the wire. Canadian French:

```c
DEADKEYS_MASK   = 0x0700;
CIRCUMFLEX_BITS = 0x0100;
ASCII_5E = CIRCUMFLEX_BITS + KEY_SPACE;   // 94 ^
```

Typing `^` is therefore two keystrokes — press circumflex, release it, press
space — and the Teensy core does exactly that (`usb_keyboard.c:316-331`):

```c
deadkeycode = deadkey_to_keycode(keycode);
if (deadkeycode) {
    modrestore = keyboard_modifier_keys;
    if (modrestore) { keyboard_modifier_keys = 0; usb_keyboard_send(); }
    mod = keycode_to_modifier(deadkeycode);
    key = keycode_to_key(deadkeycode);
    usb_keyboard_press_key(key, mod);
    usb_keyboard_release_key(key, mod);
}
```

`okemu_usb.cpp` replaces that translation unit wholesale and had not carried
this across. Its `usb_keyboard_press_keycode()` went straight to
`okemu_press_key(keycode & 0x3F, ...)` — and the accent bits are all above
`0x3F`, so they were simply discarded. `^` was typed as a space. Every accented
letter was typed unaccented. Nothing errored anywhere.

## Why it was invisible

Three things hid it, and each one is worth noting because they are the same
three that hide the next bug of this shape:

- **The comment above the code said the tables were right, and they were.**
  `okemu_unicode_to_keycode()` returns the correct keycode; the loss is one
  line later, in the truncation. A reader checking "are we using the real
  layout tables" gets a yes.
- **Our build has no dead keys.** `keylayouts.h` defines
  `KEYLAYOUTS_DEBUG_BUILD` and every `SUPPORT_LAYOUT_x` under it is commented
  out, so only US English compiles in — and US English has `DEADKEYS_MASK = 0`.
  See `FINDING-only-us-english-types-on-a-debug-build.md`. The bug is latent
  today and would arrive with the first release build.
- **The stock core guards each accent with `#ifdef`.** OnlyKey ships these as
  runtime variables rather than defines, so a straight copy of the upstream
  code compiles to nothing — the same trap `okemu_usb.cpp` already documents
  for `SHIFT_MASK`. The port tests them with `if`.

## How it was found

Not by reading the file. The keystroke decoder
(`node-onlykey-lib/src/device/keystrokes.js`) is tested by round-tripping every
printable character through every layout, using a second implementation of the
firmware's forward path written from `okemu_usb.cpp`. Canadian French came back
with `^` as a space and `` ` `` as a space, which is what sent me to
`usb_keyboard.c` to compare.

A decoder is a good place to find encoder bugs: it has to state what the
encoder does precisely enough to undo it.

## The fix

`okemu_deadkey_for()`, a port of `deadkey_to_keycode()` with `if` in place of
`#ifdef`, called from both `usb_keyboard_press_keycode()` and
`usb_keyboard_write_unicode()`. The modifier save/restore comes with it: the
stock core drops any held modifier before the accent and reapplies it after,
because an accent typed with shift down is a different keystroke on most
layouts.

## What the decoder had to learn from it

The fix changes what is on the wire, so the decoder had to change too — an
accented character is now two presses, and reading them independently gives the
base character alone.

It also exposed something the fix cannot solve. Two accents can share one
keycode:

```c
// Portuguese
DEADKEY_CIRCUMFLEX   = DEADKEY_TILDE          // both 0xF031
DEADKEY_ACUTE_ACCENT = DEADKEY_GRAVE_ACCENT   // both 0xF070
```

so `^` and `~` are the same two keystrokes. The decoder is therefore keyed on
the keystroke **sequence** rather than on the accent, which makes such pairs
visible as collisions and reportable instead of silently resolved. See
`FINDING-layout-tables-map-two-characters-to-one-keystroke.md`.
