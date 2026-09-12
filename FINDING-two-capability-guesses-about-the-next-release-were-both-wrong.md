# Two capability boundaries guessed one release ahead, and both releases arrived

## What happened

Adding v3.0.3 and v3.0.4 to the matrix produced the same five failures on each,
all in the `derive` suite:

```
✗ a vault blob sealed on this device opens again
    -> the device did not answer this derive
✗ a sealed credential survives being stored and read back      (same)
✗ an export carries sealed blobs and imports back              (same)
✗ the X-Wing key type returns its split-custody pair
    -> pk_X and the ML-KEM seed are the same bytes
✗ an age file encrypted to the device is read back by it
    -> invalid tag
```

Nothing is wrong with those firmwares. Two capability fields in
`node-onlykey-lib/src/device/version.js` claim things about them that are not
true, and both claims were written as explicit guesses about a release that
did not exist yet.

## The first: touchFreeDerive

```js
if (rel.patch === 2) return 'broken';
return 'preference';        // anything after v3.0.2
```

The comment above it is careful about what was measured and clear about where
it stops:

```
 *   v3.0.2            the check was ADDED, against derived_key_challenge_mode
 *                     - a RAM cache of an EEPROM byte that the raw-HID
 *                     pipeline zeroes on every done_process_packets() ...
 *   after v3.0.2      the same check, reloading the byte from EEPROM first,
 *                     so the preference works as intended.
```

"After v3.0.2" was the guess. Measured now, on both releases that came after:

| firmware | claims | actually |
|---|---|---|
| v3.0.2 | broken | broken |
| v3.0.3 | preference | **broken** |
| v3.0.4 | preference | **broken** |

The check was run with the preference ALREADY WRITTEN, so this is not a
provisioning artefact. `cryptoSign` set it during the sweep -
`Writing derived_key_challenge_mode to EEPROM...` - and a later run against
that same EEPROM still logs `pressed button 1 for the derive (keepalive)` for
every derive and still answers nothing at all to a touch-free one.

The consequence is precisely the one the field exists to prevent. The vault is
told the preference will work, enables it, derives with the press flag clear,
and gets no answer - where on v3.0.2 it is told `broken` and refuses up front,
naming the firmware.

## The second: postQuantum

```js
postQuantum: atLeast(info.release, [3, 0, 3]),
```

This one says out loud that it is a bet, and what to do when it loses:

```
 * THE THRESHOLD IS A GUESS ABOUT THE FUTURE, and deliberately the
 * pessimistic one. v3.0.2 is the newest release measured to lack all of
 * it, so anything at or past v3.0.3 is treated as having it. If 3.0.3
 * ships without post-quantum support this flag is wrong in the direction
 * of offering too much, and the fix is to raise the number here once
 * there is a release to measure.
```

3.0.3 shipped without it. So did 3.0.4. The X-Wing and age tests skip cleanly
on v3.0.2 - "KEYTYPE_XWING does not exist before v3.0.2" - and on v3.0.3 and
v3.0.4 they run and fail, because the flag says the key type is there.

## Why the fix is not just raising the number

The obvious repair is `atLeast([3, 0, 5])` and `patch <= 4 -> 'broken'`. It
does not work, for a reason this repository already knows:

**THE DEVELOPMENT TREE ALSO CALLS ITSELF 3.0.4.** `OKversionpat` has not been
bumped since 2022-11-30, so released v3.0.4 and the current working tree -
which has post-quantum, and whose touch-free derive works - report the same
major, minor and patch. Any threshold that makes released 3.0.4 correct makes
the bench key wrong, fading post-quantum on a key that has it and making the
vault refuse a device that can open it.

The only other thing in the version string is the build keyword, `-prod`
against `-test`. On real hardware that separates them: a released key is
`-prod` and a developer key is `-test`. It does NOT separate them here,
because the matrix stages every pinned release with `OKEMU_DEBUG=1` - a
release cannot be provisioned otherwise - so released v3.0.4 reports
`v3.0.4-testc`, character for character what the bench key reports.

So the version string cannot answer either question for 3.0.4. Something else
has to: probing the device, or the emulator reporting which sources its `.so`
was built from, which it knows and the version string does not.

## Not fixed

Both flags are left as they are, deliberately, because every repair changes
what the app does on the bench key and that is a decision rather than a typo.
The two entries are recorded at their measured rung with these five failures
named in their notes, so the matrix states the disagreement instead of hiding
it.

What is now certain and was not before: no released firmware has post-quantum
support, and no released firmware has a working touch-free derive. Both were
inferences from a boundary. Both are measurements.

## Measured

`node tools/matrix.js v3.0.4 v3.0.3` - each three runs, each ending
`60 passed, 5 failed, 3 skipped`, bailing after `derive`. Then v3.0.4 rebuilt
alone and `--no-bail --only derive` run against the EEPROM the sweep had
already written the preference into, reproducing all five.
