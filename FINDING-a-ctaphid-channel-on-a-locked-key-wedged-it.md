# A CTAPHID channel on a LOCKED key wedged its vendor interface

Found 2026-09-11, on the first run of the bench-key FIDO2 suite
(`__e2e_tests__/18-hardKeyFido.e2e.js`).

## What happened

The suite opened a CTAPHID channel before checking whether the key was
unlocked. The key was locked, announcing `INITIALIZED`, and the channel
request timed out:

```
no CTAPHID reply within 8000ms
```

That much is expected. FIDO dispatch is gated on `unlocked == true`
(okcore.cpp:639,651) and a locked device drops those packets with no error at
all, so a locked key is indistinguishable from a dead one on that interface.

What was not expected is what happened next. **The VENDOR interface stopped
working too**, and stayed broken across app restarts:

```
no reply on interface 2 within 3000ms          the FIDO suite, retried
write to vendor failed on usb                  15-hardKey, which had passed
the key is silent, not unlocked                15-hardKey's console probe
```

The key was still enumerated - four interfaces, `doctor.js` said "attached
(host mode)" throughout. It simply would not accept a write. Force-stopping
and relaunching the app did not clear it. Only an unplug and replug did.

## What is and is not established

ESTABLISHED: a locked key was sent CTAPHID_INIT; from that point its vendor
interface refused writes until it was physically replugged; a read-only suite
that had passed minutes earlier failed on a plain write; the replug fixed it
completely and `hardKey` went straight back to 8 passed, 0 failed.

NOT ESTABLISHED: that the CTAPHID packets CAUSED it. The sequence is
suggestive and it is the only unusual thing that happened, but this was one
occurrence and it has not been reproduced. It would be cheap to reproduce on
the SOFT key and expensive to reproduce on this one - a wedged bench key
costs a replug every time, and there is exactly one of it.

A plausible mechanism, offered as a hypothesis and nothing more: the packets
are dropped inside the receive loop rather than being consumed properly, and
something downstream - the packet buffer, the five-second wipe timer, the
transport response cursor - is left mid-state. `okcore.cpp:652-658` already
has an Android-specific branch that calls `RawHID.recv()` a second time, and
the suites already know that the first FIDO packet after an unlock is eaten by
it. That region is where I would look first.

## What changed

The suite unlocks through the key's serial console BEFORE it opens a channel,
and says why at the point it does so. Nothing in the library changed: a client
asking a locked key for a FIDO channel is not doing anything illegal, and
adding a guard that infers lock state in the host would be a second, inferred
copy of the device's own state - which is wrong the moment it disagrees.

## If this is chased later

Reproduce on the soft key first: boot it, leave it locked, send CTAPHID_INIT,
then try an ordinary vendor OKCONNECT. If the vendor interface goes quiet
there too, it is a firmware state machine bug worth a proper write-up and the
emulator makes it free to bisect. If the soft key shrugs it off, the next
suspect is the Android USB host layer rather than the firmware.
