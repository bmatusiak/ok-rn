# One pinned release is the travel edition, and it looks like a broken device

**Severity:** high for the version matrix — staged as pinned, v2.1.1 cannot be
given a PIN at all, and nothing says why
**Status:** handled. The version script declares the build option it must be
staged with, and records that the commit itself is travel.
**Applies to:** `ok-versions.json`'s v2.1.1 pin, `libraries@0dc7cf0`

## What was measured

`onlykey.h` carries two build options, and at that commit both are commented
out:

```c
//#define DEBUG //Enable Serial Monitor
//#define STD_VERSION //Define for STD edition firmare, undefine for IN TRVL edition firmware
```

Every other pin in `ok-versions.json` is the standard edition:

| pin | DEBUG | STD_VERSION |
|---|---|---|
| v3.0.2 `5d7ce7a` | off | **on** |
| v3.0.1 `a27ffa6` | off | **on** |
| v3.0.0 `5515974` | off | **on** |
| v2.1.1 `0dc7cf0` | off | **off** |
| v2.1.0 `8687474` | **on** | **on** |

## Why it does not present as an edition difference

`STD_VERSION` gates `set_private`'s body, `U2Finit`, and the encrypted profile
itself — without it `profilemode` is `NONENCRYPTEDPROFILE` and a great deal of
the device's own code returns early.

The first thing that fails is provisioning, and it fails in a way that names
nothing:

```
armed
pressed 1 … pressed 1
✗ timed out after 10000ms waiting for 7x /password appended with/gi
  console tail: "…dy, enter your PIN"
```

The bracket armed, all seven presses went out, and the per-digit
acknowledgements never came — because those prints are inside the same gate.
The device is sitting there asking for a PIN it will not confirm receiving.

Three full runs produced no verdict at all before anyone looked at which
edition it was.

## What was done

`OKEMU_STD` was added as the mirror of the existing `OKEMU_DEBUG`, and
`gateDefine()` now reads or flips either option — a toggle rather than a text
patch, because the sources arrive on both sides of both defines and a patch
written for one silently misses the other.

v2.1.1's version script then DECLARES what it needs:

```js
gates: { std: true },
```

so the release is staged the same way whoever runs it, rather than depending on
somebody remembering an environment variable. `OKEMU_STD=0` still builds it as
pinned, for anyone who wants to measure the travel edition deliberately —
nothing else in the matrix covers that edition at all.

Staged as standard, **v2.1.1 passes 67 of 67**.

## What this does not settle

Whether the RELEASED v2.1.1 binary was standard or travel is not something this
repository can answer. The commit is travel; that is all that is known, and the
version script says exactly that rather than implying more.
