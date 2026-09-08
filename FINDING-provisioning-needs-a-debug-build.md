# Setting a PIN only works on a DEBUG firmware build

**Severity:** blocking for first-time setup on a release build
**Status:** open — works today because this project builds the firmware with
`DEBUG` defined; nothing here can fix it without changing firmware
**Applies to:** OnlyKey firmware (`libraries/onlykey/okcore.cpp`), surfaced by
`node-onlykey-lib`'s `device.setPin()`

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

This project compiles the staged firmware with `DEBUG` defined, so the prompts
are there and setup works. It was verified end to end on device: a factory
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

The same `#ifdef DEBUG` boundary is why the app's PIN pad presses real buttons
through `okemu_set_button()` rather than calling `device.unlock()` — unlock has
exactly this dependency, and pressing real buttons sidesteps it. Provisioning
cannot use that trick, because the bracket is a conversation and not just
digits.
