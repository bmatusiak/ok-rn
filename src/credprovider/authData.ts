/**
 * Reading authenticator data.
 *
 * EXPERIMENT - see REMOVAL.md.
 *
 * ## Why this has to exist, and why it must not re-encode
 *
 * The key answers makeCredential with `authData` as one opaque byte string, and
 * the attestation signature is computed OVER THOSE BYTES. The relying party
 * verifies the same way. So authData is passed onward EXACTLY as it arrived -
 * this file only ever reads, never rebuilds. That is the same rule
 * node-onlykey-lib's protocol/bridge.js keeps for the whole CBOR payload, and
 * for the same reason.
 *
 * What we need out of it is small: the credential id, which WebAuthn wants
 * hoisted into the response's `id` and `rawId` fields, and the algorithm of the
 * public key, which browsers like to see as `publicKeyAlgorithm`. Neither is
 * available anywhere else in the CTAP response - the credential id in the
 * makeCredential reply is only inside authData.
 *
 * ## The layout (WebAuthn Level 2, section 6.1)
 *
 *   32  rpIdHash
 *    1  flags        bit 0 UP, bit 2 UV, bit 6 AT (attested data), bit 7 ED
 *    4  signCount    big endian
 *   --- present only when AT is set ---
 *   16  aaguid
 *    2  credentialIdLength, big endian
 *    L  credentialId
 *    ?  credentialPublicKey, a COSE key as CBOR - SELF-DELIMITING, which is why
 *       it takes cbor.decodeFirst to find where it ends. An extension map may
 *       follow it immediately with no length in between.
 */
import {protocol} from 'node-onlykey-lib';

const {cbor} = protocol as any;

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

export type ParsedAuthData = {
  rpIdHash: Uint8Array;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  /** Present only when the AT flag is set, i.e. on a registration. */
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
  /** The COSE key, still a Map. Key 3 is the algorithm, e.g. -7 for ES256. */
  credentialPublicKey?: Map<number, unknown>;
};

export function parseAuthData(authData: Uint8Array): ParsedAuthData {
  if (!authData || authData.length < 37) {
    throw new Error(
      `authData is ${authData ? authData.length : 0} bytes; the fixed header alone is 37`,
    );
  }

  const flags = authData[32];
  const view = new DataView(
    authData.buffer,
    authData.byteOffset,
    authData.byteLength,
  );

  const parsed: ParsedAuthData = {
    rpIdHash: authData.subarray(0, 32),
    flags,
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    signCount: view.getUint32(33, false),
  };

  if ((flags & FLAG_AT) === 0) {
    // An assertion. There is no credential id in here; the caller gets it from
    // the response's own credential field instead.
    return parsed;
  }

  if (authData.length < 55) {
    throw new Error(
      'authData claims attested credential data but is too short to hold the aaguid and length',
    );
  }
  const credIdLen = view.getUint16(53, false);
  const credIdEnd = 55 + credIdLen;
  if (authData.length < credIdEnd) {
    throw new Error(
      `authData says the credential id is ${credIdLen} bytes but only ` +
        `${authData.length - 55} remain`,
    );
  }

  parsed.aaguid = authData.subarray(37, 53);
  parsed.credentialId = authData.subarray(55, credIdEnd);
  // decodeFirst, not decode: the COSE key is not the last thing in the buffer
  // when an extension map follows, and decode() rejects trailing bytes.
  parsed.credentialPublicKey = cbor.decodeFirst(authData, credIdEnd).value;

  return parsed;
}

/**
 * The COSE `alg` (label 3), e.g. -7 for ES256.
 *
 * Returned as a number because that is what `publicKeyAlgorithm` is in the
 * WebAuthn JSON. Undefined rather than a guess when the key has no alg: a
 * wrong algorithm claim is worse than an absent optional field.
 */
export function coseAlgorithm(key?: Map<number, unknown>): number | undefined {
  const alg = key?.get(3);
  return typeof alg === 'number' ? alg : undefined;
}

/**
 * The credential public key as a DER SubjectPublicKeyInfo.
 *
 * Chrome REQUIRES this. Its Android CredMan bridge refuses a registration
 * response without it:
 *
 *   MojoClassFromJSON failed to convert JSON: field missing or invalid: publicKey
 *   (components/webauthn/android/fido2credentialrequest_native_android.cc:59)
 *
 * measured 2026-09-17. The W3C serialization marks `publicKey` optional, so it
 * is easy to leave out and then spend a long time doubting the attestation -
 * which in our case was already correct and signed by the real OnlyKey CA.
 *
 * The encoding is fixed for P-256, so it is a constant header followed by the
 * uncompressed point. Written out rather than pulled from a library because the
 * whole of it is 26 known bytes, and adding an ASN.1 dependency to emit them
 * would be a worse trade:
 *
 *   SEQUENCE {
 *     SEQUENCE { OID ecPublicKey, OID prime256v1 }
 *     BIT STRING { 0x04 || X || Y }
 *   }
 *
 * COSE labels -2 and -3 are x and y (RFC 8152). Returns null when the key is
 * not a P-256 key with both coordinates, because a wrong SPKI is worse than an
 * absent one: the relying party would store a public key that verifies nothing.
 */
export function spkiFromCose(key?: Map<number, unknown>): Uint8Array | null {
  const x = key?.get(-2);
  const y = key?.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    return null;
  }
  if (x.length !== 32 || y.length !== 32) {
    return null;
  }

  const header = Uint8Array.from([
    0x30, 0x59, // SEQUENCE, 89 bytes
    0x30, 0x13, // SEQUENCE, 19 bytes - the algorithm identifier
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID 1.2.840.10045.2.1 ecPublicKey
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID 1.2.840.10045.3.1.7 prime256v1
    0x03, 0x42, 0x00, // BIT STRING, 66 bytes, 0 unused bits
    0x04, // uncompressed point
  ]);

  const out = new Uint8Array(header.length + 64);
  out.set(header, 0);
  out.set(x, header.length);
  out.set(y, header.length + 32);
  return out;
}
