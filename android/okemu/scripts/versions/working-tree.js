'use strict';

/**
 * The working tree - what stage.js builds when OKEMU_VERSION is unset.
 *
 * Not a release, and its own script for exactly that reason. Everything else
 * here is pinned to a commit in ok-versions.json; this one is whatever
 * OnlyKey-Firmware and libraries happen to be checked out at, which is the
 * generation ahead of the newest release. Without a script for it, every edit
 * the current sources need and no release does would have had to live in
 * stage.js as an unexplained special case.
 *
 * ## It keeps the unnamed storage slot
 *
 * `slot: ''`, so its flash.bin and eeprom.bin stay in files/okemu exactly where
 * they have always been. That is load-bearing rather than tidy: moving them
 * would strand the provisioned device on every phone that already has one, and
 * nothing re-provisions itself.
 *
 * ## DEBUG is ON here and OFF in every release
 *
 * onlykey.h:81 is `#define DEBUG` in this tree and `//#define DEBUG` at v3.0.2.
 * The difference is upstream's, not ours - somebody left the switch on while
 * working. It is why the soft key can be given a PIN at all by default, and why
 * a pinned release needs OKEMU_DEBUG=1 before it can be.
 */
const shared = require('./_shared');

module.exports = {
  version: 'working-tree',
  status: 'tested',
  slot: '',

  notes: [
    'Whatever the checkouts are at. The full e2e suite runs against this.',
    'Ships with the DEBUG gate ON, unlike every release.',
  ].join('\n'),

  /**
   * The sketch's own yield() collides with the emulator's, and the emulator's
   * has to win.
   *
   * OnlyKey.ino gained `void yield(void) {}` upstream to override the Teensy
   * core's weak one, whose only job there is polling Serial1/2/3 for
   * serialEvent hooks the firmware never defines - a reference that linked all
   * three UART drivers, about 4 KB of flash the device does not have to spare.
   * On a Teensy a no-op is exactly right.
   *
   * Hosted it is not. core/okemu_pins.cpp defines yield() as
   * okemu_sync_systick(), which is what advances the millisecond counter on a
   * build with no SysTick interrupt behind it. Every delay() and every poll
   * loop in the firmware reaches time through that call, so a no-op yield()
   * stops the clock rather than merely saving space. The core file is ours and
   * lands in the same archive, so the two definitions are a hard link error -
   * `duplicate symbol: yield` - and not something that silently picks a winner.
   *
   * Dropping the sketch's copy costs the device nothing here: the bare-metal
   * UART drivers are among the 31 files stage.js already removes, so there is
   * no weak yield() left to override and nothing for it to pull in.
   *
   * Version-scoped rather than shared because no pinned release has this line
   * - it arrived with the OnlyKey.ino rewrite in OnlyKey-Firmware@1f7e726.
   */
  patches: [
    {
      file: 'sketch/OnlyKey.ino',
      edits: [
        ['void yield(void) {}',
         '/* yield() dropped by ok-rn stage.js - core/okemu_pins.cpp defines the real one, which keeps the hosted millisecond counter moving; see versions/working-tree.js */'],
      ],
    },
  ],

  /*
   * APPID_NULL_GUARD's line is gone, because UPSTREAM FIXED IT.
   *
   * That guard existed because webcryptcheck() compared a caller's `_appid`
   * against the trusted origin hashes without checking it for NULL, and
   * ctap.cpp's add_existing_user_info() passes NULL on every allowList
   * credential of every getAssertion. libraries@c1a6cf2 ("webcryptcheck(): do
   * not compare a NULL appid against the trusted hashes", 2026-09-22) rewrote
   * the whole comparison as
   *
   *     if (_appid && memcmp(trusted[t].hash, _appid, 32) == 0) origin_ok = 1;
   *     else if (memcmp(trusted[t].name, rpid, trusted[t].namelen) == 0) ...
   *
   * which is null-safe by construction and takes the same position ours did -
   * the name comparison is the answer on that path. `stored_appid`,
   * `appid_match1`, `appid_match2` and the per-origin variables are all gone
   * with it.
   *
   * Declared absent rather than dropped from the shared list, because every
   * PINNED release still has the old spelling and still needs the guard.
   * stage.js throws if this line ever comes back, so the claim cannot go stale
   * and leave the tree unpatched.
   */
  absentPatterns: [
    '	appid_match2 = memcmp (stored_appid, _appid, 32);',
  ],

  /**
   * NONE LEFT. Upstream fixed every defect this list guarded against.
   *
   * All three entries existed because webcryptcheck() and the OKCONNECT
   * dispatch branch dereferenced pointers their callers hand over as NULL, and
   * only the `#ifdef DEBUG` early return kept a debug build from noticing -
   * see FINDING-production-firmware-crashes-in-webcryptcheck.md. Between
   * libraries@8d77e34 and @7bd29a4 the maintainer closed all of them:
   *
   *   appid_match3 / stored_appid_oa   gone with the origin itself.
   *                                    libraries@e44ff6c drops onlyagent.app;
   *                                    the trusted origins are now a `trusted[]`
   *                                    table of apps.crp.to and apps.onlykey.io.
   *   okconnectBufferGuard...          the whole `buffer[4]==OKCONNECT` branch
   *                                    is out of fido2/device.cpp; OKCONNECT is
   *                                    handled on the raw-HID path instead.
   *   appid_match1 / stored_apprpid    libraries@c1a6cf2 rewrote the comparison
   *                                    as a null-safe loop over `trusted[]`.
   *                                    Declared below rather than deleted,
   *                                    because it lives in stage.js's SHARED
   *                                    list and every pinned release still
   *                                    needs it.
   *
   * Each was verified as fixed, not merely re-spelled, before being dropped. A
   * guard removed because its anchor moved would be a guard silently lost.
   */
  debugOffPatches: [],

  /**
   * See the note above: this one is stage.js's, so the working tree declares it
   * absent instead of deleting it. stage.js throws if it reappears.
   */
  debugOffAbsentPatterns: [
    '    appid_match1 = memcmp (stored_apprpid, rpid, 12);',
  ],
};
