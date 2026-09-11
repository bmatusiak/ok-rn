/**
 * Wait until the emulator's LED has stopped signalling "pending".
 *
 * The firmware IGNORES A PRESS while its LED is fading after an operation -
 * a slot write, a label read - and while pending_operation is set after a FIDO
 * ceremony (device.enterConfigMode's own error text says the same). A press
 * sent in that window types nothing, which reads as "the key typed nothing at
 * all". 7-pressBands measured this first and waits the same way; the
 * keystroke suite pressed straight after a slot write and typed nothing on a
 * DUO, where the fade is long enough to matter (a Classic got lucky with the
 * suites that happen to run in between on a full run).
 *
 * Yellow is the pending colour. Clear for 1.2 s means the firmware is back in
 * its idle loop and will read the next press.
 */
'use strict';

const delay = ms => new Promise(r => setTimeout(r, ms));

async function waitForLedClear(OkEmu, log, {timeoutMs = 30000} = {}) {
  const seen = [];
  const off = OkEmu.on('led', pixels => {
    const at = Date.now();
    for (const packed of pixels) {
      seen.push({r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff, at});
    }
    while (seen.length > 600) seen.shift();
  });
  const started = Date.now();
  try {
    const isPending = px => px.r > 64 && px.g > 64 && px.b < 64;
    const deadline = Date.now() + timeoutMs;
    let clearSince = Date.now();
    while (Date.now() < deadline) {
      await delay(250);
      const recent = seen.filter(px => Date.now() - px.at < 400);
      if (recent.some(isPending)) clearSince = Date.now();
      else if (Date.now() - clearSince > 1200) break;
    }
    if (log) log(`led settled after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    off();
  }
}

module.exports = {waitForLedClear};
