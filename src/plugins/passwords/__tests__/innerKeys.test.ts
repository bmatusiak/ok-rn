/*
 * An entry sealed a second time (src/plugins/passwords/innerKeys.ts): with the key - its own
 * derive, not left in the session - or with a passphrase through OkSSL's PBKDF2 (NativeKdf, here
 * Node's PBKDF2 standing in for it).
 */
declare const require: (m: string) => any;
const nodeCrypto = require('crypto');

jest.mock('../../../../specs/NativeKdf', () => ({
  __esModule: true,
  default: {
    pbkdf2Sha256: async (pwHex: string, saltHex: string, rounds: number, len: number) =>
      jest
        .requireActual('crypto')
        .pbkdf2Sync((globalThis as any).Buffer.from(pwHex, 'hex'), (globalThis as any).Buffer.from(saltHex, 'hex'), rounds, len, 'sha256')
        .toString('hex'),
  },
}));

import {openEntry, sealEntry, sealOf} from '../innerKeys';

function fakeKey() {
  const cache = new Map<string, Uint8Array>();
  const locked: string[] = [];
  const okcrypto = {
    deviceVault: {
      async key(label: string) {
        const k = cache.get(label) ?? new Uint8Array(nodeCrypto.createHash('sha256').update('seed|' + label).digest());
        cache.set(label, k);
        return k;
      },
      lock(label: string) {
        locked.push(label);
        cache.delete(label);
      },
    },
  };
  return {okcrypto, locked};
}

const ENTRY = {id: 'a1', kind: 'login', title: 'Bank', username: 'brad', password: 'secret', notes: 'pin 1234'};

test('sealed with the key: secrets inside, opened by the key again, never left in the session', async () => {
  const {okcrypto, locked} = fakeKey();
  const sealed = await sealEntry(ENTRY, {seal: 'key'}, okcrypto, false);
  expect(sealed.password).toBeUndefined();
  expect(sealed.notes).toBeUndefined();
  expect(sealed.username).toBe('brad');
  expect(sealOf(sealed)).toBe('key');
  expect(locked).toEqual([`entry:${sealed.inner.ref}`]);
  const open = await openEntry(sealed, okcrypto, false);
  expect(open.password).toBe('secret');
  expect(open.notes).toBe('pin 1234');
  expect(locked).toHaveLength(2);
});

test('sealed with a passphrase: opens with it, not without it or with another', async () => {
  const {okcrypto} = fakeKey();
  const sealed = await sealEntry(ENTRY, {seal: 'passphrase', passphrase: 'horse battery'}, okcrypto, false);
  expect(sealOf(sealed)).toBe('passphrase');
  expect((await openEntry(sealed, okcrypto, false, 'horse battery')).password).toBe('secret');
  await expect(openEntry(sealed, okcrypto, false)).rejects.toThrow(/passphrase/);
  await expect(openEntry(sealed, okcrypto, false, 'other words')).rejects.toThrow(/does not open/);
});
