---
name: ok-rn-dev
description: Developing and testing the ok-rn app against the bench phone - the state check to run first, the e2e loop, Metro rules, bench-key safety, and how to keep tool output (the bill) small. Use whenever working in ok-rn/ or running anything on the phone.
---

# ok-rn: develop and test without going blind

Every rule here is paid for. The incident that bought it is in brackets.

## First, always: `node tools/doctor.js`

With more than one device on adb (a second phone, or the bench phone twice
over USB and wireless) every tool fails with "more than one device", and a
lost `adb reverse` shows up as a red box about loadJSBundleFromAssets. Set
`ANDROID_SERIAL=R5CW31M0WCB` (the bench Samsung) in the shell first, and
re-run `adb reverse tcp:8081 tcp:8081` if the app cannot reach Metro.

One screen: device, foreground app, Metro, stray processes, whether a key is
on the bus, the suite filter, the last verdict. Run it at the start of a
session, before any e2e run, and THE MOMENT anything "sits". Read-only, under
ten seconds.

- `--shot [path]` saves a screenshot; Read the PNG. A stall is diagnosed from
  the phone's screen first, the terminal second. [Two minutes of dots while
  the runner was on the wrong screen the whole time.]
- `--log [regex]` prints the last 40 matching logcat lines. Default filter:
  `Moniker|softkey|hardkey|okemu|ReactNativeJS|FATAL|AndroidRuntime`.
- Never run raw `adb shell dumpsys …` or `adb logcat -d` into the
  conversation. [One `dumpsys usb` is two thousand lines of thermal noise.]

Set `ANDROID_SERIAL` when more than one device is listed; doctor says so.

## Driving one screen: `node tools/tap.js`

    node tools/tap.js Menu "This Key"        tap labels in turn, then doctor --shot
    node tools/tap.js --scroll 3 "RUN TESTS" swipe up to find one below the fold
    node tools/tap.js --labels               what is on screen, tapping nothing

The runner's own tap with nothing around it, for checking a screen without
running the whole suite (which ends in a bundle reload). A missing label is
an error naming what IS there. Relaunch the app to pick up a source change
with `adb shell am force-stop com.okrn; adb shell am start -n com.okrn/.MainActivity`,
then `logwatch --until` for the line that proves the change loaded.

## Watching the phone while working: `node tools/logwatch.js`

Only the app's own process, only matching lines, and it ENDS on its own -
a plain `adb logcat` in a tool call shows nothing until the timeout.

    node tools/logwatch.js --until "OKCONNECT ok" --quiet 20   wait for one thing, or a stall
    node tools/logwatch.js --for 30 --filter "hardkey|usb"     a bounded look
    node tools/logwatch.js --follow                            never exits; one line per event

`--follow` is the **Monitor tool** shape. Arm it once, persistent, at the
start of hands-on device work:

    Monitor({command: 'node tools/logwatch.js --follow', persistent: true,
             description: 'ok-rn app events on the bench phone'})

Each event - suite start, every test verdict, the final count, pipe open or
close, OKCONNECT, firmware start or stop, and every failure signature (✗,
timeout, harness threw, FATAL) - arrives as a notification while other work
goes on. It survives an app restart (it re-adopts the new pid). Stop it with
TaskStop when the device work is done; do not leave two running.

## Metro

- One instance, port 8081, started by the user. NEVER start another. [A second
  Metro took the port, the first kept the phone, every bundle took 77 s.]
- Never edit `metro.config.js` to chase speed - it invalidates the transform
  cache and makes the next bundle a cold one. Revert with `git checkout`.
- Before killing anything, `doctor.js` lists strays. Metro's own jest-worker
  children are NOT strays; a jest-worker whose parent is a finished test run
  is. [Ten of those starved Metro for an afternoon.]

## Every wait has a deadline and names what it saw

- Size the Bash tool timeout to the row below, in the FOREGROUND, output
  visible. Never pipe a long run into a file or `grep` - it buffers and shows
  nothing until the end. [Told twice "I see nothing happening".]
- A poll without a deadline is a hang waiting to happen. A step that cannot
  find what it needs THROWS naming what it saw, it does not sleep.

| what | expect | tool timeout |
|---|---|---|
| bundle after a source change | ~2 s warm, ~60 s cold | 120 s |
| `node tools/e2e.js --only <suite>` | 30–120 s | 300 s |
| `npm run e2e:run` (full, debug build) | ~7 min | 600 s |
| `npm run e2e:matrix` | ~10 min per version | background + Monitor |
| lib `npm test` | ~40 s | 120 s |
| `npx tsc --noEmit -p .` | ~20 s | 120 s |
| `npx jest` | ~5 s | 60 s |

## The e2e loop

    node tools/e2e.js --only <suite>     while iterating
    npm run e2e:run                      full, before every commit

The runner traces each step (`· tapped "Testing"`), streams every `[Moniker]`
line as the phone logs it, and fails within 90 s of silence with
`stuck after: <last line>`. If it says the app is not on screen, it is not -
doctor `--shot` and look. Suite names are the `describe()` names
(`hardKey`, `derive`, …); a wrong one throws in the app.

Never chain a commit behind `e2e.js | grep …`: grep's exit code replaces
the runner's, and a red run was committed as green that way once. Use
`set -o pipefail` in the shell, or read the verdict from
`tools/.last-e2e.json` (`doctor.js` prints it) before committing.

No edits to `src/`, `App.tsx`, `__e2e_tests__/` or `node-onlykey-lib/`
while a run is in flight: Metro watches all of them and reloads the app
mid-suite. A full run edited underneath lost its hard key and left the soft
key in config mode for the suites that followed (2026-09-11). Research,
docs, tools and the skill are safe to touch; source waits for the verdict.

A suite that must never run unnamed (`hardKeyProvision` wipes the key)
arms itself in its first test and every later test skips when unarmed -
`skip()` ends one test, not the suite.

`__e2e_tests__/only.js` must read `[]` between runs. The runner resets it,
and doctor warns if it did not (a killed run on Windows runs no handlers).

## Bench-key safety

A press on a LOCKED hard key is a PIN attempt; ten wipe it. [FINDING #43 -
the bench key was wiped by a probe that pressed.] Ask the console with
`device.consoleAnswers()` - inert byte, echo - never with a press. The
runner's `--only` keeps a probing suite from re-running the rest.

## Before commit

lib `npm test` → `npx tsc --noEmit -p .` → `npx jest` → full `e2e:run` →
`only.js` is `[]` → a FINDING file exists for anything found, fixed or not.
Commit as work lands; one commit per repo.

## Keep the context small - it is the bill

- doctor rows and `.last-e2e.json` are one-line answers; prefer them to any
  command whose output must be scanned.
- Read a range when the part is known (`sed -n 240,300p`); read a file once;
  never re-read to verify an edit.
- `--only <suite>` to check one change; the full suite once, before commit.
- The runner already prints the suite's lines and the verdict; do not `cat`
  logcat afterwards to see them again.
- Batch independent reads in one message - each round trip re-sends the whole
  conversation.
- Screenshot when diagnosing a stall or confirming a screen change, not on
  every step; an image costs more than a trace line.
