# FINDING: uiautomator cannot dump a screen that never idles, and the runner read the old dump instead

**Measured:** 2026-09-10, bench phone (Pixel, Android 16), OnlyKey attached
over OTG, `node tools/e2e.js --only hardKey`.

## What happened

With a hard key attached the suite "just sat" in the Testing tab. Before the
runner had any tracing this looked like a hang inside the app. With tracing
it looked like this:

    · tapped "Testing" at 257,1364 after 2.4s
    · RUN TESTS is not on screen, swiping up (1/3)
    · RUN TESTS is not on screen, swiping up (2/3)
    · RUN TESTS is not on screen, swiping up (3/3)
    e2e: the Testing tab is open but neither RUN TESTS nor a running suite is
    on it … on screen: Close menu | Menu | … | Slots | Keys | Keyboard | …

A screenshot taken at that moment showed the Testing tab open, the drawer
closed, and RUN TESTS in the middle of the screen. The runner was describing
a screen from before its own tap.

Run by hand:

    $ adb shell rm -f /sdcard/ok-e2e-ui.xml
    $ adb shell uiautomator dump /sdcard/ok-e2e-ui.xml
    ERROR: could not get idle state.
    $ adb shell ls /sdcard/ok-e2e-ui.xml
    No such file or directory

## Why

`uiautomator dump` calls `waitForIdle` and needs about one second with no
accessibility content-change events before it will describe the window. It
gives up after ten seconds, prints the error above, and writes NOTHING.

The runner's `dumpUi()` ran the dump and then `cat` the file without looking
at what the dump said. When the dump failed, the file from the PREVIOUS
successful dump was still there, so every later step read the hierarchy the
screen had had before the last tap. Taps went to coordinates from that old
hierarchy; the "on screen:" list in the error was the old screen's labels.

The screen never idled because a locked OnlyKey broadcasts its status once a
second - five reports in a burst on the vendor interface - and both log hooks
(`useLog`, feeding the Log tab and the Testing tab's Traffic panel) called
`setState` per report. The Traffic panel's timestamps and `×N` counts changed
five times a second, forever. The soft key broadcasts too, but nothing on the
Testing tab rendered ITS traffic, so soft-key runs never hit this.

## Why nobody saw it

- The stale file was a valid dump of the right app, so nothing about it
  looked wrong; the labels it listed were real labels.
- The old runner's fallback branch reported "a run was already under way"
  when it found neither RUN TESTS nor a running suite, then polled logcat
  for the full 420 s budget. Nothing was printed in that time.
- The dump's error goes to stdout, which the runner discarded.

## What is fixed

- `tools/e2e.js dumpUi()` removes the old file first, reads what uiautomator
  said, retries up to three times, and otherwise THROWS naming the error - it
  can no longer return a stale hierarchy.
- `src/hooks/useLog.ts` queues arrivals and applies them at most every 2.5 s,
  so the screen has quiet windows longer than the second uiautomator needs.
  Nobody could read five updates a second anyway, and an accessibility
  service has the same requirement the runner does.
- The runner's "neither" branch throws instead of claiming a run is under way
  (done earlier in the same session), it waits for the app to be focused
  rather than asserting it the instant after launch, it scrolls for RUN TESTS,
  streams the suite's lines live, and fails after 90 s of silence naming the
  last thing the suite said.

## What is not fixed

Any other screen that repaints continuously will hit the same wall; the
runner will now say so ("the screen could not be read") rather than lie, but
it cannot read it. Keep that in mind when adding live panels.
