# Setting a PIN only works on a DEBUG firmware build

**Severity:** was blocking for first-time setup on a release build
**Status:** RESOLVED — a production build provisions. The library no longer
waits on the debug console; it waits on the firmware's ungated `hidprint`
prompts and races the console only as a bonus. See "How it was resolved".
**Applies to:** OnlyKey firmware (`libraries/onlykey/okcore.cpp`), surfaced by
`node-onlykey-lib`'s `device.setPin()`

> **The analysis below is kept because it is still the correct description of
> the `Serial.println` channel and of why the original implementation could not
> work on a release.** What has changed is that the handshake no longer rides
> that channel. Do not act on the "what would fix it" section — it has been
> overtaken.

## The dependency

`setPin()` walks a six-step bracket with the firmware — arm, send the digits,
store, confirm, resend, commit — and each step waits for a specific prompt
before moving on (`plugins/device/index.js`, `PIN_SEQUENCE`):

| step | waits for |
|---|---|
| armed | `/Enter PIN/` |
| entered | `password appended with`, counted once per digit |
| stored | `/Storing PIN/` |
| confirming | `/Confirm PIN/` |
| re-entered | the same per-digit acknowledgements |
| committed | `/Both PINs Match/` |

**Every one of those prompts is `Serial.println` inside `#ifdef DEBUG`**
(`okcore.cpp:894-897`, `:912-914`, `:963-965`). On a release build the firmware
does the work silently, so the library waits out its ten seconds on the first
step and reports a timeout — against a device that is behaving perfectly.

The digits travel the same way. `pressLine()` writes them to `IFACE.SEREMU`
(`src/device/console.js:174-179`), which is the debug console — the same
interface that does not exist when `DEBUG` is undefined.

So both halves of provisioning ride a channel that is compiled out of a release
build.

## Somebody already noticed

`okcore.cpp:965-967`:

```c
        Serial.println("Both PINs Match");
        ...
        //hidprint("Both PINs Match");
```

The vendor-interface version of that prompt exists and is **commented out**.
Uncommenting it — and its siblings — would put the handshake on an interface
that survives a release build, which is what a host actually needs.

## Why it has not bitten

This project compiles the staged firmware with `DEBUG` defined by default, so
the prompts are there and setup works. That default is no longer the only
option: `OKEMU_PRODUCTION=1` stages a build with the gate off, and the suite has
been run against one. Provisioning is untested on that build for the reason this
finding describes. It was verified end to end on device: a factory
reset, then the app's own setup flow, and the six progress steps arrived in
order — `armed, entered, stored, confirming, re-entered, committed` — followed
by a device that came back provisioned and unlocked to the PIN just chosen.

The physical OnlyKey does not hit this either, because its PIN is set with the
buttons on the device rather than by a host.

It matters here because the phone IS the device: there are no physical buttons
to fall back on, so a soft key built for release has no way to be set up at
all.

## What would fix it

Either of, and neither belongs in this repo:

- **Uncomment the `hidprint` prompts** so the bracket is answerable over the
  vendor interface. Small, and the code is already written.
- **Accept the digits over the vendor interface** rather than the debug
  console, so `pressLine` is not needed for provisioning.

Until then, note it plainly: a release build of the soft key can run, unlock and
sign, but it cannot be given a PIN in the first place.

## Related

This finding used to say that the same boundary was why the PIN pad presses real
buttons rather than calling `device.unlock()` — that unlock had exactly this
dependency. **It no longer does.** `unlock()` takes an `enterDigits` strategy,
so a host that can press buttons gets a path that works on either build, and it
now refuses immediately with the real cause when the build has no console.

Provisioning still cannot use that trick, and that is the part that survives:
the PIN bracket is a CONVERSATION, not just digits. `runPinSequence` waits for
`Enter PIN`, `Storing PIN`, `Confirm PIN` and `Both PINs Match`, and those are
`Serial.print` calls inside `#ifdef DEBUG`. Sending digits is solvable by
pressing buttons; hearing the six prompts is not.

`session.capabilities.debugConsole` now detects which build is attached, so a
caller can at least KNOW before it tries.

## How it was resolved

The premise above is that the PIN handshake is only observable over
`Serial.println`. That was true of the code reading it, not of the firmware.

The firmware **also** announces each step with `hidprint`, on the vendor
interface, **ungated** — the same prompts, outside `#ifdef DEBUG`, identical in
all nine pinned versions. The commented-out `hidprint("Both PINs Match")` noted
above is the misleading one: its siblings for the steps that matter are live.

So `node-onlykey-lib` now watches the wire:

- `src/device/pin.js` carries `HID_PROMPTS` beside the console `PROMPTS` —
  `/ready, enter your/i`, `/Successful PIN entry/i`, `/re-enter your/i`,
  `/Successfully set PIN/i`.
- `plugins/device/index.js` `waitForStep()` **races** the HID prompt against
  the console one. On a debug build both arrive and the first wins; on a
  release only the HID one can, and that is enough.
- `committed` is the single step with no wire prompt. It waits on the console
  and **tolerates the timeout**, rather than holding a release build for ten
  seconds on a line that cannot arrive.

The digits no longer ride the console either. `pressLine()` still exists for
scripts on a debug build, but every caller that can press buttons passes
`enterDigits` instead, and the soft key's presses the pads directly.

## Verified

On device, 2026-09-18, a wiped soft key staged from the working tree with the
DEBUG gate **off** — the app's build line read `classic · working tree ·
production`:

- the app's own setup flow ran the bracket to completion, seven progress steps,
  `armed → entered → stored → confirming → re-entered → matched → committed`
- the device came back from the restart reporting `Log in` rather than
  `Set up this key`
- the chosen PIN unlocked it

`__e2e_tests__/0-provision.e2e.js` asserts that seven-step count and is the
automated counterpart.

## What this leaves

Nothing to do in the firmware, and the "what would fix it" options above are
moot — uncommenting the `hidprint` lines is unnecessary, because the prompts
the host actually needs were never gated.

The lesson worth keeping is the one that cost the time: **the channel the first
implementation happened to read was not the only channel the firmware speaks
on.** "Release builds cannot be provisioned" was a true statement about the
library and was recorded as a fact about the device.
