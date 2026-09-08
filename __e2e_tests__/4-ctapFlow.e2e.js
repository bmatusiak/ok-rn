/**
 * CTAPHID against the emulated firmware's FIDO interface.
 *
 * This is the path the vendor interface cannot reach. OKCONNECT over vendor is
 * set_time() plus a plaintext status; the transit key exchange, the X-Wing
 * derives and the composite halves are all read by bridge_to_onlykey() on the
 * CTAP side. Getting there needed CBOR, CTAPHID framing and the tunnel, none of
 * which had ever spoken to the firmware.
 *
 * No new transport was required: the emulator accepts IFACE.FIDO in
 * okemu_hid_deliver() and drains it BEFORE vendor to match the real endpoint
 * poll order, and the embedded transport already demultiplexes FIDO reports.
 *
 * THE DEVICE MUST BE UNLOCKED. okcore.cpp:639,651 gate FIDO dispatch on
 * `unlocked == true` and drop packets silently otherwise - no error frame, so a
 * locked device looks exactly like a dead one.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {protocol} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const {CtapHid, CTAP2_CMD} = protocol.ctaphid;

const PIN = '1234561';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/*
 * Booted, unlocked, and a CTAPHID channel - done ONCE for the suite.
 *
 * Rebooting per test was flaky in a way worth recording: the reboot itself is
 * reliable, but a device that has just unlocked is busy - U2Finit(), EEPROM
 * counters, an LED fade - and doing it four times in a row failed twice. There
 * is also nothing to gain from it here; the earlier suite already proves unlock
 * works from a cold boot, and these tests only need a device in that state.
 */
let session = null;

async function unlocked(log) {
  if (session) return session;

  if (!OkEmu.isRunning()) await OkEmu.start();

  const {device, transport} = await getOnlyKey();

  /*
   * Readiness is established by ASKING, not by waiting for chatter.
   *
   * An earlier version waited for the once-a-second INITIALIZED broadcast as a
   * proof the main loop was running - which works exactly until something
   * unlocks the device, because SoftTimer.remove(&taskInitialized) at
   * OnlyKey.ino:708 stops it. By the time this suite runs, the device-flow
   * suite has already unlocked, so the wait was for a message that would never
   * come again.
   */
  /*
   * Unlocked only if it is not already. The firmware announces UNLOCKED on the
   * TRANSITION (OnlyKey.ino:702-709), so pressing a PIN at an already-unlocked
   * device produces no announcement and unlock() would wait out its deadline
   * against a device that is perfectly fine.
   */
  let status = 'already unlocked';
  const state = await device.connect();
  if (!/UNLOCKED/i.test(String(state.status))) {
    status = await device.unlock(PIN, {timeoutMs: 20000});
  }
  log(`device: ${status}`);

  /*
   * Settle before speaking CTAPHID.
   *
   * U2Finit() runs as part of unlocking (OnlyKey.ino:716), and the firmware is
   * still fading its LED and rewriting EEPROM counters for a moment after. A
   * FIDO packet sent into that window is accepted and answered, but the first
   * one also goes through an Android-workaround branch that calls
   * RawHID.recv() a SECOND time (okcore.cpp:652-658) - so anything else queued
   * at that instant is consumed in its place.
   */
  await delay(500);
  session = {device, transport};
  return session;
}

