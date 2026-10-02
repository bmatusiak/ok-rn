# FINDING: pqcSlots' config-mode hold is ignored on the first run, then passes on a rerun

**Status:** open, not root-caused. Recorded 2026-10-02 so it can't hide a real failure.
**Where:** `__e2e_tests__/14b-pqcSlots.e2e.js`, the test "enters config mode, which a slot write needs". **Soft key** (the Pixel), not a hard key.

## What happens
The test holds button 6 for the config-mode gesture (`device.enterConfigMode`, up to 3 holds through `OkEmu.holdTicks`). On the first run the key never locks, and the test fails with:

> the device never locked after 3 holds, so the config-mode gesture was not taken. A hold is ignored while the LED is fading and while pending_operation is set

Run again, `--only pqcSlots` onwards, and it passes.

## Seen twice
| Date | Run | First run | Rerun |
|---|---|---|---|
| 2026-09-28 | the version matrix, fresh storage slots (v3.1.0, v3.0.5) | failed at this step on both | passed |
| 2026-10-02 | full Pixel e2e, `edge` build (an existing slot, not fresh) | failed at this step after 97 passes | `--only pqcSlots,keyChainWrite,hardKey,…` 16 passed |

So it is not only a fresh slot. The common factor is that **pqcSlots runs after many other suites in the same app session**, and its first hold lands while the firmware is still busy.

## What is known
- The firmware ignores a hold while the LED fades (`isfade`) or while `pending_operation` is set. That is its own rule, not a bug: a press during a pending operation is a confirmation, not a gesture.
- An earlier suite can leave either one set: a sign, decrypt or derive that a test answered or timed out, whose 20-second fade window is still open when pqcSlots starts.
- A rerun starts with an idle key, which is why it passes.

## Why it matters
The step's failure text names the cause, but the run **bails** at pqcSlots, so the suites after it don't run. A real config-mode regression there would look exactly like this flake, and a rerun that passes would be read as "the flake again".

## Until it is fixed
- If pqcSlots fails at "enters config mode" **and** the message names the fade or the pending operation, rerun from pqcSlots. A pass is accepted, and the report names it as this FINDING.
- **Any other failure in that test, or a second failure on the rerun, is a real failure.**

## The fix to make (not done yet)
The soft key now exposes the firmware's own wait state (`OkEmu.waiting()` → `okemu_jni.cpp nativeConfirmState`: `CRYPTO_AUTH`, `isfade`, the opcode).
1. Before the first hold, **wait until the firmware is idle**: `isfade` clear and nothing waiting, with a deadline (about 25 s, longer than the 20 s fade), and fail naming what was still set.
2. When a hold is ignored, **log that state** (opcode, `CRYPTO_AUTH`, `isfade`), so the next failure says which earlier operation was still open.
3. Then find the suite that leaves it set, and make it end its own operation (answer it, or wait out its fade) - the real root cause.
