# Finding: a bad flash mapping produces a device that looks healthy

**Status:** measured on Android. The degraded mode is reached by default there,
because `vm.mmap_min_addr` cannot be lowered.
**Severity:** not a crash — the opposite, and that is the problem. The device
boots, answers HID, reports a plausible status, and cannot do any crypto.
**Found by:** believing it. See below.
**Whose code:** `node-onlykey-emulator/emulator/src/ok_hal.cpp`.

## Summary

The firmware reaches its own key material through absolute pointers;
`certified_hw` is at `0x5BB0`. `okemu_hal_init()` tries to map `flash.bin` at
address 0 and, when `vm.mmap_min_addr` forbids that, walks a fallback ladder of
`0x1000` then `0x10000`. Its own comment is exact about what the last rung
costs:

```
 *   0x10000 the unprivileged default. Storage at 0x3A800 is reachable and
 *           the device boots, but any crypto that touches certified_hw
 *           will crash. Usable only for HID/protocol work.
```

Two things then conspire to hide it.

**The warning is unreachable in practice.** It goes to `stderr`:

```c
    if (off > 0x5BB0UL) {
      fprintf(stderr, "[okemu] WARNING: flash mapped from %#lx; ...");
```

Android discards a process's stdout and stderr unless something redirects them,
so on the platform where this mode is the *default* the warning is guaranteed
not to be seen. Even on Linux it lands in a daemon log rather than anywhere a
test result appears.

**The crash it warns about is then suppressed.** A few lines later:

```c
  *(volatile uint8_t *)kFTFL_FSEC = low_mapped ? 0xFF : 0x44;
```

`FSEC = 0x44` tells the firmware it is already provisioned, so the one-time
branch that would dereference `certified_hw` never runs. That is deliberate and
correct — it is the only way the degraded mode is usable at all — but the
combined effect is a device that has quietly lost a capability and reports
nothing about it.

## How it presented

Exactly as a pass. The port booted, created `flash.bin` and `eeprom.bin` at the
right sizes, drove its LED, and answered `OKCONNECT` with
`"UNINITIALIZEDv3.0.4-testc"` — its real version string. Every observable said
working.

None of it touched the crypto path. On an `UNINITIALIZED` device `OKCONNECT`
returns a status string without performing the key exchange, so the one check
that would have failed was the one check not being made. The truth was a page
away the whole time:

```
$ adb shell run-as com.okrn cat /proc/$PID/maps | grep flash.bin
00010000-00040000 rw-s 00010000 ... /data/data/com.okrn/files/okemu/flash.bin
```

Mapped at `0x10000`, at file offset `0x10000` — the bottom 64 KB of the array,
`certified_hw` included, simply absent.

## Suggested fix

Make the degradation legible at the point where a caller can act on it:

- report it through the HAL rather than `stderr` — an `okemu_hal_status()`, or
  a field on whatever `okemu_hal_init()` already returns, so a host can surface
  "protocol-only" in its UI and a test can assert on it;
- have `capabilities.js` derive its `attestation` entry from that value rather
  than from `emulated` alone, so the reason is measured rather than assumed;
- consider refusing to start without an explicit opt-in
  (`OKEMU_ALLOW_PROTOCOL_ONLY=1`). A device that cannot encrypt is not a device
  most callers want to be handed silently.

`onlykey-testing/lib/capabilities.js` already documents the consequence
precisely — no factory key derivation, no firmware hash in EEPROM, no security
lock bits. Nothing carries that knowledge back to the running process.

## What ok-rn does instead

Rebases rather than degrades. The firmware's four address literals in
`okcore.h` get `OKEMU_FLASH_BASE` added and the array is mapped at
`0x44000000`, so the whole thing is present, `low_mapped` is true, `FSEC` stays
`0xFF`, and the provisioning branch runs. See the `okcore.h` entry in
`android/okemu/scripts/stage.js`.

That is worth noting on its own: `capabilities.js` calls attestation
permanently unavailable in emulated mode because it needs
`vm.mmap_min_addr=0`, "a configuration nobody should run". Rebasing gets it
without lowering anything, and would work on Linux too.

## Resolved structurally (not fixed)

There is no degraded mode left to be silent about. The flash array is no
longer mapped at a fixed address with fallbacks that skip the bottom pages -
the kernel chooses the address and the whole 256 KB maps or nothing does, so
certified_hw at +0x5BB0 is always present.

The dangerous half was FSEC. It was set to 0x44, meaning ALREADY PROVISIONED,
whenever the low pages were unmapped - which stopped the firmware walking into
them and, in doing so, stopped the crash that would have revealed the problem.
It is unconditionally 0xFF now.

See the commit "let the kernel say where the flash array lives". The trigger
was a Pixel 6a on Android 16, where ART maps its JIT zygote cache over the old
fixed base and the firmware could not start at all.
