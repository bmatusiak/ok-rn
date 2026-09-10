# Pressing buttons on a LOCKED key spends PIN attempts, and enough of them wipe it

**Where:** any test or tool that presses while locked. `2-buttonProbe.e2e.js`
does it by design; a probe I added did it repeatedly and destroyed the bench
key's provisioning.
**Status:** Not a firmware bug. This is the device protecting itself, working
exactly as intended. It is recorded because the cost is invisible until it is
total.

## What happens

While locked, a button press appends a digit to the PIN buffer and the firmware
announces `password appended with N`. That announcement is the only observable a
press produces, which makes it the natural instrument for anything asking "did
the press land" — `2-buttonProbe` is built on it and is right to be.

**The buffer is not free.** Digits that do not amount to the PIN are a failed
attempt, counted in EEPROM across restarts:

```
Failed PIN attempts since last successful regular PIN entry
9
```

The counter resets only on a SUCCESSFUL unlock. At its limit the device wipes
itself back to unconfigured — no PIN, no slots.

## How it was learned

By doing it. A probe that pressed a button while locked was re-run about ten
times in a row while its assertions were being sharpened. Each run left a digit
in the buffer and each app restart committed the attempt. The counter was
visible in the output the whole time, in a line nobody was reading, and then:

```
status: UNINITIALIZEDv3.0.4-testc
```

Recovery was cheap because the suite provisions itself — `--only provision`
twice, since `initialized` is only recomputed at boot. Slot contents were gone.
Had this been a real key with real credentials, it would not have been cheap.

## Why the existing suite is safe and the probe was not

`2-buttonProbe` presses all six buttons once per run and is followed within the
same run by `3-deviceFlow`, which unlocks with the correct PIN and **resets the
counter**. The hazard is not pressing while locked; it is pressing while locked
**without ever unlocking afterwards**, which is precisely what `--only` on a
single early suite does.

## What to do instead

**Prefer an observable that costs nothing.** The debug console echoes
`I received from DEBUG: <first byte>` before acting on a line, and an
unrecognised byte does nothing else — so "is the console read?" can be answered
with no press at all. `2c-pressLine.e2e.js` was rewritten to do that and is now
side-effect free in either lock state.

**When a press while locked is genuinely required**, run it inside a sequence
that unlocks afterwards, and treat `--only <that suite>` as unsafe to repeat.

**Watch the counter.** It is printed on the console every time it changes.
Nothing reads it today; a host that presses while locked arguably should.
