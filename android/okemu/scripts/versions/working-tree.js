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

  patches: [],

  /**
   * Applied only when the DEBUG gate ends up OFF - here, only under
   * OKEMU_PRODUCTION=1.
   *
   * This edit is in the version script rather than stage.js's shared list
   * because the line it patches DOES NOT EXIST in any release:
   * `git show 5d7ce7a:fido2/device.cpp` has no appid_match3 at all. The
   * OnlyAgent origin check is newer than v3.0.2, so a shared patch carrying it
   * would fail to apply to every pinned version.
   *
   * Same defect as its two siblings in stage.js's DEBUG_OFF_PATCHES:
   * webcryptcheck() dereferences a pointer its callers hand it as NULL, and
   * only the #ifdef DEBUG early return kept a debug build from noticing. See
   * FINDING-production-firmware-crashes-in-webcryptcheck.md.
   */
  debugOffPatches: [
    /*
     * The OKCONNECT branch's null buffer, in the spelling this tree uses -
     * with the derived-key challenge clause that arrived in v3.0.2. Every
     * release before that spells the same line without it, which is why the
     * two live side by side in _shared.js.
     */
    shared.okconnectBufferGuardWithChallengeMode,
    {
      file: 'libraries/fido2/device.cpp',
      edits: [
        ['\tint appid_match3 = memcmp (stored_appid_oa, _appid, 32); //OnlyAgent origin (onlyagent.app)',
         '\tint appid_match3 = (_appid == NULL) ? 1 : memcmp (stored_appid_oa, _appid, 32); //OnlyAgent origin (onlyagent.app)'],
      ],
    },
  ],
};
