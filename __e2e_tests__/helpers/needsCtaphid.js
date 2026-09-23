/*
 * needsCtaphid.js - skip, rather than fail, once config mode has been taken.
 *
 * CONFIG MODE ENDS THE CTAPHID HALF OF A RUN. The firmware answers the vendor
 * interface from inside it and goes silent on CTAPHID (okcore.cpp:1362-1367
 * still replies UNLOCKED to OKCONNECT, which is why a connect proves nothing
 * either way), and it leaves only at a power cycle.
 *
 * The soft key has no power cycle to give. Its firmware thread exits through
 * the AIRCR trap alone, OkEmu.restart() rejects unconditionally, and
 * 1-softKey.e2e.js pins that refusal as a test so nobody re-adds a restart that
 * silently does nothing. The restart that DOES work is the app process
 * starting again, which the runner does between passes - so config mode is
 * terminal for the pass it was taken in, and that is the design, not a fault.
 *
 * Which makes a derive attempted afterwards unrunnable rather than broken.
 * Reporting it as a FAILURE says the firmware is wrong when the run is simply
 * over for that interface, and it bails the suites behind it - so a version
 * that is perfectly healthy reads as a red column.
 *
 * ## Why this is shared rather than written twice
 *
 * It is the THREE-PASS CONTRACT, stated once: a base pass shows what is not
 * set up, a config-mode pass sets it, and the pass after uses it. Every suite
 * on the CTAP path is subject to it, and 10-derive and 13-deriveParity both
 * proved it the expensive way - 10-derive first, and when that was guarded
 * alone the sweep simply bailed two suites later instead.
 *
 * Measured on a FRESH v3.0.2 storage slot: the first full pass failed 8 derives
 * and bailed; guarding 10-derive alone moved it to 2 failures bailing at
 * 13-deriveParity; guarding both is what makes the pass report skips and carry
 * on. The pass after it is green either way - the point is that the first one
 * stops lying about why.
 */
'use strict';

/**
 * Call after connecting, before anything that needs CTAPHID.
 *
 * `device` is passed rather than reached for, because each suite caches its own
 * connection - but they all resolve to the SAME device: getOnlyKey() is "one
 * app per backend, cached by backend" (ok-rn/src/onlykey.ts), so config mode
 * taken in 8c-backupPassphrase is visible here.
 */
function needsCtaphid(skip, device) {
  if (device && device.inConfigMode) {
    skip('something already took config mode this pass - CTAPHID is silent '
      + 'until the app restarts, so this runs on the next pass. What was set '
      + 'up persists in EEPROM.');
  }
}

module.exports = {needsCtaphid};
