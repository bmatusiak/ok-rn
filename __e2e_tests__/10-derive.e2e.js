/**
 * Does the OKCONNECT key exchange actually work against the firmware?
 *
 * This is the exchange every DERIVED secret rides on - the web app's per-site
 * "password generator", the vault's AES key, and the device half of an X-Wing
 * age identity are all the same call with a different key type. The okcrypto
 * plugin reported `deriveXwing: false` for exactly one reason: "the OKCONNECT
 * key exchange it rides on is not written yet".
 *
 * It is written now, and this is the part that cannot be unit-tested. Three of
 * its details were transcribed from a JavaScript reference rather than derived
 * from the firmware, and each one fails silently if it is wrong - a bad transit
 * key, a bad IV or a bad counter block all decrypt to noise that is
 * indistinguishable from a key:
 *
 *   the AES key is sha256 of the box secret, not the box secret
 *   the response carries NO GCM TAG, so it is a CTR stream
 *   the IV is twelve zero bytes
 *
 * So "it returned 65 bytes" is not the assertion. DETERMINISM is: the same
 * label must derive the same key twice, and two labels must differ. Noise
 * passes the first test and fails the second.
 *
 * EVERY DERIVE HERE ASKS FOR THE PRESS VARIANT, and that is not a stylistic
 * choice. The non-press actions are gated on an EEPROM bit:
 *
 *     okeeprom_eeget_derived_key_challenge_mode(&derived_key_challenge_mode);
 *     if (!(is_bit_set(derived_key_challenge_mode, 3))) {
 *         ret = CTAP2_ERR_EXTENSION_NOT_SUPPORTED;   // ok_extension.cpp:263
 *
 * so on a key that has not had "derived keys per site without touch" turned on
 * they are refused outright - with a status that reads like the firmware does
 * not support the feature at all. DERIVE_PUBLIC_KEY_REQ_PRESS skips that check
 * and asks for a finger instead, which is a device setting this test should
 * not be depending on.
 *
 * THE DEVICE MUST BE UNLOCKED. bridge_to_onlykey() is on the CTAP path, and
 * U2Finit() only runs once the PIN is accepted (OnlyKey.ino:716) - so on a
 * locked key there is no FIDO interface to reach at all.
 */
'use strict';

const {getOnlyKey} = require('../src/onlykey');
const {pressDigits} = require('./helpers/pressDigits');
const {enableTouchFreeDerive} = require('./helpers/touchFreeDerive');

/** The same PIN every suite provisions and uses. */
const PIN = '1234561';

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

/** P-256 is the only key type the derive pair really uses. */
const P256R1 = 1;

/** An uncompressed P-256 point: 0x04 and two 32-byte coordinates. */
const P256_LEN = 65;

/**
 * Press when the device asks - or, on older firmware, before it can ask.
 *
 * A derive can demand user presence even when DERIVE_PUBLIC_KEY is asked for
 * rather than DERIVE_PUBLIC_KEY_REQ_PRESS - the device has its own derived-key
 * challenge setting, and it wins.
 *
 * HOW the device asks is a version difference, and it is the whole reason this
 * takes a capability (node-onlykey-lib/src/device/version.js, presenceTest):
 *
 *   'keepalive'  the 3.0 line. The request returns CTAP2_ERR_PROCESSING while
 *                it waits, the host keeps polling, and a press answered from
 *                inside the keepalive completes it. Pressing from the keepalive
 *                is right here because the device only starts watching its
 *                buttons once the ceremony is under way.
 *   'blocking'   the 2.1 line. ctap_user_presence_test(5000) BLOCKS for five
 *                seconds and then denies. There is no keepalive to answer, so
 *                a press that waits to be asked never happens and the derive
 *                comes back CTAP2_ERR_OPERATION_DENIED - which reads like a
 *                refusal rather than like nobody having touched it.
 *
 * So on 'blocking' firmware the press goes out on a TIMER, shortly after the
 * request. Measured on v2.1.0: without it every press-required shared-secret
 * derive failed while the touch-free derives beside them passed.
 *
 * The timer is armed unconditionally on that firmware and the press is still
 * guarded by `pressed`, so a keepalive arriving first wins and only one press
 * is ever sent. An extra press on an unlocked device types a slot.
 */
