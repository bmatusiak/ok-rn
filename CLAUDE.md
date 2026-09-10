

the goal of the mobile app
-------------

the goal is to bring  the web-app  and desktop-app  into a mobile app, with the same features and functionalities, and to provide a better user experience for mobile users. allowing air-gapped(airplane mode) usage, and to provide a secure environment for users to manage their data and perform tasks without relying on internet connectivity.

it also acts as a bluetooth HID device, allowing mobile to use emulated onlykey firmware to send keystrokes to type passwords, and to provide a webauthentication feature for users to securely log in to websites and applications without the need for passwords.


the plan is to create a new lib that contain the core functionality for the firmware. alowing GUIs to use the firmware.
1 lib, any GUI ( nwjs-desktop, react-native-mobile, nodejs-cli, browser-web ).  this will live in "node-onlykey-lib" repo, and will be used by all GUIs.  this will allow for a single source of truth for the firmware functionality, and will allow for easier maintenance and updates.


the main focus is to test the firmware functionality, and to ensure that it works as expected across all GUIs.  this will be done by creating a set of e2e tests that will test the firmware functionality, and will be run against all GUIs.  this will allow for faster development, and will ensure that the firmware functionality is working as expected across all GUIs.


past versions of the firmware to be detected using a matrix, and need to create their own stage patches so it can be loaded into mobile app and tested to ensure the firmware functionality is working as expected for older firmwares.  this will allow for legacy hardware to be supported, and will ensure that the older firmware functionality is working as expected across all GUIs.

helping rules
--------------

if possible , run the e2e test you need for faster development, then a full e2e test suite before commit.

write only in `ok-rn/` and `node-onlykey-lib/`. every other checkout listed
below is a READ-ONLY reference, including the firmware. read their git history
freely; never change their working trees.

the firmware is used as close to original as possible. anything it needs in
order to run hosted is patched into a throwaway `.stage/` copy by
`android/okemu/scripts/stage.js`, and each patch records what it would have
been upstream. patch to make the firmware RUN, not to improve it or change its
protocol - a behaviour change needs asking first.

write a FINDING file for each bug found - `ok-rn/FINDING-<what-happened>.md`.
say what was measured, what caused it, why nobody saw it, and what is fixed.
findings for things that are NOT fixed are worth just as much; say so plainly.

commit as work lands, without being asked.

running the tests
--------------

    cd node-onlykey-lib && npm test          # pure, no device, seconds
    cd ok-rn && npx tsc --noEmit -p . && npx jest
    cd ok-rn && npm run e2e:run              # on-device, all suites, ~2.5 min
    cd ok-rn && npm run e2e:run -- --only derive,deriveParity

`--only` takes suite function names and restores itself afterwards, so a full
run is what happens by default. a name that matches no suite is an error rather
than an empty pass.

set `ANDROID_SERIAL` when more than one device is attached. the runner
force-stops the app, so the firmware restarts from `flash.bin`/`eeprom.bin` -
device state persists between runs, preferences included.

a suite should work when run ALONE. suites 10+ used to inherit an unlocked
device from suite 3, which made `--only` useless for them.

the e2e harness's assert is `ok`, `equal`, `notEqual` and nothing else.
`assert.match` and `assert.deepEqual` fail as "undefined is not a function"
pointing at the assertion line, which reads as though the thing under test is
broken.

a press helper that answers ONE keepalive cannot cover two device operations -
extra presses type a slot, so it goes quiet after the first. build fresh press
options per operation.

the bench device state
--------------

`files/okemu/flash.bin` and `eeprom.bin` ARE the device. the suite expects one
already provisioned - PIN `1234561`, a signing key in slot 101, the touch-free
derive preference set - and NOTHING RE-PROVISIONS ITSELF. delete that directory
and every suite strands at "the device did not unlock within 20000ms", which
reads like a broken PIN path rather than an empty key.

restoring it is copying the two files off a phone that still has them:

    adb -s <good> exec-out run-as com.okrn cat files/okemu/flash.bin > flash.bin
    adb -s <bad> push flash.bin /data/local/tmp/flash.bin
    adb -s <bad> shell chmod 666 /data/local/tmp/flash.bin
    adb -s <bad> shell run-as com.okrn cp /data/local/tmp/flash.bin files/okemu/flash.bin

in git bash, prefix each adb call with `MSYS_NO_PATHCONV=1` or `/data/...` is
rewritten into a windows path.

