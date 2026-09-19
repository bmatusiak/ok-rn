# Proposal: a vendor message reporting firmware build provenance

**Status:** a request for comment, not a submitted patch. Nothing here has been
merged anywhere, and the design questions at the end are genuine.

**Who is asking and why:** we build an Android app that runs the OnlyKey
firmware as an emulated soft key, alongside real hardware over USB and BLE. Two
of the questions below are ours specifically, but the underlying problem —
a build cannot say which sources produced it — belongs to anyone flashing an
unsigned development build.

---

## The problem

A firmware build gives no way to identify which sources produced it.

`OKversionmaj` / `OKversionmin` / `OKversionpat` in `onlykey.h` have been
`3` / `0` / `4` since 2022, so a working-tree build and released v3.0.4 report
the identical status string:

```
UNLOCKEDv3.0.4-prodc
```

byte for byte.

The build keyword partly covers this. `-test` implies the development line and
`-prod` a release, and that inference has held so far. **But it holds only
while the development tree is built with `DEBUG` on.** A working tree built as
production is indistinguishable from the release it is ahead of — and building
that way is a normal thing to do when testing what users will actually run.

This is not hypothetical for us. We build the working tree as production to
test the shipping configuration, and the result reports itself as released
v3.0.4 while carrying the post-quantum work that is in no release.

### Why it matters beyond labelling

A host has to decide whether a key supports a feature before it offers it. With
no way to distinguish the lines, it must either offer features that fail at the
device, or hide features that are present.

Today we infer "development line" from the build keyword. The case above
defeats that inference, and there is no other signal on the wire.

---

## The request

A vendor message returning a short build identifier, empty on release builds.

### Message ID

`0x77` appears unused. `0x61`–`0x76` are allocated; `0x68`–`0x6B` are the
retired U2F IDs, which we have deliberately not reused in case an old host
still sends them.

```c
#define OKGETBUILD  (TYPE_INIT | 0x77)   /* 0x97 */
```

### A generated header

`okbuild.h`, committed with an empty default, so a release build is unchanged:

```c
#ifndef OKBUILD
#define OKBUILD ""      /* stamped at build time; empty means a release build */
#endif
```

### The handler

One case in the vendor dispatch in `okcore.cpp`:

```c
case OKGETBUILD:
    hidprint(OKBUILD[0] ? OKBUILD : "release");
    return;
```

`hidprint` already zero-fills the 64-byte report and sends the string's own
length, so the reply is an ordinary text line carried by every existing
transport path. No new framing, no new buffer, no change to any existing
message.

### Stamping

Entirely outside the firmware. A build script writes `okbuild.h` from
`git rev-parse --short HEAD`. An unstamped build compiles unchanged and answers
`"release"` — so forgetting to stamp degrades to current behaviour rather than
producing a false positive.

---

## Why not extend the version string

We tried this first. It is not viable, because the desktop app reads the model
letter two incompatible ways:

| Reader | How it reads the model letter |
|---|---|
| `checkForNewFW` | fixed index — `version.slice(11, 12)` |
| `setDeviceType` | last character — `version[version.length - 1]` |

Anything inserted *before* the model letter breaks the first. Anything appended
*after* it breaks the second. There is no position that satisfies both.

`OnlyKeyComm.js:1323` also calls `setDeviceType(msg)` on the raw report before
any split, so nothing may follow the version inside that report either.

A separate message leaves the status string untouched. We think that is the
right constraint regardless of what you decide about this proposal.

---

## Properties

- **Backward compatible.** New ID; existing hosts never send it. Release builds
  are byte-identical, because `OKBUILD` is empty and the branch is constant.
- **Forward compatible.** A host asking an older firmware gets whatever the
  dispatch's `default:` arm does today. Hosts bound the wait and treat any
  non-answer as `"release"`.
- **Not a secret.** On a release it reveals nothing. On a development build it
  is a commit hash of a public repository.
- **Small.** One `#define`, one generated header, one `case`.

---

## Questions

These are open, and we would rather match your preference than assume.

1. **Lock state.** Should this answer while the device is locked? It carries
   nothing sensitive, but unlocked-only is equally fine for our purposes.

2. **Format.** We would stamp two short hashes — `<firmware>/<libraries>` —
   since the sources live in two repositories. A single hash, or a build date,
   serves our purpose equally well.

3. **The ID.** `0x77` by inspection of `okcore.h`. Is it reserved for anything
   planned?

4. **`default:` behaviour.** What does an existing build do with an unknown
   message ID — answer an error, stay silent, or echo? It determines how hosts
   should time out when asking a firmware that predates this.

---

## If this is not wanted

No hard feelings, and nothing regresses. Hosts would continue inferring the
line from the build keyword, which is correct except for the production
working-tree case described above. We would carry the detection on our side for
our emulated key only, and a hard key flashed with a development build would
continue to report as the release it declares.

We are raising it because the fix looked small and general, not because we are
blocked.
