# A key can be loaded only in config mode, cannot be used in it, and config mode never ends

**Severity:** high for the Keys screen — three constraints that compose into a
flow no single session can complete
**Status:** open — upstream firmware behaviour, worked around in the e2e suite
**Applies to:** upstream — `okcore.cpp:161,347,452`, `OnlyKey.ino:914-926`

## Three facts that only matter together

**1. `OKSETPRIV` requires config mode.**

```c
case OKSETPRIV:
    if ((initialized && unlocked && FTFL_FSEC == 0x44 && integrityctr1 == integrityctr2 && configmode == true)
        || (initialized && unlocked && !initcheck))   // okcore.cpp:452
```

There is no `else`. A key write outside config mode on a provisioned device is
**silently dropped** — no acknowledgement, no error, nothing on any interface.
The first symptom is a later operation reporting `Error no ECC Private Key set
in this slot`, which reads as a failure of the *signing* path.

**2. Entering config mode locks the device.**

```c
} else if (duration >= 72 && button_selected == '6' && !isfade) {
    configmode = true;
    unlocked = false;               // OnlyKey.ino:914-926
    password.reset();
```

So the PIN has to be re-entered before the key write it was entered *for* will
be accepted.

**3. Config mode does not end, and forbids the thing you loaded the key for.**

`configmode` is assigned `false` exactly once in the entire firmware — at its
definition (`okcore.cpp:161`). Nothing turns it off; only a restart clears it.
And `recvmsg`'s config-mode allowlist (`okcore.cpp:347`) permits `OKCONNECT`,
`OKSETSLOT`, `OKSETPRIV`, `OKRESTORE`, `OKFWUPDATE`, `OKWIPESLOT`,
`OKWIPEPRIV`, `OKGETLABELS` and the three PIN messages — **but not `OKSIGN` or
`OKDECRYPT`**, which are refused with a `Serial.println` and nothing on the
vendor bus.

## What that composes into

Loading a signing key and using it **cannot happen in one firmware lifetime**:

```
hold button 6 (>=72 ticks)   ->  config mode, device locks
enter PIN                    ->  unlocked, still in config mode
OKSETPRIV                    ->  "Successfully set ECC Key"
OKSIGN                       ->  refused; not on the config-mode allowlist
restart                      ->  config mode clears
enter PIN                    ->  now it will sign
```

On hardware the last step is unplugging the key, which is presumably why this
has never read as awkward. On a phone the firmware's lifetime is the app's, so
"restart" means restarting the app.

## Measured, not inferred

`__e2e_tests__/9-cryptoSign.e2e.js` provisions on one invocation and signs on
the next, because that is the shape the device imposes. Both halves were
observed:

- provisioning run — `holding button 6 for 80 ticks`, then the device locked,
  then after the PIN: `Successfully set ECC Key`;
- signing run — `slot 101: holds a key`, `signature: 64 bytes`, and the same
  payload signed twice produced byte-identical signatures.

The plugin's own header had predicted a different obstacle entirely (framing and
response handling). Those were real too, but this one was not predicted by
anybody and is the one that shapes the UI.

## What the app has to do about it

Phase B2 (Keys) cannot present key import as a single action. It has to:

1. say that importing a key will lock the key and require the PIN again;
2. perform the config-mode hold itself — `holdTicks(6, 80, {allowGesture: true})`
   is the only sanctioned use of the gesture band in this codebase;
3. re-unlock;
4. write the keys;
5. **restart the firmware** before anything can use them, and say so rather
   than leaving the user with keys that appear absent.

Step 5 is the awkward one: in-process firmware restart does not work yet (it is
the third leftover in the plan), so today it means restarting the app. That is
worth stating in the UI rather than discovering.

A smaller point with the same shape: while in config mode the press band
dispatch is disabled (`if (duration <= 20 && !configmode)`), so slots cannot be
typed either. Config mode is a much bigger state change than "you may now write
keys".
