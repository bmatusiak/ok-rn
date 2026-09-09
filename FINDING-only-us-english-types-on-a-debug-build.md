# On a debug build, any keyboard layout but US English types nothing at all

**Severity:** medium — a preference the user can set that silently disables typing
**Status:** open — upstream build configuration; the app must not offer the choice
**Applies to:** upstream — `core/keylayouts.h:125-155`, `keylayouts.c`

## What happens

`keylayouts.h` gates the layout tables on the build:

```c
#define KEYLAYOUTS_DEBUG_BUILD  // comment out for a release build

#ifdef KEYLAYOUTS_DEBUG_BUILD
//#define SUPPORT_LAYOUT_DVORAK
//#define SUPPORT_LAYOUT_GERMAN
...every one commented out...
#else
#define SUPPORT_LAYOUT_DVORAK
#define SUPPORT_LAYOUT_GERMAN
...every one enabled...
#endif
```

and `update_keyboard_layout()` wraps each layout's table in the matching guard:

```c
else if (KeyboardLayout[0] == LAYOUT_GERMAN) {
#if defined(SUPPORT_LAYOUT_GERMAN)
    ...212 lines of tables...
#endif
}
```

US English is the exception — its block (`keylayouts.c:517`) has no guard, and
its condition also covers Dvorak and an unset layout byte.

So on a debug build, selecting German takes the German branch, which is **empty**.
The `ASCII_*` locals stay at their initialiser of 0, `keycodes_ascii[]` is filled
with zeros, and `okemu_unicode_to_keycode()` returns 0 for every character —
which `usb_keyboard_press_keycode()` treats as "nothing to press":

```c
uint16_t keycode = okemu_unicode_to_keycode(n);
if (!keycode) return;
```

The key types **nothing**. No error, no partial output, no log line. A slot that
holds a password produces an empty window.

## Why it matters here specifically

This app must run a debug build. `FINDING-provisioning-needs-a-debug-build.md`
records why: the provisioning path the emulator depends on is `#ifdef DEBUG`.
So the mobile app is permanently in the configuration where only US English
works, while the desktop app's Preferences tab offers all 28 layouts and writes
the choice to EEPROM.

That is a setting a user can change once and then be unable to diagnose: the key
looks healthy, unlocks, reports its version, answers every command, and types
nothing.

## What the app should do

Phase B4 (Preferences) must not present the full list. The library reports which
layouts have tables, from the same generated data the decoder uses:

```js
keystrokes.layouts()
  // [{ name: 'USA_ENGLISH', id: 1, supported: true, ambiguous: [] }, ...]
```

`supported` is false for a layout whose table is all zeros. On a debug build
that is every layout except US English and Dvorak, and the picker should either
offer only the supported ones or mark the rest plainly as unavailable on this
firmware.

Note that `supported` describes **the build the tables were generated from**,
not the device in front of you. `ok-rn/tools/gen-keylayouts.js` deliberately
ignores the `SUPPORT_LAYOUT_x` guards when generating, because the library is
shared with apps that talk to real hardware running release builds — there, all
28 work. If the two ever need to differ per-device, the honest answer is to ask
the device rather than to infer it.

## Not fixed here

Uncommenting the layouts would change what the firmware does, and the standing
rule is that staging exists to make the firmware run rather than to modify it.
It would also cost flash, which is the reason the guard exists.
