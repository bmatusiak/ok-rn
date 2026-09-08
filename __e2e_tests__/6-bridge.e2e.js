/**
 * The CTAP2 bridge, against the real firmware.
 *
 * This is the JS half of "browser -> phone -> firmware": a whole CTAP2 message
 * in, a whole CTAP2 response out. The BLE half is Kotlin - reassembling
 * Control Point writes and fragmenting the answer back - and it cannot be
 * exercised without a central, so what is checked here is everything between
 * the two.
 *
 * Worth having on device rather than only against the fake, because the fake
 * cannot get the two things wrong that matter: it never produces a response
 * too large for a BLE fragment, and it never makes anyone wait for a finger.
 *
 * THE DEVICE MUST BE UNLOCKED - okcore.cpp:639,651 drop FIDO packets silently
 * otherwise - so this runs after the device-flow suite.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {protocol} = require('node-onlykey-lib');

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

const {createCtapBridge, BRIDGE_STATUS} = protocol.bridge;
const {CTAP2_CMD} = protocol.ctaphid;
const cbor = protocol.cbor;

const delay = ms => new Promise(r => setTimeout(r, ms));

/** A whole CTAP2 message, as it arrives off the BLE Control Point. */
function message(cmd, params) {
  return params === undefined
    ? Uint8Array.of(cmd)
    : new Uint8Array([cmd, ...cbor.encode(params)]);
}

const fill = (n, b) => new Uint8Array(n).fill(b);

function makeCredentialParams() {
  return new Map([
    [1, fill(32, 0x24)],
    [2, new Map([['id', 'bridge.test'], ['name', 'bridge e2e']])],
    [3, new Map([['id', fill(16, 0x02)], ['name', 'e2e'], ['displayName', 'e2e']])],
    [4, [new Map([['alg', -7], ['type', 'public-key']])]],
  ]);
}

let shared = null;
async function bridged(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();

  const {device, transport} = await getOnlyKey();
  const state = await device.connect();
  log(`device: ${String(state.status).trim()}`);

  const bridge = createCtapBridge(transport, {
    log: (level, text) => log(`  [bridge] ${text}`),
    timeoutMs: 10000,
    presenceTimeoutMs: 25000,
  });
  shared = {bridge, status: String(state.status)};
  return shared;
}

