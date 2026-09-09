# Every CPU_RESTART() killed the app, because one register was left behind

**Severity:** high — the idle lockout, the lock gesture, a failed integrity
check and the end of a wipe all end in `CPU_RESTART()`, and all of them took the
whole process down
**Status:** fixed — `okcore.h`'s `CPU_RESTART_ADDR` is rebased with the rest of
the system block
**Applies to:** ours — `ok-rn/android/okemu/scripts/stage.js`

## The crash

Measured on a Pixel 6a while waiting out a one-minute idle lockout:

```
pid: 25422, tid: 25495, name: okemu-firmware  >>> com.okrn <<<
signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x00000000e000ed0c (write)
x8  0000000005fa0004
#04 pc 00000000000d5a64  libokemu.so (okemu_firmware_run+124)
```

`0xE000ED0C` is AIRCR. `x8` is `0x05fa0004`, which is `CPU_RESTART_VAL`. So this
is `CPU_RESTART()` writing to an address nothing maps.

## Why one register was missed

`stage.js` rebases the whole `0xE0000000` system block, because that window is
unmappable on 32-bit ARM. `rewriteSystemBlock()` does it with a regex — and the
regex has two conditions that both have to hold:

```js
const target = path.join(STAGE_CORE, 'kinetis.h');           // this file only
const re = /\(\*\(volatile (uint\d+_t|int\d+_t) \*\)(0x[EF][0-9A-Fa-f]{7})\)/g;
```

`okcore.h` names the same register itself, in neither the file nor the shape:

```c
#define CPU_RESTART_ADDR (uint32_t *)0xE000ED0C     // a bare pointer literal
```

So after staging, the two names for AIRCR disagreed:

| name | file | staged as |
|---|---|---|
| `SCB_AIRCR` | `core/kinetis.h` | `OKEMU_SCS(0xE000ED0C)` ✓ |
| `CPU_RESTART_ADDR` | `libraries/onlykey/okcore.h` | `0xE000ED0C` ✗ |

and the firmware's `CPU_RESTART()` uses the second one.

## Why nothing caught it

`okemu_restart.cpp` exists precisely to make this write survivable: it maps the
rebased page read-only and installs a SIGSEGV handler that turns a store to
AIRCR into a restart EVENT. Its own header even predicts the inverse mistake —
*"Left as the literal, this trap would guard an address nothing writes and
CPU_RESTART() would be a silent no-op"* — but the actual failure was the mirror
image: the trap guarded the rebased address, the firmware wrote the literal one,
and the literal one is not mapped at all.

That is the difference between the two SIGSEGV codes, and it is the tell:
`SEGV_ACCERR` would mean the guarded page was hit (mapped, no write permission);
`SEGV_MAPERR` means nothing was there.

The e2e suite never saw it because no test waits out an idle lockout, and the
one restart assertion checks `restart()` — a different path that reports "not
implemented" without going near AIRCR.

## What it looked like from outside

Not like a crash. The app vanished and the launcher appeared, which reads as the
app being backgrounded — I twice recorded it as "the screen slept" before
looking at logcat. `FINDING-lock-gesture-ends-the-soft-key.md` describes holding
button 3 as ending the soft key; this was the mechanism.

## The fix

One more literal patch in `stage.js`, beside the four that already rebase
`okcore.h`'s flash addresses:

```js
['#define CPU_RESTART_ADDR (uint32_t *)0xE000ED0C',
 '#define CPU_RESTART_ADDR ((uint32_t *)OKEMU_SCS(0xE000ED0C))'],
```

Verified after: the idle lockout fires, the process keeps the same pid, the
firmware reports `halted`, and the app returns to its login screen instead of
disappearing.

## The general shape

A rewrite that finds its targets by pattern will miss a target written another
way, and the miss is invisible — staging reported "57 registers rebased" both
before and after, because 57 was never the number that mattered. The
counter-measure is to assert the ABSENCE of what should have been rewritten:
after staging, no `0xE000ED0C` should remain outside a comment.
