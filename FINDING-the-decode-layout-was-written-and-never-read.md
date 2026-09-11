# FINDING: the keyboard layout was written to the key and never used to read it back

**Found:** 2026-09-10, by reading the call sites while planning the keyboard
capture work; confirmed against the library's decoder signature.

## What was measured

`device.readSlot(slotId, {press, layout})` and `device.captureBackup({trigger,
layout})` both take a `layout` and build their decoder from it
(`keystrokes.createDecoder({layout})`, default `USA_ENGLISH`). In the app:

- `SlotEditorScreen` called `readSlot` with `press` only.
- `BackupScreen` called `captureBackup` with `trigger` only.
- `PreferencesScreen` offered every compiled-in layout and wrote the chosen
  id to the key's KBDLAYOUT field - and nothing read that choice back.

So every slot and every backup was decoded as US English, whatever the key
had been told to type in.

## Why nobody saw it

The soft key's build compiles in two layout tables and defaults to US, and
every e2e run leaves it there; a US key decoded as US is correct. The
Preferences screen also says, truthfully, that the key never reports its
preferences - which made "the app cannot know the layout" sound like a fact
rather than a gap. It cannot ASK; it can remember what it wrote.

A HARD key is where it bites: every layout is compiled into a production
build, so a key set to German types German, and the decoder read those
reports through the US table. Wrong characters, no error, and a slot editor
that would happily write the wrong password back.

## What is fixed

`useKeyboardLayout` remembers the layout NAME per key (soft and hard are
different devices with different settings) when the Preferences screen
writes it, and `SlotEditorScreen` and `BackupScreen` pass it to the decoder.
The default is the firmware's default until a layout has been written from
this app.

Found alongside it and fixed in the same change: both screens pressed the
button through `OkEmu.holdTicks` directly - the SOFT key - so with a hard
key selected, "read this slot" pressed the emulator. Both handles now carry
`holdTicks`, and the screens press the key they are on.

## What is not fixed

A layout written to the key by ANOTHER client (the desktop app, the web app)
is unknown to this one, and the decode falls back to US. The key cannot be
asked. The honest fix is a capture pane that shows the raw typed text so a
wrong layout is visible, which is the next piece of this work.