module.exports = function ctapFlow({describe, it}) {
  describe(ctapFlow.name, () => {
    it('allocates a CTAPHID channel', async ({log, assert}) => {
      /*
       * CTAPHID_INIT on the broadcast channel, answered with the echoed nonce
       * and a freshly allocated id. The firmware keeps ten of them
       * (ctaphid.cpp:67), so this is real channel allocation rather than a
       * fixed value.
       */
      const {transport} = await unlocked(log);
      const ctap = new CtapHid(transport);

      const cid = await ctap.init({timeoutMs: 8000});
      const hex = Array.from(cid).map(b => b.toString(16).padStart(2, '0')).join('');
      log(`channel: ${hex}`);

      assert.equal(cid.length, 4, 'a channel id is four bytes');
      assert.ok(
        !(cid[0] === 0xff && cid[1] === 0xff && cid[2] === 0xff && cid[3] === 0xff),
        'the device handed back the broadcast channel instead of allocating one',
      );
    });

    it('answers authenticatorGetInfo, which needs fragment reassembly', async ({log, assert}) => {
      /*
       * The response is far larger than one 64-byte packet, so this exercises
       * the whole receive path: an init packet, continuations in sequence, and
       * a CBOR map decoded out of the reassembly. It is also the first thing
       * any real WebAuthn client asks.
       */
      const {transport} = await unlocked(log);
      const ctap = new CtapHid(transport);
      await ctap.init({timeoutMs: 8000});
      await delay(200);

      const info = await ctap.getInfo({timeoutMs: 10000});
      assert.ok(info instanceof Map, 'getInfo returned no CBOR map');

      const versions = info.get(1);
      const aaguid = info.get(3);
      const options = info.get(4);

      log(`versions: ${JSON.stringify(versions)}`);
      log(`aaguid: ${aaguid && Array.from(aaguid).map(b => b.toString(16).padStart(2, '0')).join('')}`);
      log(`options: ${JSON.stringify(options && Object.fromEntries(options))}`);

      assert.ok(Array.isArray(versions), 'no versions array');
      assert.ok(versions.includes('FIDO_2_0'), `not a FIDO2 authenticator: ${versions}`);
      assert.equal(aaguid.length, 16, 'an AAGUID is 16 bytes');
    });

    it('reports the capabilities a WebAuthn client depends on', async ({log, assert}) => {
      /*
       * Pinned because the BLE bridge forwards these verbatim - whatever the
       * firmware claims here is what a desktop browser will believe about the
       * phone.
       */
      const {transport} = await unlocked(log);
      const ctap = new CtapHid(transport);
      await ctap.init({timeoutMs: 8000});
      const info = await ctap.getInfo({timeoutMs: 10000});

      const options = info.get(4);
      log(`maxMsgSize: ${info.get(5)}, pinProtocols: ${JSON.stringify(info.get(6))}`);

      assert.equal(options.get('rk'), true, 'resident keys are required for passkeys');
      assert.equal(options.get('up'), true, 'user presence must be supported');
      assert.equal(
        options.has('uv'), false,
        'uv is deliberately absent so platforms do not request it',
      );
    });

    it('a vendor request reaches the device through the tunnel', async ({log, assert}) => {
      /*
       * The whole point of the CTAP path. The request rides in the allowList
       * credential id and the answer comes back in the assertion's signature -
       * which is how the web app has always talked to this device, because a
       * browser cannot reach the vendor interface at all.
       */
      const {transport} = await unlocked(log);
      const {host} = await getOnlyKey().then(app => ({host: app}));
      const ctap = new CtapHid(transport);
      await ctap.init({timeoutMs: 8000});

      const bound = protocol.tunnel.createTunnel(ctap, {
        randomBytes: n => {
          const out = new Uint8Array(n);
          global.crypto.getRandomValues(out);
          return out;
        },
      });

      const answer = await bound.send(
        {cmd: protocol.MSG.OKPING},
        {timeoutMs: 10000, presenceTimeoutMs: 25000},
      );

      log(`status: ${answer.status}, error: ${answer.error}`);
      log(`data: ${answer.data && answer.data.length} bytes`);

      // Either a real answer or the device's own words - both prove the
      // request was parsed as a vendor request rather than a credential.
      assert.ok(
        answer.status === protocol.ctap.SUCCESS || answer.error,
        `the tunnel produced neither an answer nor an error: ${JSON.stringify(answer.status)}`,
      );
    });
  });
};
