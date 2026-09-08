# On-device suites, and why they are numbered

`test-moniker` generates `index.js` from `fs.readdirSync()` and runs the suites
in that order. Nothing else orders them — so the order is whatever the
filesystem returns, and on this project it *matters*:

| | suite | needs |
|---|---|---|
| 1 | `softKey` | nothing — it is the gate that proves the firmware runs at all |
| 2 | `buttonProbe` | the device **locked**: a press only announces its button number while locked (`payload()`), and once unlocked the same press types a slot instead |
| 3 | `deviceFlow` | the device locked, and it unlocks with the PIN |
| 4 | `ctapFlow` | the device **unlocked**: `okcore.cpp:639,651` drop FIDO packets silently otherwise, and `U2Finit()` only runs on unlock |

The numeric prefix makes that survive regeneration. Without it the order is
alphabetical — which put `ctapFlow` before `deviceFlow`, so `deviceFlow`'s
unlock test met an already-unlocked device and waited out its deadline for an
announcement the firmware only makes on the *transition*.

The suite names in the output come from the exported function, not the
filename, so the prefixes do not show up in a report.
