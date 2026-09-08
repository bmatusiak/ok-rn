# stop() then start() ran two firmware threads against one device

**Severity:** high (silent state corruption; presented as a flaky device)
**Status:** fixed — `nativeStart` now refuses rather than spawning a second
**Applies to:** `android/okemu/jni/okemu_jni.cpp`

## What happened

`nativeStop()` does not stop the firmware. It cannot: `okemu_firmware_run()` is
the Arduino `loop()` and never returns, which the code says plainly —

```c
  /*
   * The firmware thread is not joined. okemu_firmware_run() never returns, so
   * there is nothing to join on - the same reason the Node addon detaches it.
   */
```

So `stop()` shuts down the HAL, clears the sinks and sets `g_running = false`,
and the thread keeps running. `start()` then called `pthread_create` again.

Every stop/start cycle therefore added another firmware thread, and all of them
shared one set of globals — `g.hid_in`, `g.seremu_in`, the button state, the
guessed-password buffer. `okemu_hid_recv()` pops from the front of a single
queue, so each report and each PIN digit went to whichever thread happened to
wake first.

This is the same root cause as `restart()` being unsupported, wearing a
different hat. `restart()` was honest about it; `stop()` + `start()` was not.

## How it presented

Not as a crash. The e2e suite rebooted the firmware before each test, and:

- `unlock()` failed on the first two attempts and succeeded on the third,
  reproducibly — because the PIN digits were being split between threads.
- The failure was indistinguishable from a wrong PIN, since a wrong digit
  produces no message at all.
- Adding delays changed which tests failed, which made it look like a race in
  the host rather than a leak in the bridge.

I spent a while looking for the fault in the PIN flow and in Metro before
checking whether `stop()` did what its name says.

## The fix

`nativeStart` refuses once a thread has been created and stopped, with the
reason:

> the firmware thread cannot be restarted in this process - it only exits
> through the AIRCR trap, so starting again would run a second one alongside
> it. Restart the app; flash.bin and eeprom.bin persist.

`"already running"` is unaffected, so the app's auto-start on mount still works
and a second `start()` while running is still a no-op.

The e2e suites no longer stop the firmware. They did it to get a clean device;
the runner force-stops the app before each run, so every run already has one.
Removing it took the suite from 72s to 13s.

## What is still true

There is no way to restart the emulated firmware in-process. Anything needing a
genuinely fresh device — clearing the PIN buffer after a failed attempt, for
instance — has to restart the app. `flash.bin` and `eeprom.bin` are file-backed,
so device state survives that.