function pressing(log, capabilities = null) {
  let pressed = 0;
  let timer = null;

  const press = async (why) => {
    if (pressed) return;
    pressed += 1;
    await OkEmu.pressButton(1);
    log(`pressed button 1 for the derive (${why})`);
  };

  if (capabilities && capabilities.presenceTest === 'blocking') {
    /*
     * Inside the device's five seconds and after the request has reached it.
     * Pressing sooner than the ceremony starts is a press the firmware
     * discards, which costs the whole window.
     */
    timer = setTimeout(() => { void press('timer - this firmware does not keepalive'); }, 900);
  }

  const blocking = Boolean(capabilities && capabilities.presenceTest === 'blocking');

  return {
    get count() { return pressed; },
    done: () => { if (timer) clearTimeout(timer); },

    /*
     * Called by the device on keepalive firmware, and by the LIBRARY on a
     * retry - `{retry: true}` says which.
     *
     * The budget of one press is per CEREMONY, and a retry is a new one.
     * Measured on v2.1.1: attempts 2 and 3 of a derive went out with no press
     * at all, because this helper had already spent its press on attempt 1
     * and nothing told it otherwise
     * (FINDING-blocking-presence-fails-a-second-shared-secret.md).
     *
     * Re-armed only on BLOCKING firmware. Where the device keepalives, this
     * hook is called repeatedly for one ceremony and the guard is the whole
     * point of it - an extra press on an unlocked key types a slot.
     */
    onKeepAlive: async (info = null) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (blocking && info && info.retry) {
        /*
         * RE-ARM THE TIMER, do not press now.
         *
         * The library calls this BEFORE it issues the retry, so a press here
         * lands before the ceremony has started - which is the press the
         * firmware discards, and it costs the whole five-second window. The
         * first attempt waits 900ms for exactly that reason and a retry is no
         * different.
         *
         * Measured: pressing immediately on retry put a press in the log for
         * attempts 2 and 3 and changed nothing about whether they succeeded.
         */
        pressed = 0;
        timer = setTimeout(
          () => { void press(`retry - attempt ${info.attempt}`); }, 900);
        return;
      }
      await press('keepalive');
    },
  };
}

const hex = bytes =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

let shared = null;
async function connected(log) {
  if (shared) return shared;
  if (!OkEmu.isRunning()) await OkEmu.start();

  /*
   * Wait out the pending-operation window before the first derive.
   *
   * The suite before this one runs a FIDO ceremony, and the firmware leaves
   * pending_operation set for up to twenty seconds afterwards
   * (FINDING-presses-discarded-after-a-fido-ceremony.md). While it is set an
   * OKCONNECT lands in ok_extension.cpp's RETRIEVE branch rather than its
   * derive branch and comes back CTAP2_ERR_USER_ACTION_PENDING - which reads
   * like "press a button" and is actually "ask again later".
   */
  await new Promise(r => setTimeout(r, 22000));

  const {device, okcrypto} = await getOnlyKey();
  let state = await device.connect();

  /*
   * UNLOCK IF IT IS NOT ALREADY, rather than assuming an earlier suite did.
   *
   * Every derive is on the CTAP path, and U2Finit() only runs once the PIN is
   * accepted (OnlyKey.ino:716) - on a locked key there is no FIDO interface to
   * reach at all. This suite used to inherit an unlocked device from
   * 3-deviceFlow, which is fine in a full run and useless when running this
   * file on its own with `--only derive`. A suite that only works in position
   * is a suite nobody iterates on.
   *
   * Conditional because the firmware announces UNLOCKED on the TRANSITION
   * (OnlyKey.ino:702-709), so entering a PIN at an already-unlocked device
   * produces no announcement and unlock() waits out its deadline against a
   * device that is perfectly fine.
   */
  if (!/UNLOCKED/i.test(String(state.status))) {
    log('locked - entering the PIN first');
    await device.unlock(PIN, {timeoutMs: 20000, enterDigits: pressDigits({log})});
    state = await device.connect();
  }

  log(`device: ${String(state.status).trim()}`);

  /*
   * EVERY DERIVE ATTEMPT IS LOGGED, not just the ones that fail.
   *
   * The library retries a derive up to three times on "did not answer this
   * derive", and until it announced them a log could not tell an attempt that
   * went out unpressed from one that was pressed and denied anyway. Counting
   * `pressed button 1` lines against the tests around them is how that was
   * guessed at, and the count did not add up
   * (FINDING-blocking-presence-fails-a-second-shared-secret.md).
   *
   * Attached once, on the shared device, so it covers every test below.
   */
  okcrypto.on('progress', e => {
    if (e.step !== 'derive') return;
    log(`derive attempt ${e.attempt}/${e.attempts}`
      + (e.label ? ` for ${JSON.stringify(e.label)}` : ''));
  });

  shared = {device, okcrypto, status: String(state.status)};
  return shared;
}

