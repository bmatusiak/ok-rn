import {readKeyChainList} from './keyChainRecorder';

/*
 * THE PGP STEPS ENCRYPT / DECRYPT AND CRYPTOBOX SHARE (Brad's rule: reuse the logic that works).
 * Encrypt / Decrypt did these inline; Cryptobox needs the same ones, so they live here once:
 * your +PQC keys on the device, arming one for a decrypt or a signature, and finding which of
 * them a message was encrypted to.
 *
 * The 1.2 MB OpenPGP fork is required lazily (see MessagesScreen's header): never at module
 * scope, so opening the app does not load it.
 */

export const openpgpFork = () => require('node-onlykey-lib/crypto/pgp');

/* a composite (+PQC) key Key Chain made and keeps the public certificate of; its private half is on the device */
export type DeviceKey = {id: string; name: string; slot: number; pgp: string};

export async function readDeviceKeys(): Promise<DeviceKey[]> {
  const list = await readKeyChainList();
  return list
    .filter(e => e.type === 'composite' && e.pgp && (e.slots || []).length)
    .map(e => ({id: e.id, name: e.name || 'composite key', slot: e.slots[0], pgp: e.pgp}));
}

/*
 * DEVICE-BACKED: the kept key is the PUBLIC half, and the fork is handed a placeholder private key
 * whose secret scalars are marked hardware-backed. Its hooks then call the device for the X25519
 * and ML-KEM halves of a decrypt and both halves of a signature; the device raises a three-button
 * challenge for each (`onChallenge` gets the digits, then null). disarm() clears the hooks so a
 * later generate is not hijacked (see composite_pgp.js on hooks.signer) and drops the listener.
 */
export async function armDeviceKey(
  getKey: () => Promise<{okcrypto: any}>,
  key: DeviceKey,
  onChallenge: (digits: number[] | null) => void,
): Promise<{privateKey: unknown; disarm: () => void}> {
  const openpgp = openpgpFork();
  const {okcrypto} = await getKey();
  const pub = await openpgp.readKey({armoredKey: key.pgp});
  const privateKey = openpgp.createHardwarePrivateKey(pub);
  okcrypto.registerPgpHooks(openpgp, key.slot);
  const off = okcrypto.on('challenge', ({digits}: {digits: number[]}) => onChallenge(digits));
  return {
    privateKey,
    disarm: () => {
      onChallenge(null);
      if (typeof off === 'function') off();
      try {
        openpgp.clearHardwareHooks();
      } catch {
        /* not loaded */
      }
    },
  };
}

/* which of your device keys an encrypted message is for: its recipient key ids against your keys' ids */
export async function deviceKeyFor(armored: string, keys: DeviceKey[]): Promise<DeviceKey | null> {
  const openpgp = openpgpFork();
  const message = await openpgp.readMessage({armoredMessage: armored});
  const wanted = new Set<string>(message.getEncryptionKeyIDs().map((id: any) => String(id.toHex()).toLowerCase()));
  for (const k of keys) {
    try {
      const key = await openpgp.readKey({armoredKey: k.pgp});
      if (key.getKeyIDs().some((id: any) => wanted.has(String(id.toHex()).toLowerCase()))) return k;
    } catch {
      /* a certificate the fork cannot read matches nothing */
    }
  }
  return null;
}