module.exports = function bridgeFlow({describe, it}) {
  describe(bridgeFlow.name, () => {
    it('carries getInfo through and answers with the real thing', async ({log, assert}) => {
      const {bridge, status} = await bridged(log);
      assert.ok(/UNLOCKED/i.test(status), 'the device is locked; FIDO packets are dropped');

      const response = await bridge.handle(message(CTAP2_CMD.GET_INFO));

      log(`status 0x${response[0].toString(16)}, ${response.length} bytes`);
      assert.equal(response[0], 0x00, 'the device refused getInfo');

      /*
       * Decoded HERE, in the test, and never by the bridge. The point of the
       * assertion is that the bytes the bridge forwarded are a real getInfo
       * from the firmware rather than the empty CBOR map ('00a0') the screen
       * used to reply with to every command - which a browser reads as an
       * authenticator that supports nothing.
       */
      const info = cbor.decode(response.subarray(1));
      log(`versions: ${JSON.stringify(info.get(1))}`);
      assert.ok(info.get(1).includes('FIDO_2_0'), 'not a FIDO2 getInfo response');
      assert.equal(info.get(3).length, 16, 'no AAGUID');
    });

    it('the response is longer than a BLE fragment, which is the whole bug', async ({
      log,
      assert,
    }) => {
      /*
       * The reason the pacing fix matters, stated as a measurement.
       *
       * A default ATT MTU is 23 bytes, leaving 20 for payload and 17 after the
       * three-byte CTAP BLE init header. respondToRequest() used to fire every
       * fragment in a loop, and Android permits ONE outstanding notification -
       * so a host received the first 17 bytes of this and nothing more, on the
       * very first thing any browser asks.
       */
      const {bridge} = await bridged(log);
      const response = await bridge.handle(message(CTAP2_CMD.GET_INFO));

      const DEFAULT_MTU_PAYLOAD = 20;
      const fragments = Math.ceil((response.length - (DEFAULT_MTU_PAYLOAD - 3)) /
        (DEFAULT_MTU_PAYLOAD - 1)) + 1;

      log(`${response.length} bytes = ${fragments} fragments at a 23-byte MTU`);
      assert.ok(
        response.length > DEFAULT_MTU_PAYLOAD,
        'getInfo fits in one fragment here, so this device cannot show the bug',
      );
      assert.ok(fragments > 1, 'expected a multi-fragment response');
    });

    it('a ceremony completes when the press arrives during the keepalive', async ({
      log,
      assert,
    }) => {
      /*
       * End to end through the bridge: a makeCredential that blocks for a
       * finger, the keepalive relayed the way it would be to a browser, and a
       * press answering it. This is exactly the sequence a real registration
       * takes, minus the radio.
       */
      const {bridge} = await bridged(log);

      /*
       * Same split as the presence suite: with a client PIN set, CTAP2 refuses
       * a makeCredential that carries no pinUvAuthParam, and the bridge's job
       * is to carry that refusal back rather than to hide it.
       */
      const infoResp = await bridge.handle(message(CTAP2_CMD.GET_INFO));
      const hasPin = cbor.decode(infoResp.subarray(1)).get(4)?.get('clientPin') === true;
      log(`clientPin: ${hasPin}`);

      if (hasPin) {
        const refused = await bridge.handle(
          message(CTAP2_CMD.MAKE_CREDENTIAL, makeCredentialParams()),
        );
        log(`status 0x${refused[0].toString(16)} (0x36 = PIN_AUTH_INVALID)`);
        assert.equal(refused.length, 1, 'a refusal carries no body');
        assert.equal(
          refused[0], 0x36,
          'expected CTAP2_ERR_PIN_AUTH_INVALID from a PIN-protected key',
        );
        return;
      }

      const relayed = [];
      const response = await bridge.handle(message(CTAP2_CMD.MAKE_CREDENTIAL, makeCredentialParams()), {
        onKeepAlive: async status => {
          relayed.push(status);
          if (status === 0x02) {
            await delay(300);
            await OkEmu.pressButton(1, 150);
          }
        },
      });

      log(`keepalives relayed: ${relayed.map(s => '0x' + s.toString(16)).join(', ')}`);
      log(`status 0x${response[0].toString(16)}, ${response.length} bytes`);

      assert.ok(relayed.length > 0, 'the host was never told to wait');
      assert.equal(response[0], 0x00, 'the ceremony did not complete');

      const credential = cbor.decode(response.subarray(1));
      const authData = credential.get(2);
      const flags = authData[32];
      log(`fmt: ${credential.get(1)}, flags: 0x${flags.toString(16)}`);

      assert.equal(flags & 0x01, 0x01, 'user presence was not asserted');
      assert.equal(flags & 0x40, 0x40, 'no attested credential data');
    });

    it('an unknown command comes back as the device error, not as silence', async ({
      log,
      assert,
    }) => {
      /*
       * A bridge that throws leaves a BLE host waiting on a notification that
       * never comes, which it resolves only by its own timeout - minutes. An
       * error byte is a worse answer than a credential and a far better one
       * than nothing.
       */
      const {bridge} = await bridged(log);
      const response = await bridge.handle(message(0x63));

      log(`status 0x${response[0].toString(16)}, ${response.length} bytes`);
      assert.ok(response.length >= 1, 'no response at all');
      assert.notEqual(response[0], 0x00, 'a bogus command reported success');
      assert.notEqual(
        response[0], BRIDGE_STATUS.TIMEOUT,
        'the device said nothing - this should be its own error, not a timeout',
      );
    });
  });
};
