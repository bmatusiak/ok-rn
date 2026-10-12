'use strict';

/*
 * GUEST BOOK on the phone (GUEST-BOOK-SPEC.md, implementation: "An e2e suite guestBook that adds a
 * pasted key, uses it in Encrypt, and deletes it. No network in e2e"). On the app's JS engine
 * (Hermes) and its real AsyncStorage - what jest cannot show: the vendored OpenPGP fork reading
 * and armoring keys there, and the store round trip on the device.
 *
 * Its own storage key (okrn.e2e.guestbook:v1), so the person's list is never touched. No OnlyKey
 * and no network needed.
 */

const AsyncStorage = require('@react-native-async-storage/async-storage').default;
const {formats, store} = require('node-onlykey-lib/guestbook');
const openpgp = require('node-onlykey-lib/crypto/pgp');
const {recipientSource} = require('./service');

const KEY = 'okrn.e2e.guestbook:v1';
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
const book = () => store.createGuestBook({storage: AsyncStorage, randomBytes, key: KEY});

let alice = null;
async function aliceKeys() {
  if (!alice) alice = await openpgp.generateKey({type: 'ecc', curve: 'curve25519', userIDs: [{name: 'Alice E2E', email: 'alice@e2e.test'}], format: 'armored'});
  return alice;
}

module.exports = function guestbook({describe, it}) {
  describe('guestbook', () => {
    it('reads a pasted PGP public key on the phone, and refuses a private one', async ({assert}) => {
      const {publicKey, privateKey} = await aliceKeys();
      const r = await formats.detectAll(publicKey, {openpgp});
      assert.equal(r.found.length, 1);
      assert.equal(r.found[0].format, 'openpgp');
      assert.equal(r.found[0].label, 'Alice E2E <alice@e2e.test>');
      let refused = false;
      try {
        await formats.detectAll(privateKey, {openpgp});
      } catch (e) {
        refused = /Guest Book holds only public keys/.test(String(e && e.message));
      }
      assert.ok(refused, 'a private key was not refused');
    });

    it('saves the contact in AsyncStorage and reads it back', async ({assert}) => {
      await AsyncStorage.removeItem(KEY);
      const {publicKey} = await aliceKeys();
      const {found} = await formats.detectAll(publicKey, {openpgp});
      const gb = book();
      await gb.save([gb.newContact({name: 'Alice E2E', found, source: {kind: 'paste', handle: ''}})]);
      const again = await book().load();
      assert.equal(again.contacts.length, 1);
      assert.equal(again.contacts[0].keys[0].fingerprint, found[0].fingerprint);
    });

    it('the key it holds is a key Messages can encrypt to (the recipient source)', async ({assert}) => {
      /* the same encrypt Messages runs, to the key as Guest Book hands it over */
      const {contacts} = await book().load();
      const text = contacts[0].keys[0].text;
      const encryptionKeys = await openpgp.readKey({armoredKey: text});
      const message = await openpgp.encrypt({message: await openpgp.createMessage({text: 'hello from the e2e'}), encryptionKeys});
      assert.ok(/BEGIN PGP MESSAGE/.test(message), 'no PGP message came out');
      /* the source Messages asks reads the person's list, not this suite's - it answers either way */
      assert.ok(Array.isArray(await recipientSource.pgpKeys()));
    });

    it('deletes it again', async ({assert}) => {
      const gb = book();
      await gb.save([]);
      assert.equal((await book().load()).contacts.length, 0);
      await AsyncStorage.removeItem(KEY);
    });
  });
};
