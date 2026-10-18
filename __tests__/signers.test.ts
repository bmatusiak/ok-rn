/**
 * Decrypt / Verify name the signer from Guest Book (src/signers.ts): a signature by someone in
 * Guest Book names them (✓ when their key is verified), one by a key nobody there holds says so.
 */
import {indexSigners, signedBy} from '../src/signers';

jest.setTimeout(60000);

const openpgp = require('node-onlykey-lib/crypto/pgp');
const {messages} = require('node-onlykey-lib/crypto');

async function person(name: string) {
  const {privateKey, publicKey} = await openpgp.generateKey({type: 'ecc', curve: 'curve25519', userIDs: [{name}], format: 'armored'});
  return {privateKey, publicKey};
}

test('names the signer, says when the key is unverified, and when nobody holds it', async () => {
  const alice = await person('Alice');
  const bob = await person('Bob');
  const stranger = await person('Stranger');
  const people = [
    {id: 'a', name: 'Alice', keys: [{label: 'Alice', text: alice.publicKey, verified: true, composite: false}]},
    {id: 'b', name: 'Bob', keys: [{label: 'Bob', text: bob.publicKey, verified: false, composite: false}]},
  ];
  const signers = await indexSigners(openpgp, people);
  const everyone = people.flatMap(p => p.keys.map(k => k.text));

  const check = async (signer: {privateKey: string}) => {
    const armored = await messages.signText(openpgp, {text: 'hello', signWith: signer.privateKey});
    const r = await messages.verifyText(openpgp, {armored, verifyWith: everyone});
    return signedBy(r.signatures, signers);
  };

  expect(await check(alice)).toBe('Signed by Alice ✓.');
  expect(await check(bob)).toBe('Signed by Bob - their key is not verified in Guest Book.');
  expect(await check(stranger)).toMatch(/^Signed by a key that is not in your Guest Book \(key id [0-9A-F]{16}\)\.$/);
  expect(signedBy([], signers)).toBe('');
});
