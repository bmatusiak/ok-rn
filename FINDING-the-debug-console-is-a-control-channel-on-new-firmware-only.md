# The debug console can PRESS BUTTONS — on the working tree only, not on any release

**Where:** `libraries/onlykey/okcore.cpp:2360-2521` (the parser) and `:2689-2717`
(the reader and the replay queue), all inside `#ifdef DEBUG`
**Status:** Measured. Now a capability, `capabilities().consolePress`.

## The contradiction this settles

`device.unlock()` defaults to writing PIN digits to SEREMU with `pressLine()`,
and `__e2e_tests__/helpers/pressDigits.js` says in its header that this is *"a
DEBUG-BUILD FEATURE: the whole simulated-press command interface sits inside
`#ifdef DEBUG` in okcore.cpp"*.

**Two independent reads of the firmware failed to find that interface.** Both
concluded the console was write-only, that `pressLine` was theatre, and that a
real key could never be given a PIN in software. The plan was written to settle
it on hardware before building on either answer.

**The probe says the console plainly does press.** Writing `1` to SEREMU made
the firmware print `password appended with 1` — the same announcement a real
button press produces.

**Both were right, for different firmware:**

| firmware | `Serial.read` in okcore.cpp |
|---|---|
| working tree | yes — `:2690` |
| v3.0.2 · v3.0.1 · v3.0.0 · v2.1.1 · v2.1.0 | **none at all** |

So on every RELEASED firmware the console is write-only and `unlock()`'s default
path cannot work. The interface is newer than every pin in `ok-versions.json`.
The reads were of the pinned sources; the probe was against the working tree.

## What the interface actually is

Far more than PIN digits. A line terminated by return, echoed back as
`I received from DEBUG: <first byte>` before it is acted on — which doubles as a
"the firmware is running `loop()`" readiness probe:

| form | meaning |
|---|---|
| `1`..`6` | a tap, `DBG_PRESS_TAP` = 1 tick |
| `N!` | hold, 128 ticks — clears the ≥72 gesture band |
| `N!!` | 200 ticks — clears the ≥180 band, a DUO's config mode |
| `N!!!` | 400 ticks — clears the ≥360 band, a DUO's factory default |
| `N#<ticks>` | an explicit count, up to `DBG_PRESS_MAX` = 1000 |
| `8` | restart, `CPU_RESTART()` |
| `0C` | userspace wipe |
| `9C` | full wipe, forces the bootloader |

Several presses fit in one line and are replayed **one per loop iteration**,
which is the rate the physical button path feeds them in at. A byte that is not
a button rolls the whole line back and says so, so a bad line presses nothing.
The line buffer is 32 bytes because that is `SEREMU_RX_SIZE`, one OUT report.

`#<ticks>` is the one that matters most: it reaches **any** press band, so a
developer key can be driven exactly as the emulator is — taps, b-profile holds,
the backup gesture, config mode.

## What this is NOT: "can a host press a button"

Pressing is a property of the HOST. This is only about whether the CONSOLE
accepts press commands, which is the question for a real key reached over a
wire.

**An emulated key presses in any build, production included, and never needs
the console.** The host fakes the capacitive reading, so the press arrives at
`touch_sense_loop()`'s `touchread1..6` comparisons (`okcore.cpp:2574`) exactly
as a finger would. Those sit outside every `#ifdef DEBUG` in that function -
the first one is the console parser, further down - so the gate this capability
turns on is simply not in that path.

The full picture:

| key | build | pressed in software by |
|---|---|---|
| soft | debug | the host, faking the pads (or the console) |
| soft | **production** | **the host, faking the pads** |
| real | debug, new firmware | the console |
| real | debug, released firmware | nothing - a finger |
| real | production | nothing - a finger |

Reading `consolePress === false` as "this device cannot be pressed" would
disable a soft key that presses perfectly well. The library never presses; every
call site takes the press from its caller, which is what makes all five rows
the same code.

## Why this matters more than it looks

**A restart is available.** `8` calls `CPU_RESTART()`. "In-process firmware
restart" has been on the not-in-this-chunk list on the grounds that the thread
only exits through the AIRCR trap. On a real developer key it is one line.

**A developer key can be driven unattended.** That was the open question for
hardware testing. The answer is yes, on new firmware, and no on a released one —
where every press needs a finger.

## What changed because of it

- `capabilities().consolePress` — **two** conditions, both required: a debug
  build, because the parser is inside `#ifdef DEBUG`, and firmware newer than
  v3.0.2. The boundary is only known to be *somewhere above* v3.0.2, since no
  pin sits between it and the working tree's v3.0.4.
- It treats UNKNOWN as **false**, the opposite of `debugConsole`, which treats
  unknown as "may well be there". Deliberate: assuming a console exists keeps an
  old device provisionable, while assuming it can press writes a PIN into a void
  and then blames the PIN.
- `__e2e_tests__/2c-pressLine.e2e.js` pins the behaviour against whatever
  firmware is staged.
- The stale claim in `pressDigits.js` is corrected rather than deleted — the
  helper is still right to press real buttons, but for a version reason rather
  than a build reason.

## How it was found

By running a probe instead of continuing to argue with the source. The control
half matters as much as the measurement: it presses a real button first and
requires that to print, so "nothing happened" cannot be a broken listener.

Two greps had already missed `okcore.cpp:2690` before the probe was written.
