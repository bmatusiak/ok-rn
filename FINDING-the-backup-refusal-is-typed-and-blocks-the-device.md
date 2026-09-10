# The backup refusal is TYPED, and the device answers nothing for ~9 seconds

**Where:** `libraries/onlykey/okcore.cpp:6289` (`backup()`), refusal at `:6802-6812`
**Firmware:** every version in the matrix (working tree, v3.0.2, v3.0.1, v3.0.0, v2.1.1, v2.1.0)
**Status:** NOT PATCHED. This is what a real key does.

## What happens

A backup gesture on a key with no backup key set produces two things, and the
second one is the problem:

```c
okeeprom_eeget_backupkey(&slot);
...
if (slot == 0)
{
    hidprint("Error no backup key set");
    for (uint8_t z = 0; z < sizeof(nobackupkey); z++)
    {
        Keyboard.press(nobackupkey[z]);
        delay((TYPESPEED[0] * TYPESPEED[0] / 3) * 8);
        Keyboard.releaseAll();
        delay((TYPESPEED[0] * TYPESPEED[0] / 3) * 8);
    }
    return;
}
```

`nobackupkey` is 108 characters:

```
No Backup Key - Follow instructions here https://docs.crp.to/usersguide.html#secure-encrypted-backup-anywhere
```

At the default `TYPESPEED[0]` of 3 that is 48 ms per character; setup raises it
to 4, which is 80 ms. So the refusal takes **five to nine seconds to deliver**,
and the whole of it is spent inside `delay()` on the firmware's only thread.
`payload()` called `SoftTimer.remove(&taskKey)` before entering `backup()`, so
the main loop is not running either.

**The device answers NOTHING on the vendor interface for that whole window.**

## Two more things worth knowing about this path

**The refusal comes last, not first.** `backup()` walks all 61 slots and
assembles the entire plaintext backup into an 18 KB stack buffer BEFORE it looks
up the backup key. It has already typed `-----BEGIN ONLYKEY BACKUP-----` by
then. A host that sees the BEGIN marker has not been told the backup will
happen.

**`hidprint` still fires first**, so the reason does reach the host by name.
`device.captureBackup()` listens for it and rejects with
`Error no backup key set` rather than timing out, which is the correct
behaviour and is where this was found.

## How it was found

Measured, by adding `__e2e_tests__/8b-backup.e2e.js` and running the full
suite. The backup test failed by name, as it should have - and then the NEXT
suite, `cryptoSign`, failed twice with `no reply on interface 2 within 3000ms`
before recovering on its own. Vendor is interface 2. The suite after that was
fine, which is what says this is a window rather than a wedged device.

Nothing in the run said "the device is busy typing a URL at you". Deduction
would not have got here either; the cascade looked like the backup gesture
having damaged something.

Confirmed by draining: the suite now counts what the device is still typing
after the refusal, and reports **218 keyboard reports** - 109 characters as
press/release pairs, which is the URL plus its terminating NUL. With the drain
in place `cryptoSign` passes again, which is what says the silence was the
typing and nothing else.

## What the app does about it

Two things, both in `__e2e_tests__/8b-backup.e2e.js`:

1. **A device with no backup key SKIPS the digest test, with the reason.** It
   is not a failure - the firmware is behaving correctly - and it is not a pass,
   because the digest chain was never verified. This is the case the harness's
   `skip(reason)` was added for.
2. **The typed refusal is DRAINED before the suite returns**, by waiting for the
   keyboard interface to go quiet. Otherwise the next suite starts inside the
   window and fails for a reason that has nothing to do with it.

`BackupScreen` needs no change: it surfaces the named error, and a person
reading "no backup key set" is not also issuing vendor commands.

## What this is NOT

Not a reason to patch the firmware. The typed URL is a deliberate piece of user
guidance for the case this was designed around - a key plugged into a text
editor, with no app attached to read `hidprint` at all.
