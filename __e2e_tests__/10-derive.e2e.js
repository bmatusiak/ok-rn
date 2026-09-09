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
 * Press when the device asks, from inside the KEEPALIVE.
 *
 * A derive can demand user presence even when DERIVE_PUBLIC_KEY is asked for
 * rather than DERIVE_PUBLIC_KEY_REQ_PRESS - the device has its own
 * derived-key challenge setting, and it wins. Without a press the firmware
 * waits, sends KEEPALIVE(UP_NEEDED), and eventually answers
 * CTAP2_ERR_USER_ACTION_PENDING, which is a refusal rather than a failure.
 *
 * The press has to happen FROM the keepalive rather than on a timer: the
 * device only starts watching its buttons once the ceremony is under way.
 */
function pressing(log) {
  let pressed = 0;
  return {
    get count() { return pressed; },
    onKeepAlive: async () => {
      if (pressed) return;          /* one press answers it */
      await OkEmu.pressButton(1);
      pressed += 1;
      log(`pressed button 1 for the derive`);
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
  shared = {device, okcrypto, status: String(state.status)};
  return shared;
}

module.exports = function derive({describe, it}) {
  describe(derive.name, () => {
    it('the plugin offers the derive pair at all', async ({log, assert}) => {
      const {okcrypto} = await connected(log);
      log(`KEYTYPE.P256R1 = ${okcrypto.KEYTYPE.P256R1}`);
      assert.equal(typeof okcrypto.derivePublicKey, 'function');
      assert.equal(typeof okcrypto.deriveSharedSecret, 'function');
      assert.equal(okcrypto.KEYTYPE.P256R1, P256R1);
    });

    it('derives a public key for a label', async ({log, assert}) => {
      const {okcrypto, status} = await connected(log);
      assert.ok(
        /UNLOCKED/i.test(status),
        'the device is locked, so there is no FIDO interface to derive over',
      );

      const press = pressing(log);
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

    it('the same label derives the same key twice', async ({log, assert}) => {
      /*
       * The assertion that separates a working exchange from noise. Every call
       * uses a FRESH transit keypair, so the ciphertext differs each time; if
       * the decryption is right the plaintext underneath is identical, and if
       * it is wrong these are two unrelated random strings.
       */
      const {okcrypto} = await connected(log);

      const first = await okcrypto.derivePublicKey('e2e.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log).onKeepAlive});
      const again = await okcrypto.derivePublicKey('e2e.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log).onKeepAlive});

      log(`first: ${hex(first.publicKey).slice(0, 24)}...`);
      log(`again: ${hex(again.publicKey).slice(0, 24)}...`);
      assert.equal(hex(first.publicKey), hex(again.publicKey));
    });

    it('a different label derives a different key', async ({log, assert}) => {
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
      assert.equal('e2e.example'.length, 'e2e.exampyy'.length);

      const a = await okcrypto.derivePublicKey('e2e.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log).onKeepAlive});
      const b = await okcrypto.derivePublicKey('e2e.exampyy',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log).onKeepAlive});

      log(`a: ${hex(a.publicKey).slice(0, 24)}...`);
      log(`b: ${hex(b.publicKey).slice(0, 24)}...`);
      assert.notEqual(hex(a.publicKey), hex(b.publicKey));
    });

    it('a shared secret can be derived against that key', async ({log, assert}) => {
      /*
       * The value the web app presents as a generated password, and the value
       * the vault turns into an AES key. Deriving it against the device's own
       * derived public key is the two-step the password generator does.
       */
      const {okcrypto} = await connected(log);

      const pub = await okcrypto.derivePublicKey('e2e.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log).onKeepAlive});
      const secret = await okcrypto.deriveSharedSecret('e2e.example', pub.publicKey, {
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log).onKeepAlive,
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

    it('the SHARED SECRET is stable across calls, not just the public key', async ({log, assert}) => {
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

      const first = await okcrypto.deriveSharedSecretFor('vault.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log).onKeepAlive});
      const again = await okcrypto.deriveSharedSecretFor('vault.example',
        {requirePress: true, timeoutMs: 30000, onKeepAlive: pressing(log).onKeepAlive});

      log(`first: ${hex(first)}`);
      log(`again: ${hex(again)}`);
      assert.equal(hex(first), hex(again), 'the vault cannot work if this moves');
    });


    it('a vault blob sealed on this device opens again', async ({log, assert}) => {
      /*
       * The unit tests round trip this with a STUBBED derive, which proves the
       * cache and the cipher wiring and nothing about the device. On hardware
       * it failed, and a tag failure is the only thing AES-GCM will say - so
       * the round trip has to run here too.
       *
       * THE PREFERENCE HAS TO BE ON, and 9-cryptoSign turns it on while it is
       * already in config mode - reaching config mode costs a gesture that
       * also locks the device, so paying that twice in one run for one EEPROM
       * byte is waste.
       *
       * The vault derives its public key without a touch and its shared secret
       * with one, because the web app does and the pairing decides the key -
       * the press flag is an INPUT to the derivation, not a permission check
       * (FINDING-the-press-flag-changes-the-derived-key.md). The touch-free
       * half is refused unless derived_key_challenge_mode bit 3 is set, and
       * retrying it with a touch would derive a DIFFERENT key, so there is no
       * shortcut past it. If this fails saying so, run the full suite once:
       * the byte persists.
       */
      const {device, okcrypto} = await connected(log);

      const opts = {
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log).onKeepAlive,
      };

      /*
       * Enable the preference ON DEMAND, then retry THE SAME derive.
       *
       * This is not the forbidden fallback. The forbidden one is retrying with
       * a different press flag, which derives a different key; this changes a
       * device setting and then asks the identical question again, so the
       * answer is the one the web app would get.
       *
       * On demand because the byte persists in EEPROM: it is set once per
       * device, and the config-mode gesture it costs is slow enough that
       * paying it on every run would be waste.
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


    it('a sealed credential survives being stored and read back', async ({log, assert}) => {
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
      const {okcrypto} = await connected(log);
      assert.equal(okcrypto.deviceVault.canPersist, true, 'no store was wired');

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
        onKeepAlive: pressing(log).onKeepAlive,
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

    it('an export carries sealed blobs and imports back', async ({log, assert}) => {
      const {okcrypto} = await connected(log);
      const press = () => ({
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log).onKeepAlive,
      });

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

    it('the X-Wing key type returns its split-custody pair', async ({log, assert}) => {
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
      const {okcrypto} = await connected(log);

      const first = await okcrypto.derivePublicKey('xwing.example', {
        keytype: okcrypto.KEYTYPE.XWING,
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log).onKeepAlive,
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
        onKeepAlive: pressing(log).onKeepAlive,
      });
      assert.equal(hex(first.publicKey), hex(again.publicKey), 'an identity must be stable');
    });


    it('an age file encrypted to the device is read back by it', async ({log, assert}) => {
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
      const {okcrypto} = await connected(log);
      const opts = {
        requirePress: true,
        timeoutMs: 30000,
        onKeepAlive: pressing(log).onKeepAlive,
      };

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
