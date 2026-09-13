# v2.1.0 prints to the serial console on a production build

Found by the first production sweep of the whole matrix, on 2026-09-12. It is
an upstream defect in a shipped release, not a staging artefact, and v2.1.1 is
the commit that fixed it.

## What the suite saw

`12-identity` cross-checks two independent sources of the same fact: the
version keyword the device announces, and whether anything actually arrives on
SEREMU.

```
  status: "UNLOCKEDv2.1.0-prodc"
  build=production console=false
    ✓ the build is named, and it is one of the two that exist
  SEREMU traffic seen: true, build says console: false
    ✗ the console the build claims is actually there
```

Three runs, identical every time, and **on no other release in the sweep**.
v2.1.1, v2.1.2, the whole 3.0 line and both working-tree builds all agree with
themselves.

## Why it is upstream and not ours

The obvious objection is that we forced the DEBUG gate off on a release whose
own sources have it on - which is true, and not the explanation.

**v2.1.1 is the commit that added the guards.** Diffing the firmware sketch
between the two pins shows prints being wrapped that were previously bare:

```
+          #ifdef DEBUG
+          Serial.println("Generating Yubico OTP...");
-        Serial.println("Generating Yubico OTP...");
```

So in v2.1.0 those calls were never behind the gate. Turning DEBUG off does not
silence them, because they were never conditional.

**And the shipped binary had the gate off.** The bundled signed image for this
release declares its own version out of its string table:

```
Signed_OnlyKey_2_1_0_STD  ->  v2.1.0-prod
```

`-prod` is what the firmware composes when DEBUG is undefined
(`OKversionkeyword`). So the binary that went out to users was built with the
gate off, and these prints went out with it.

Upstream would not have noticed, because v2.1.0's committed sources have
`#define DEBUG` enabled - one of five pins out of nine that do. The tags do not
match the shipped build state, which is a finding in its own right and is why
this matrix stages every release as production.

## Why this matters beyond a red test

The project's working rule is the user's: *"using the debug console is
cheating"*, because it is a channel the product does not have. On v2.1.0 that
is not quite true - part of that channel shipped. A host talking to a real
v2.1.0 key can see firmware chatter that every other release keeps private,
and anything reading SEREMU to decide something would behave differently
against that one release.

Nothing in this app reads the console to decide a verdict any more, so the
practical blast radius here is one assertion. The reason to record it is that
it is a genuine information leak in a shipped security device, and the next
person to assume "production means no console" should find this first.

## Status

The assertion is CORRECT and stays. The firmware is wrong, so relaxing the
test would be recording a defect as absent. v2.1.0 is named as a known
exception in `12-identity`, citing this file, so the matrix reports the
release's real behaviour rather than hiding it.
