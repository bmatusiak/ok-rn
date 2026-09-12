# "Unknown" was read as "no console", and it refused the devices it was for

## What happens

v0.2-beta.8 boots, answers OKCONNECT, and reports `UNINITIALIZEDv0.2-beta.8c`.
Provisioning then refuses before sending anything:

```
✗ has a PIN, or sets one and asks to be run again
  -> this firmware has no debug console, so the PIN bracket has nothing to
     answer it - stage the version with OKEMU_DEBUG=1
```

It was staged with `OKEMU_DEBUG=1`. The console is there: other tests in the
same run print its output, including `Sending transport response data` and
`or you must set a PIN first on OnlyKey`.

## Why

`0-provision.e2e.js` gates on the capability:

```js
assert.equal(caps && caps.debugConsole, true, 'this firmware has no debug console…')
```

`debugConsole` has THREE values, and its own comment in
`src/device/version.js` says what the third one means:

```
 *   null   firmware older than the keyword
 *
 * null is UNKNOWN, not false. The console may well be there, and treating
 * unknown as absent would disable PIN provisioning on every old device -
 * exactly the population this work exists to support.
```

It is derived from the prerelease tag: `-test` means debug, `-prod` means
production, anything else is unknown. The 3.0 line encodes it, so every
version the suite had been run against answered true or false and the third
case never came up. `v0.2-beta.8` predates the convention - its prerelease
tag is `beta.8`, which says nothing about the build - so it is the first
device to arrive as null, and `assert.equal(null, true)` refused it.

The assertion was written to catch a production build, which genuinely cannot
be provisioned: the bracket is a conversation held entirely in `Serial.println`
and a production build compiles those out. That case is still worth catching
early, because the alternative is a message about the PIN possibly being wrong
fifteen seconds later. But it is the FALSE case, not the not-true case.

## The fix

Refuse on false, attempt on null:

```js
assert.notEqual(caps && caps.debugConsole, false, …)
```

An unknown build tries the bracket. If the console really is absent it fails
at the first prompt with its own timeout, which is a worse message than the
early one but an accurate one - and it is the only way a firmware older than
the `-test` keyword can ever be provisioned at all.

## Why it is worth a file

The library got this right and said so in a comment, and the caller three
directories away flattened three values into two. That is the failure mode a
tri-state invites, and the way it presented - "no debug console" about a
device whose console output was visible in the same log - is the kind of
message that sends somebody to check the build flags for an hour.

## Measured

`node tools/matrix.js v0.2-beta.8`: three runs, all exit 2, all refused at
the same assertion, with console output from that same device quoted in the
failures underneath it.
