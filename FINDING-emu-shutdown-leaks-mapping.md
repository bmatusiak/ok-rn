# Finding: `okemu_hal_shutdown()` never unmaps the flash

**Status:** measured on Android, deterministic. Re-initialising the HAL in the
same process fails every time.
**Severity:** blocking for any host that restarts the firmware without
restarting the process. Invisible upstream.
**Found by:** restarting the firmware in-process from a React Native app.
**Whose code:** `node-onlykey-emulator/emulator/src/ok_hal.cpp`.

## Summary

`okemu_hal_init()` maps `flash.bin` with `MAP_FIXED_NOREPLACE`.
`okemu_hal_shutdown()` syncs it and closes the descriptor, but never unmaps it:

```c
void okemu_hal_shutdown(void) {
  okemu_systick_stop();
  if (g.eeprom_fd >= 0) { pwrite(...); ::close(g.eeprom_fd); g.eeprom_fd = -1; }
  if (g.flash) {
    msync((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off),
          OKEMU_FLASH_SIZE - g.flash_mapped_off, MS_SYNC);
  }
  if (g.flash_fd >= 0) { ::close(g.flash_fd); g.flash_fd = -1; }
}
```

Closing the descriptor does not remove the mapping — that is what `munmap` is
for. So the address range stays occupied, and the next `okemu_hal_init()` hits
`EEXIST` from `MAP_FIXED_NOREPLACE`:

```
cannot map flash: File exists - lower vm.mmap_min_addr (sudo sysctl -w vm.mmap_min_addr=4096)
```

The message is actively misleading: the suggested fix is unrelated, and on a
host where `mmap_min_addr` is already correct it sends the reader down the
wrong path entirely. That is how this presented — as an apparent permissions
problem on a machine with no permissions problem.

## Why it has never mattered upstream

A restart in the Node emulator is a **process** restart. `okemu_firmware_run()`
parks the firmware thread and fires the restart sink; `bin/daemon.js` maps that
to `process.exit()` and pm2 respawns. The address space goes with the process,
so the leaked mapping is collected for free and `okemu_hal_init()` never runs
twice in one process.

Hosting the firmware inside an app breaks that assumption: the process outlives
the firmware, so init and shutdown have to be symmetric.

## Fix

```c
  if (g.flash) {
    msync(..., MS_SYNC);
    munmap((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off),
           OKEMU_FLASH_SIZE - g.flash_mapped_off);
    g.flash = nullptr;
    g.flash_mapped_off = 0;
  }
```

The peripheral windows in `okemu_map_peripherals()` are a different case and
should stay mapped: they are set up by a load-time constructor, hold no file,
and are re-used by the next firmware instance.

## The adjacent problem this exposes

Fixing the leak is necessary but not sufficient for an in-process restart, and
the second half is worth stating because the first half makes it *more*
dangerous rather than less.

`okemu_firmware_run()` never returns — `SoftTimerClass::run()` is an infinite
scheduler loop, as on the device. Its only exit is the AIRCR trap in
`okemu_restart.cpp`, which parks the thread via `siglongjmp` when the firmware
itself calls `CPU_RESTART()`. So calling shutdown and then init does not
restart the firmware; it starts a **second** one alongside the first.

Before the `munmap` fix that went unnoticed, because the old thread carried on
against a mapping that was still there. With the fix, the old thread faults on
its next flash access. A correct in-process restart needs a cooperative stop —
a flag the firmware thread checks somewhere it reaches often, `micros()` being
the obvious candidate, that `siglongjmp`s to the same park.

`ok-rn` does not implement that yet; `NativeOkEmuModule.restart()` rejects with
the reason instead, and callers restart the app process.