/*
 * EVERY DERIVE HERE RIDES THE FIDO2 VENDOR PATH, WHICH IS ORIGIN-GATED.
 *
 * ok_extension.cpp:137 wraps the whole OnlyKey extension - OKCONNECT, the
 * derives, the tunnel - in `if (webcryptcheck(_appid, client_handle))`, and
 * webcryptcheck compares the request's rpId against `stored_apprpid`. When the
 * origin does not match, the branch is skipped and the device answers
 * nothing - which surfaces here as "the device did not answer this derive".
 *
 * A debug build returns "trust all origins" before comparing, so this suite
 * passed on every release for as long as the matrix forced that gate on. Under
 * the production default it failed, on firmware that was behaving correctly,
 * because the library was sending an origin no release has ever carried.
 *
 * It sends `apps.crp.to` now - byte-identical in `stored_apprpid` at all nine
 * pins from 2019 to HEAD - so this guard reads true everywhere and skips
 * nothing. It stays because it is the thing that broke: if the origin moves
 * again, this suite steps aside by name instead of reporting nine derives that
 * the device never heard.
 *
 * THE ORIGIN IS ALSO PART OF WHAT IS DERIVED, and that is deliberate. A site
 * asking with its own hostname gets its own keys from the same slot - the
 * firmware has a mode for exactly that. So every expectation below is bound to
 * the origin the library sends, not just permitted by it.
 * ok-rn/FINDING-the-vendor-path-is-origin-gated.md
 */
function needsVendorOrigin(skip) {
  const caps = shared && shared.device && shared.device.capabilities;
  if (caps && caps.vendorOrigin === false) {
    skip('this firmware does not accept the origin this library derives under');
  }
}

