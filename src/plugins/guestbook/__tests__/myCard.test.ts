/**
 * MY CARD: your public keys from Key Chain's list, in the forms people paste - and only the ones
 * worth sharing: a derive the recorder saw without its label ("hash:...") is a site's own key and
 * is left out. Public only: a form carrying private text is never shown.
 */
const keychain = require('node-onlykey-lib/keychain');

const mockEntries: any[] = [];
jest.mock('../../../keyChainRecorder', () => ({readKeyChainList: async () => mockEntries}));

import {readMyCard} from '../myCard';

const bytes = (n: number, fill: number) => Uint8Array.from({length: n}, (_, i) => (i + fill) & 0xff);
const {ed25519, x25519} = require('node-onlykey-lib/vendor/@noble/curves/ed25519.js');

test('named keys give their SSH and age forms; an unnamed site derive is left out', async () => {
  mockEntries.length = 0;
  mockEntries.push(
    keychain.list.createEntry({kind: 'derived', type: 'ed25519', scheme: 'ssh', label: 'ssh://brad@laptop', publicKey: ed25519.getPublicKey(bytes(32, 1))}),
    keychain.list.createEntry({kind: 'derived', type: 'x25519', scheme: 'label', label: 'age-files', publicKey: x25519.getPublicKey(bytes(32, 2))}),
    keychain.list.createEntry({kind: 'derived', type: 'ed25519', scheme: 'label', label: 'hash:0123abcd', publicKey: ed25519.getPublicKey(bytes(32, 3))}),
  );
  const card = await readMyCard();
  expect(card.map(k => k.format).sort()).toEqual(['SSH', 'age']);
  expect(card.find(k => k.format === 'SSH')!.text).toMatch(/^ssh-ed25519 \S+ ssh:\/\/brad@laptop$/);
  expect(card.find(k => k.format === 'age')!.text).toMatch(/^age1/);
  expect(card.some(k => k.title.includes('hash:'))).toBe(false);
});