an imported state is not the same state. the touch-free derive preference may
be off, and the suite turning it on mid-run leaves the device in config mode
where CTAPHID goes silent for the rest of the run - six timeouts and no cause
named. run the suite a second time; the byte persists
(FINDING-enabling-touch-free-derive-mid-run-kills-ctaphid.md).

firmware versions
--------------

    npm run e2e:matrix                            # build and run EVERY release
    node android/okemu/scripts/stage.js --list    # what OKEMU_VERSION accepts
    node android/okemu/scripts/version-probe.js   # do the patches still match?
    OKEMU_VERSION=v3.0.2 OKEMU_DEBUG=1 npm run android

one stage script per release lives in `android/okemu/scripts/versions/`, and it
is where that release's own patches and its measured status go. status is a
ladder - blocked, untried, stages, builds, boots, tested - and each rung is
something somebody watched happen. see that directory's README.

a RELEASE SHIPS WITH THE DEBUG GATE OFF and cannot be given a PIN at all, so
every pinned version needs `OKEMU_DEBUG=1`. `OKEMU_STD=1` is the same lever for
the standard-vs-travel edition; v2.1.1's commit is the travel one and its script
declares `gates: {std: true}` so nobody has to remember.

a fresh version needs THREE runs: one to set the PIN (the device reports its old
state until it boots again), one where cryptoSign takes config mode for the
signing key and the preference, and then a green one. matrix.js does that.

switching versions leaves a stale `android/okemu/.cxx` that links new sources
against old objects - it presents as undefined symbols in a build that worked
minutes earlier. matrix.js deletes it; delete it by hand if you switch by hand.


writing tests that can actually fail
--------------

the recurring failure here is a test that passes against a WRONG answer. it has
happened at least three times, and each time the test checked a length, or that
a value was stable, or round-tripped with the device half stubbed out. a
wrong-but-deterministic secret passes all three.

so check a value against something computed INDEPENDENTLY of the code under
test. `__e2e_tests__/13-deriveParity.e2e.js` is the pattern: it holds its own
scalar and computes the ECDH itself, and it caught a peer key that had been
framed wrongly for as long as the feature had existed.

hermes is not node. `TextDecoder`, `TextEncoder` and `Buffer` are absent, so a
library passing 500 node tests can still throw on the phone. a test for a hermes
hazard DELETES the global first - see `test/vault.test.js`.

old firmware branches must be reachable from a FIXTURE, a string in and a
decision out, because the emulator is built from current firmware and CI can
only ever prove the current generation. anything needing an old device to
exercise is in the wrong layer.

firmware behaviour that keeps costing time
--------------

this firmware refuses by SAYING NOTHING, and several of its statuses name the
wrong cause. when something "times out", suspect a refusal:

* `CTAP2_ERR_EXTENSION_NOT_SUPPORTED` usually means an EEPROM preference bit is
  clear, not that the feature is missing
* `CTAP2_ERR_USER_ACTION_PENDING` means "ask again later", not "press a button"
* a locked device DROPS fido packets silently - there is no error frame
* entering config mode LOCKS the device, and unlocking while in it is never
  announced; poll for it rather than waiting for a broadcast
* the REQ_PRESS derive variants derive a DIFFERENT KEY rather than gating the
  same one, so retrying with a press is not a fallback
* counted button presses with no idle gap between them MERGE, durations summing
* a gesture is ignored while the LED is still fading from the last press

read the FINDING files before re-deriving any of this; most of it is already
written down in them.


important projects
--------------

* ok-app-rewrite = moder rewrite for onlykey-app, under development by another maintainer
* ok-rn = react-native mobile app
* OnlyKey-App = the onlykey-app, this is the desktop app, contain firmware api logic for setup and management of the onlykey device
* onlykey.github.io = the web-app,  contains fido2 logic and tools using ctap2 protocal
* node-onlykey-lib = the javascript functionality API for the firmware, allowing GUIs to use the firmware
* node-onlykey-emulator = the javascript emulator for the firmware, showing us how to emulate the firmware on a device*linux only
* OnlyKey-Firmware & libraries = firmware source code and libraries, written in C, for the onlykey device, this is the source code for the firmware that runs on the onlykey device
* onlykey-testing = new testing kit for the firmware using the node-onlykey-emulator, *linux only
* ok-versions.json = firmware releases, each pinning a `libraries` and an `OnlyKey-Firmware` commit; the input to the version matrix

when a value has to match another client, the ORACLE is `onlykey-testing/test/`
and the two reference apps - not our own expectations. inventing a vector and
asserting against ourselves is how the wrong values shipped in the first place.


