# The soft key's firmware thread stopped, once, during BLE vendor testing

**Status: OBSERVED ONCE, NOT REPRODUCED, CAUSE UNKNOWN.** Recorded so the next
occurrence is a second data point rather than a first one.

## What was seen

2026-09-24, mid-morning. After a run of host-driven vendor exchanges over BLE,
every read returned empty - including one given a full second, on a link whose
measured maximum round trip is 239 ms. The app's screen read:

> The soft key has stopped — its firmware thread cannot be replaced in this
> process. Nothing is lost.
> [Restart the app]

Tapping that, logging back in, and re-running produced a clean pass.

## What this is NOT

**Not the vendor GATT path.** logcat through the whole dead period shows every
host write arriving and reassembling correctly:

```
10:23:42.800 D FidoGatt: vendor: fragment held, message incomplete
10:23:42.806 D FidoGatt: vendor: fragment held, message incomplete
10:23:42.810 D FidoGatt: vendor: fragment held, message incomplete
10:23:42.816 D FidoGatt: vendor: message cmd=0x03 len=64
```

Four fragments in, one 64-byte message out, repeatedly. The radio, the GATT
service and the reassembler were all working; there was simply nothing behind
them to answer. **This is why the log line matters** - without it the obvious
reading is "the new BLE code is broken", and three failing tests said exactly
that.

**Not reproducible by the sequence that preceded it.** Three consecutive full
runs of `python-onlykey/tests/ble_live.py` afterwards - set_time, an abandoned
read, a drain, a 1000 ms read, and `getlabels()` - all passed, same app pid,
key still unlocked.

## What was going on at the time, none of it ruled in or out

- a full `e2e:run` had finished ~30 minutes earlier, which restarts the app at
  the end so the key is not left in config mode
- the app had been restarted and unlocked by hand after that
- several host scripts had **thrown before calling `close()`**, leaving BLE
  links open; a later connect had its CCCD write cancelled by Windows because
  of it. That is now fixed in the test, but it means more than one central may
  have been attached to the GATT server during the window.

The last of those is the most interesting and the least evidenced. It is
written down because it is cheap to check next time - `dumpsys bluetooth_manager`
names attached centrals - and because nothing else distinguishes that session
from the three clean ones.

## Why it is not being chased further now

The message is the app reporting a known, deliberate limitation rather than a
crash: `OkEmu.restart()` rejects and `1-softKey.e2e.js:149` pins that refusal,
because the firmware thread cannot be replaced in a running process. So the
screen is the correct behaviour for a firmware thread that has exited; what is
unknown is why it exited.

Chasing an unreproduced event costs bench time that the remaining BLE work
needs. The next occurrence should capture, before restarting the app:

    adb logcat -d | grep -i "okemu\|firmware\|thread"
    adb shell dumpsys bluetooth_manager | grep -A5 "Connected"
