# Finding: a DUO on v3.0.2-v3.0.4 is asked for challenge buttons it does not have

**Status:** measured in the firmware sources at the pins `ok-versions.json`
names, and reproduced as a test failure on the first DUO build of a pinned
release. Deterministic.
**Severity:** a DUO running any of three SIGNED releases, including the newest,
cannot complete about seven of every eight signing or decryption requests. Fixed
already in the maintainer's master, so it affects shipped firmware only.
**Found by:** adding `v3.0.4-duo` to the version matrix. Twelve columns existed
and eleven were classic; `working-tree-duo` is built from master, which has the
fix, so no shipped release had ever been exercised as a DUO here.

## Summary

`okcore_prime_user_confirmation()` derives the three challenge buttons from a
SHA-256 over the request payload:

```c
Challenge_button1 = (temp[0]  % 6) + '0' + 1;
Challenge_button2 = (temp[15] % 6) + '0' + 1;
Challenge_button3 = (temp[31] % 6) + '0' + 1;
```

A DUO has three buttons, not six, so the function carries a branch:

```c
if (onlykeyhw==OK_HW_DUO) {
    Challenge_button1 = (temp[0]  % 3) + '0' + 1;
    ...
} else {
    ... % 6 ...
}
```

**That branch is missing from v3.0.2, v3.0.3 and v3.0.4.** Those releases take
`% 6` unconditionally, so a DUO displays digits in 1..6 while its user has
buttons 1, 2 and 3. A challenge is answerable only when all three digits happen
to land in 1..3, which is 1/8 of the time.

## Where it is, per pin

Read at the commits `ok-rn/ok-versions.json` pins for `libraries`, and in the
staged trees under `ok-rn/android/okemu/.stage-src/<version>/`.

| release | libraries pin | `if (onlykeyhw==OK_HW_DUO)` in the challenge |
|---|---|---|
| v2.1.0 | `159c0f2` | present |
| v2.1.1 | `0fe8d3a` | present |
| v2.1.2 | `12eb5b0` | present |
| v3.0.0 | - | present |
| v3.0.1 | - | present (`v3.0.1-prod:okcore.cpp:7122`) |
| **v3.0.2** | `5d7ce7a` | **absent** |
| **v3.0.3** | `a133bea` | **absent** |
| **v3.0.4** | `c8804e3` | **absent** |
| master | - | present (`okcore.cpp:7913-7920`) |

Not an artefact of reading the wrong function: `v3.0.1-prod:onlykey/okcore.cpp`
contains 27 references to `OK_HW_DUO` and `v3.0.2-prod` contains 26. The one
that went missing is this branch. `OK_HW_DUO` itself is unchanged across the
window - it is the same `SIM_SDID_PINID == 9` check that was called `OK_GO`
until v2.1.2 renamed it.

## Why it went unnoticed

The challenge digits are never transmitted. The device shows them on its own
display and the host recomputes them from the same bytes, so a mismatch has no
distinguishing symptom: the window closes after 20 seconds and the firmware
prints `Error incorrect challenge was entered`, which is the same string it
prints for a genuinely wrong press.

A user hitting this sees a key that mostly does not work, with no indication
that the digits being displayed are unpressable.

## What did NOT change

- **`OK_HW_DUO` and its detection.** Same constant, same value, same
  `SIM_SDID_PINID` check, across every release in the table.
- **The hash, the byte offsets and the digit count.** `temp[0]`, `temp[15]`,
  `temp[31]`, three digits, in all of them.
- **The 20-second window** and the press-to-`CRYPTO_AUTH` progression -
  `Usertimeout` is 20000 ms at `okcore.cpp:174-176` throughout.
- **Classic hardware is unaffected** in every release. The `else` arm is the
  one that survived.
- **Nothing in the wire protocol.** The digits are a local computation on both
  sides; no message carries them.

## What a host can do about it, which is not much

Nothing repairs the device's own display. A host can only predict the digits the
device will ACTUALLY ask for, so that the two agree and the press lands:
`node-onlykey-lib`'s `capabilities().challengeFormula` returns `'modern'` for a
DUO across this window rather than `'duo'`. Predicting `% 3` there would make
the host wrong as well, and both being wrong produces the same
`Error incorrect challenge was entered` with nothing to say which side caused
it.

That makes the key usable only to the extent that the user can press what is
displayed - it does not make digits 4, 5 and 6 pressable.

## Measurement

    v3.0.4-duo   83 passed, 0 failed, 54 skipped

with `12-identity.e2e.js` asserting the window explicitly. Before the capability
was made version-aware, that suite failed on this column with
`three buttons means mod 3` - reproducibly, on three consecutive runs.

The column is new: `node tools/matrix.js v3.0.4-duo`, which builds the v3.0.4
pins with `OKEMU_MODEL=duo` into its own storage slot.