module.exports = function derive({describe, it}) {
  describe(derive.name, () => {
    it('the plugin offers the derive pair at all', async ({log, assert, skip}) => {
      const {okcrypto} = await connected(log);
      needsVendorOrigin(skip);
      log(`KEYTYPE.P256R1 = ${okcrypto.KEYTYPE.P256R1}`);
      assert.equal(typeof okcrypto.derivePublicKey, 'function');
      assert.equal(typeof okcrypto.deriveSharedSecret, 'function');
      assert.equal(okcrypto.KEYTYPE.P256R1, P256R1);
    });

    it('derives a public key for a label', async ({log, assert, skip}) => {
      const {okcrypto, status} = await connected(log);
      needsVendorOrigin(skip);
      assert.ok(
        /UNLOCKED/i.test(status),
        'the device is locked, so there is no FIDO interface to derive over',
      );

      const press = pressing(log, shared && shared.device && shared.device.capabilities);
      const result = await okcrypto.derivePublicKey('e2e.example', {
        keytype: P256R1,
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: press.onKeepAlive,
      });

      log(`status: ${JSON.stringify(result.status)}`);
      log(`payload: ${result.payload.length} bytes`);
      log(`public key: ${hex(result.publicKey).slice(0, 32)}...`);

      assert.equal(result.publicKey.length, P256_LEN);
      assert.equal(
        result.publicKey[0], 0x04,
        'an uncompressed P-256 point starts with 0x04; anything else is noise',
      );

      /*
       * The status is the device saying who it is, decrypted. Getting this
       * back in readable ASCII is itself proof that the transit key, the IV
       * and the counter block are all right - noise does not spell UNLOCKED.
       */
      assert.ok(
        /UNLOCKED/i.test(result.status),
        `the decrypted status was ${JSON.stringify(result.status)}, which means ` +
          'the transit key or the cipher framing is wrong',
      );
    });

    it('the same label derives the same key twice', async ({log, assert, skip}) => {
      /*
       * The assertion that separates a working exchange from noise. Every call
       * uses a FRESH transit keypair, so the ciphertext differs each time; if
       * the decryption is right the plaintext underneath is identical, and if
       * it is wrong these are two unrelated random strings.
       */
      const {okcrypto} = await connected(log);
      needsVendorOrigin(skip);

      const first = await okcrypto.derivePublicKey('e2e.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive});
      const again = await okcrypto.derivePublicKey('e2e.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive});

      log(`first: ${hex(first.publicKey).slice(0, 24)}...`);
      log(`again: ${hex(again.publicKey).slice(0, 24)}...`);
      assert.equal(hex(first.publicKey), hex(again.publicKey));
    });

    it('a different label derives a different key', async ({log, assert, skip}) => {
      /*
       * The other half. A derivation that ignored its label would pass the
       * determinism test perfectly while giving every site the same secret -
       * which is precisely the bug the reference documents at
       * onlykey-3rd-party.js:54-66, where Uint8Array.from() on a string
       * collapsed every label to zero bytes and only its LENGTH survived.
       *
       * So the two labels here are the SAME LENGTH. A shorter one would pass
       * even with that bug present.
       */
      const {okcrypto} = await connected(log);
      needsVendorOrigin(skip);
      assert.equal('e2e.example'.length, 'e2e.exampyy'.length);

      const a = await okcrypto.derivePublicKey('e2e.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive});
      const b = await okcrypto.derivePublicKey('e2e.exampyy',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive});

      log(`a: ${hex(a.publicKey).slice(0, 24)}...`);
      log(`b: ${hex(b.publicKey).slice(0, 24)}...`);
      assert.notEqual(hex(a.publicKey), hex(b.publicKey));
    });

    it('a shared secret can be derived against that key', async ({log, assert, skip}) => {
      /*
       * The value the web app presents as a generated password, and the value
       * the vault turns into an AES key. Deriving it against the device's own
       * derived public key is the two-step the password generator does.
       */
      const {okcrypto} = await connected(log);
      needsVendorOrigin(skip);

      const pub = await okcrypto.derivePublicKey('e2e.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive});
      const secret = await okcrypto.deriveSharedSecret('e2e.example', pub.publicKey, {
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive,
      });

      log(`shared payload: ${secret.payload.length} bytes`);
      log(`secret: ${secret.secret.length} bytes, ${hex(secret.secret).slice(0, 24)}...`);
      log(`its public half: ${hex(secret.publicKey).slice(0, 24)}...`);

      /*
       * THE SHAPE, not just the length. This response carries two values - the
       * public key and then the 32-byte secret - and an earlier version of this
       * test asserted only that the payload was non-empty, which is why a
       * reader that returned "the last 65 bytes" (33 bytes of public key with
       * the secret glued on) passed it. That value is the right sort of length,
       * stable per label, and wrong.
       */
      assert.equal(secret.secret.length, 32, 'an ECC shared secret is 32 bytes');
      assert.equal(secret.publicKey.length, 65, 'with the P-256 point in front of it');
      assert.equal(
        secret.payload.length >= 65 + 32, true,
        `payload is ${secret.payload.length}; it must hold both halves`,
      );
      assert.notEqual(
        hex(secret.secret), hex(secret.publicKey.subarray(secret.publicKey.length - 32)),
        'the secret must not be the tail of the public key',
      );
      assert.ok(
        /UNLOCKED/i.test(secret.status),
        `the decrypted status was ${JSON.stringify(secret.status)}`,
      );
    });

    it('the SHARED SECRET is stable across calls, not just the public key', async ({log, assert, skip}) => {
      /*
       * The assertion whose absence let a broken vault ship.
       *
       * "The same label derives the same key twice" was tested for
       * derive_public_key and quietly assumed for derive_shared_secret - and
       * the vault's whole premise is that the secret is reproducible, because
       * it seals with one derivation and opens with another. If it moves, a
       * blob sealed a minute ago cannot be opened, and AES-GCM reports that as
       * a tag failure, which reads as "wrong service name".
       */
      const {okcrypto} = await connected(log);
      needsVendorOrigin(skip);

      const first = await okcrypto.deriveSharedSecretFor('vault.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive});
      const again = await okcrypto.deriveSharedSecretFor('vault.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive});

      log(`first: ${hex(first)}`);
      log(`again: ${hex(again)}`);
      assert.equal(hex(first), hex(again), 'the vault cannot work if this moves');
    });


    it('a vault blob sealed on this device opens again', async ({log, assert, skip}) => {
      /*
       * The unit tests round trip this with a STUBBED derive, which proves the
       * cache and the cipher wiring and nothing about the device. On hardware
       * it failed, and a tag failure is the only thing AES-GCM will say - so
       * the round trip has to run here too.
       *
       * The vault derives its public key without a touch and its shared secret
       * with one, because the web app does and the pairing decides the key -
       * the press flag is an INPUT to the derivation, not a permission check
       * (FINDING-the-press-flag-changes-the-derived-key.md). So there is no
       * retrying this with a touch; it would derive a different key.
       *
       * WHAT THAT COSTS DEPENDS ON THE FIRMWARE, and the split is one release
       * wide (node-onlykey-lib/src/device/version.js, touchFreeDerive):
       *
       *   'always'      v3.0.1 and earlier - no preference exists
       *   'broken'      v3.0.2 - the check reads a RAM cache its own raw-HID
       *                 path clears, so the derive is refused whatever the
       *                 preference says, and the vault CANNOT work
       *   'preference'  after v3.0.2 - an EEPROM bit, set by 9-cryptoSign
       *                 while it is in config mode for its own reasons
       *
       * So on v3.0.2 this asserts the REFUSAL. A suite that only checks for
       * success cannot tell a version that refuses correctly from one that is
       * broken, which is the whole point of running the matrix.
       */
      const {device, okcrypto} = await connected(log);
      needsVendorOrigin(skip);
      const can = device.capabilities && device.capabilities.touchFreeDerive;
      log(`touch-free derive on this firmware: ${can}`);

      const opts = {
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive,
      };

      if (can === 'broken') {
        let refused = null;
        try {
          await okcrypto.deviceVault.seal('vault.example', 'hunter2-the-secret', opts);
        } catch (e) {
          refused = String(e && e.message);
        }
        log(`refusal: ${refused}`);
        assert.ok(refused, 'this firmware cannot derive touch-free, so the seal must fail');
        /*
         * Either message is correct and they come from different layers. The
         * vault's own translation fires when the firmware returns
         * EXTENSION_NOT_SUPPORTED cleanly; the derive's status guard fires when
         * the refusal arrives with a stale buffer behind it, which is the same
         * refusal wearing different clothes. What must NOT happen is a
         * plausible-looking key coming back from a device that refused.
         */
        assert.ok(
          /cannot do a touch-free derive|did not answer this derive/.test(refused),
          'the refusal must name the firmware or say the device did not ' +
            'answer - not surface as a framing complaint several layers up',
        );
        return;
      }

      /*
       * Enable the preference ON DEMAND, then retry THE SAME derive.
       *
       * Not the forbidden fallback: that one retries with a different press
       * flag and derives a different key. This changes a device setting and
       * asks the identical question again.
       */
      let blob;
      try {
        blob = await okcrypto.deviceVault.seal('vault.example', 'hunter2-the-secret', opts);
      } catch (e) {
        if (!/derived keys per site without touch/.test(String(e && e.message))) {
          throw e;
        }
        log('the preference is off; entering config mode to set it');
        await enableTouchFreeDerive(device, PIN, log);
        blob = await okcrypto.deviceVault.seal('vault.example', 'hunter2-the-secret', opts);
      }
      log(`blob: ${blob}`);
      log(`cached after seal: ${okcrypto.deviceVault.isUnlocked('vault.example')}`);

      const opened = await okcrypto.deviceVault.open('vault.example', blob, opts);
      log(`opened: ${JSON.stringify(opened)}`);
      assert.equal(opened, 'hunter2-the-secret');
    });


    it('a sealed credential survives being stored and read back', async ({log, assert, skip}) => {
      /*
       * The vault could seal and open; it had nowhere to PUT the result, so a
       * credential lasted exactly as long as the screen showing it. This is
       * AsyncStorage underneath, reached through the host plugin the same way
       * randomness is.
       *
       * What is stored is the sealed blob and nothing else. The key is derived
       * from the device and kept nowhere, so this record is unreadable to
       * anything that can read the phone's storage.
       */
      const {device, okcrypto} = await connected(log);
      needsVendorOrigin(skip);
      assert.equal(okcrypto.deviceVault.canPersist, true, 'no store was wired');

      /*
       * Storage is host-side and works on any firmware; what does not is the
       * DERIVE that seals the record. On v3.0.2 the touch-free derive is
       * refused whatever the preference says, so assert that saving refuses
       * for that reason rather than silently storing nothing.
       */
      if (device.capabilities && device.capabilities.touchFreeDerive === 'broken') {
        let refused = null;
        try {
          await okcrypto.deviceVault.save('store.example', 'stored-secret', {
            requirePress: true, timeoutMs: 30000,
          });
        } catch (e) {
          refused = String(e && e.message);
        }
        log(`refusal: ${refused}`);
        assert.ok(
          /cannot do a touch-free derive|did not answer this derive/.test(String(refused)),
          'this firmware cannot seal, and must say so');
        return;
      }

      /*
       * FRESH options per device operation. pressing() answers exactly one
       * keepalive and then goes quiet - deliberately, because extra presses on
       * an unlocked device type a slot. Sharing one instance across two
       * derives leaves the second waiting, and the device gives up with a
       * status rather than an explanation.
       */
      const press = () => ({
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive,
      });
      const service = 'store.example';
      await okcrypto.deviceVault.forget(service);

      const record = await okcrypto.deviceVault.save(service, 'stored-secret', press());
      log(`stored: ${JSON.stringify({...record, encrypted: `${record.encrypted.slice(0, 16)}…`})}`);
      assert.equal(record.serviceId, service);
      assert.ok(record.encrypted && record.encrypted.length > 20, 'no sealed blob stored');
      assert.ok(!record.encrypted.includes('stored-secret'), 'the plaintext went into storage');

      const ids = await okcrypto.deviceVault.serviceIds();
      log(`stored services: ${JSON.stringify(ids)}`);
      assert.ok(ids.includes(service), 'the service is not in the list');

      /*
       * Opened from the STORE, not from the value returned above - reading
       * back what we already hold in memory would prove nothing about
       * storage.
       */
      okcrypto.deviceVault.lockAll();
      const opened = await okcrypto.deviceVault.load(service, press());
      log(`loaded: ${JSON.stringify(opened)}`);
      assert.equal(opened, 'stored-secret');

      await okcrypto.deviceVault.forget(service);
      assert.equal(await okcrypto.deviceVault.load(service, press()), null);
    });

    it('an export carries sealed blobs and imports back', async ({log, assert, skip}) => {
      const {device, okcrypto} = await connected(log);
      needsVendorOrigin(skip);
      const press = () => ({
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive,
      });

      /*
       * The envelope is host-side, but there is nothing to put in it on a
       * firmware that cannot seal - v3.0.2's touch-free derive is refused
       * whatever the preference says.
       */
      if (device.capabilities && device.capabilities.touchFreeDerive === 'broken') {
        /* The envelope is host-side, but this firmware cannot seal anything to
         * put in it - so there is nothing here to measure either way. */
        assert.equal((await okcrypto.deviceVault.serviceIds()).length, 0);
        skip('this firmware cannot do a touch-free derive, so the vault holds nothing to export');
      }

      await okcrypto.deviceVault.save('export.example', 'exported-secret', press());
      const json = await okcrypto.deviceVault.exportJSON();
      log(`export: ${json.length} chars`);

      const parsed = JSON.parse(json);
      assert.equal(parsed.version, 1, 'the envelope must match the web app');
      assert.ok(Array.isArray(parsed.credentials));
      assert.ok(
        !json.includes('exported-secret'),
        'the plaintext is in the export - it must carry sealed blobs only',
      );

      await okcrypto.deviceVault.forgetAll();
      // ok/equal/notEqual is the whole of this harness's assert - no deepEqual.
      assert.equal((await okcrypto.deviceVault.serviceIds()).length, 0);

      const result = await okcrypto.deviceVault.importJSON(json);
      log(`imported: ${JSON.stringify(result)}`);
      assert.ok(result.imported >= 1, 'nothing imported');

      okcrypto.deviceVault.lockAll();
      assert.equal(
        await okcrypto.deviceVault.load('export.example', press()),
        'exported-secret',
        'a blob that survived an export/import round trip no longer opens',
      );

      await okcrypto.deviceVault.forgetAll();
    });

    it('the X-Wing key type returns its split-custody pair', async ({log, assert, skip}) => {
      /*
       * The odd one out by SHAPE, not by availability - the plugin reported it
       * as unavailable for a while after this test started passing, and both
       * that flag and this comment have been corrected.
       *
       * X-Wing returns 64 bytes - [pk_X(32) | mlkem_seed(32)] - not a 65-byte
       * EC point (ok_extension.cpp:275-281). sk_X never leaves the device; the
       * host expands the seed and does the ML-KEM half itself.
       *
       * Wire keytype 5 becomes KEYTYPE_XWING inside the firmware, which does
       * opt2++ on the way in - so 5 is what goes on the wire, not 6.
       */
      const {device, okcrypto} = await connected(log);
      needsVendorOrigin(skip);

      /*
       * X-WING DOES NOT EXIST ON EVERY FIRMWARE. `KEYTYPE_XWING` appears
       * nowhere in libraries@5d7ce7a (v3.0.2), so this is not a feature the
       * device refuses - it is one it never had.
       *
       * SKIPPED rather than asserted, and the distinction is the point. The
       * library now checks the capability and declines to send, so asserting
       * "it refused" would only be testing our own guard while reading as
       * though the device had answered. A skip with a reason says what is
       * actually true, and the count says how many tests this firmware could
       * not be asked.
       */
      if (device.capabilities && device.capabilities.xwingDerive === false) {
        skip('KEYTYPE_XWING does not exist before v3.0.2 - the key type is absent, not refused');
      }

      const first = await okcrypto.derivePublicKey('xwing.example', {
        keytype: okcrypto.KEYTYPE.XWING,
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive,
      });

      log(`status: ${JSON.stringify(first.status)}`);
      log(`payload: ${first.payload.length} bytes, key ${first.publicKey.length}`);
      log(`pk_X: ${hex(first.publicKey.subarray(0, 32)).slice(0, 24)}...`);
      log(`seed: ${hex(first.publicKey.subarray(32)).slice(0, 24)}...`);

      assert.equal(first.publicKey.length, 64, 'X-Wing is 32 + 32, not an EC point');
      assert.ok(/UNLOCKED/i.test(first.status), 'the transit cipher is wrong');

      /* The two halves must not be the same 32 bytes twice. */
      assert.notEqual(
        hex(first.publicKey.subarray(0, 32)),
        hex(first.publicKey.subarray(32)),
        'pk_X and the ML-KEM seed are the same bytes, which cannot be right',
      );

      const again = await okcrypto.derivePublicKey('xwing.example', {
        keytype: okcrypto.KEYTYPE.XWING,
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive,
      });
      assert.equal(hex(first.publicKey), hex(again.publicKey), 'an identity must be stable');
    });


    it('an age file encrypted to the device is read back by it', async ({log, assert, skip}) => {
      /*
       * The whole point of X-Wing's split custody, end to end.
       *
       * ENCRYPTION TOUCHES NO DEVICE. A recipient is public, so anyone holding
       * the string can encrypt to this key - and that is done here with the
       * device sitting idle, which is the claim worth proving.
       *
       * Decryption sends exactly 32 bytes: ct_X, the X25519 half. ct_M stays on
       * the host and is decapsulated from the seed, which is what keeps this to
       * one round trip instead of a 1120-byte upload.
       */
      const {device, okcrypto} = await connected(log);
      needsVendorOrigin(skip);
      const opts = {
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log, shared && shared.device && shared.device.capabilities).onKeepAlive,
      };

      /*
       * The age format is X-Wing end to end, so a firmware without that key
       * type cannot hold an identity in it. Nothing to encrypt to.
       */
      if (device.capabilities && device.capabilities.xwingDerive === false) {
        skip('the age format is X-Wing end to end, and KEYTYPE_XWING does not exist before v3.0.2');
      }

      const id = await okcrypto.deviceAge.identity('age.example', opts);
      log(`recipient: ${id.recipientString.slice(0, 40)}...`);
      assert.ok(id.recipientString.startsWith('age1'), 'a recipient is bech32');

      const message = 'the ciphertext is not the message';
      const file = okcrypto.deviceAge.encrypt(
        new TextEncoder().encode(message),
        id.recipient,
      );
      log(`age file: ${file.length} bytes`);
      assert.ok(file.length > message.length, 'an age file carries its header');

      const opened = await okcrypto.deviceAge.decrypt(file, 'age.example', opts);
      const text = String.fromCharCode(...opened);
      log(`opened: ${JSON.stringify(text)}`);
      assert.equal(text, message);
    });

  });
};
