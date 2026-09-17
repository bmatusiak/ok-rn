/**
 * WebAuthn JSON in, CTAP2 out, and back again.
 *
 * EXPERIMENT - see REMOVAL.md.
 *
 * This is the piece the codebase did not have. node-onlykey-lib already speaks
 * CTAP2 fluently - CBOR, COSE, clientPIN, CTAPHID are all there - but nothing
 * anywhere turned a browser's WebAuthn request into those calls, because until
 * now the browser was always on the OTHER side of the wire and did it itself.
 * protocol/bridge.js relays a request a real browser already built. Here there
 * is no such browser: Android hands over JSON and expects JSON, and we are the
 * client.
 *
 * ## The rule that governs every function below
 *
 * Bytes that are signed are never rebuilt. authData and the attestation
 * statement come back from the key and go onward untouched; we re-wrap them in
 * a CBOR map for attestationObject, which is NOT itself signed, and we slice
 * authData read-only to lift out the credential id. Re-encoding anything the
 * signature covers would produce a response that verifies nowhere.
 *
 * ## clientDataJSON, and why it is usually absent
 *
 * Measured on the bench 2026-09-17: Chrome supplies clientDataHash and is a
 * privileged caller. In that case it has already built clientDataJSON, kept it,
 * and will attach it to the result itself. We sign its hash and return NO
 * clientDataJSON - ours would differ by key order or field set and the relying
 * party would reject the origin. Only a non-privileged caller leaves the hash
 * empty, and only then do we build one.
 */
import {bytes, protocol} from 'node-onlykey-lib';
import {coseAlgorithm, parseAuthData, spkiFromCose} from './authData';

const {cbor} = protocol as any;
const {toBase64Url, fromBase64Url} = bytes as any;

/** ES256. The only algorithm the OnlyKey firmware signs with. */
const ALG_ES256 = -7;

export type CreationOptionsJSON = {
  rp: {id?: string; name?: string};
  user: {id: string; name?: string; displayName?: string};
  challenge: string;
  pubKeyCredParams?: Array<{alg: number; type: string}>;
  excludeCredentials?: Array<{id: string; type: string; transports?: string[]}>;
  authenticatorSelection?: {residentKey?: string; userVerification?: string};
  attestation?: string;
};

export type RequestOptionsJSON = {
  rpId?: string;
  challenge: string;
  allowCredentials?: Array<{id: string; type: string; transports?: string[]}>;
  userVerification?: string;
};

export type PinAuth = {
  /** The 16-byte pinUvAuthParam over the clientDataHash. */
  pinUvAuthParam: Uint8Array;
  /** Always 1 - node-onlykey-lib implements PIN protocol 1 only. */
  pinUvAuthProtocol: number;
};

/* ---- requests ------------------------------------------------------------ */

/**
 * authenticatorMakeCredential parameters.
 *
 * rk is taken from residentKey rather than forced on. The firmware may refuse a
 * discoverable credential it has no room for, and a request that asks for one
 * unnecessarily fails for a reason the user cannot act on. "preferred" - what
 * webauthn.io sends - means we may ask, not that we must.
 */
export function makeCredentialParams(
  options: CreationOptionsJSON,
  clientDataHash: Uint8Array,
  pin?: PinAuth,
): Map<number, unknown> {
  requireHash(clientDataHash);

  const rp = new Map<string, unknown>();
  if (options.rp?.id) {
    rp.set('id', options.rp.id);
  }
  rp.set('name', options.rp?.name ?? options.rp?.id ?? '');

  const user = new Map<string, unknown>([
    ['id', fromBase64Url(options.user.id)],
    ['name', options.user.name ?? ''],
    ['displayName', options.user.displayName ?? options.user.name ?? ''],
  ]);

  /*
   * Filtered to what the key can actually do rather than passed through. A
   * pubKeyCredParams list the authenticator cannot satisfy is answered with
   * CTAP2_ERR_UNSUPPORTED_ALGORITHM, and sites routinely offer RS256 as a
   * fallback for old hardware.
   */
  const requested = options.pubKeyCredParams ?? [];
  const usable = requested.filter(p => p.alg === ALG_ES256);
  const chosen = usable.length ? usable : [{alg: ALG_ES256, type: 'public-key'}];
  const params = chosen.map(
    p =>
      new Map<string, unknown>([
        ['alg', p.alg],
        ['type', p.type || 'public-key'],
      ]),
  );

  const map = new Map<number, unknown>([
    [1, clientDataHash],
    [2, rp],
    [3, user],
    [4, params],
  ]);

  /*
   * excludeList (key 5) is DELIBERATELY NOT SENT.
   *
   * The firmware answers CTAP2_ERR_CBOR_PARSING for a makeCredential carrying
   * one - measured against okemu v3.0.4-testc on 2026-09-17 with the two
   * ~60-byte entries webauthn.io sends. Every makeCredential in this repo that
   * is known to work omits it too (__e2e_tests__/14a-passkeys.e2e.js:98,
   * 5-presence.e2e.js:40), so the working shape is keys 1,2,3,4,7,8,9.
   *
   * What is lost: the relying party uses excludeCredentials to stop a second
   * credential being made for an account that already has one. Without it the
   * site can end up with a duplicate. That is a real cost, not a tidy-up - it
   * is accepted here because the alternative is that registration does not
   * work at all, and the caller is told so on screen rather than silently.
   */

  const residentKey = options.authenticatorSelection?.residentKey;
  if (residentKey === 'required' || residentKey === 'preferred') {
    map.set(7, new Map<string, unknown>([['rk', true]]));
  }

  if (pin) {
    map.set(8, pin.pinUvAuthParam);
    map.set(9, pin.pinUvAuthProtocol);
  }
  return map;
}

/**
 * authenticatorGetAssertion parameters.
 *
 * rpId goes over as the STRING, not its hash: the key hashes it itself, and
 * hashing it here would send 32 bytes where a text string is expected.
 */
export function getAssertionParams(
  options: RequestOptionsJSON,
  clientDataHash: Uint8Array,
  pin?: PinAuth,
): Map<number, unknown> {
  requireHash(clientDataHash);
  if (!options.rpId) {
    throw new Error('the request has no rpId, so there is nothing to assert against');
  }

  const map = new Map<number, unknown>([
    [1, options.rpId],
    [2, clientDataHash],
  ]);

  const allow = credentialList(options.allowCredentials);
  if (allow) {
    map.set(3, allow);
  }

  /*
   * up:true - a security key asserts because a person touched it. Leaving it
   * out lets the firmware pick its own default, which is not necessarily ours.
   */
  map.set(5, new Map<string, unknown>([['up', true]]));

  if (pin) {
    map.set(6, pin.pinUvAuthParam);
    map.set(7, pin.pinUvAuthProtocol);
  }
  return map;
}

function credentialList(
  list?: Array<{id: string; type: string}>,
): Array<Map<string, unknown>> | null {
  if (!list || !list.length) {
    return null;
  }
  return list.map(
    c =>
      new Map<string, unknown>([
        ['id', fromBase64Url(c.id)],
        ['type', c.type || 'public-key'],
      ]),
  );
}

function requireHash(hash: Uint8Array) {
  if (!hash || hash.length !== 32) {
    throw new Error(
      'clientDataHash must be 32 bytes, got ' + (hash ? hash.length : 0),
    );
  }
}

/* ---- responses ----------------------------------------------------------- */

/**
 * A makeCredential reply as W3C registrationResponseJSON.
 *
 * Response map: 1 fmt, 2 authData, 3 attStmt.
 */
export function registrationResponseJSON(
  response: Map<number, unknown>,
  clientDataJSON?: string,
): string {
  const fmt = response.get(1) as string;
  const authData = response.get(2) as Uint8Array;
  const attStmt = response.get(3) ?? new Map();

  if (!(authData instanceof Uint8Array)) {
    throw new Error('the makeCredential reply carried no authData');
  }
  const parsed = parseAuthData(authData);
  if (!parsed.credentialId) {
    throw new Error(
      'the makeCredential reply has no attested credential data, so there is no credential id',
    );
  }

  /*
   * Rebuilt, and safe to rebuild: attestationObject is a container, not
   * something the signature covers. authData goes back in as the same bytes.
   */
  const attestationObject = cbor.encode(
    new Map<string, unknown>([
      ['fmt', fmt ?? 'none'],
      ['attStmt', attStmt],
      ['authData', authData],
    ]),
  );

  const id = toBase64Url(parsed.credentialId);
  const out: any = {
    id,
    rawId: id,
    type: 'public-key',
    authenticatorAttachment: 'cross-platform',
    clientExtensionResults: {},
    response: {
      attestationObject: toBase64Url(attestationObject),
      authenticatorData: toBase64Url(authData),
    },
  };

  /*
   * `transports` is DELIBERATELY NOT CLAIMED.
   *
   * It is not cosmetic. The relying party stores whatever we say here and
   * replays it in allowCredentials on every later sign-in, and a browser uses
   * it to decide which authenticators to even offer. So a wrong value does not
   * show up as a wrong label - it shows up months later as a credential the
   * user cannot use.
   *
   * And there is no right value available. "usb" was here first and was simply
   * false: nothing is on USB, the request arrived through Credential Manager.
   * "internal" is what the platform sees but would assert the credential is
   * bound to this phone, which is the opposite of true for a key you can
   * unplug and carry. "hybrid" describes a different ceremony altogether.
   *
   * The field is optional, an empty list is legal, and an absent hint makes a
   * browser offer everything rather than the wrong thing. When milestone 4
   * reaches a hard key over OTG, "usb" becomes true and can be said then.
   */
  const alg = coseAlgorithm(parsed.credentialPublicKey);
  if (alg !== undefined) {
    out.response.publicKeyAlgorithm = alg;
  }
  const spki = spkiFromCose(parsed.credentialPublicKey);
  if (spki) {
    out.response.publicKey = toBase64Url(spki);
  }
  if (clientDataJSON) {
    out.response.clientDataJSON = clientDataJSON;
  }
  return JSON.stringify(out);
}

/**
 * A getAssertion reply as W3C authenticationResponseJSON.
 *
 * Response map: 1 credential {id,type}, 2 authData, 3 signature, 4 user.
 *
 * The credential id can legitimately be absent: when the allowList held exactly
 * one entry the key may omit it, because the caller already knows which one it
 * asked for. fallbackId is that entry.
 */
export function authenticationResponseJSON(
  response: Map<number, unknown>,
  fallbackId?: string,
  clientDataJSON?: string,
): string {
  const credential = response.get(1) as Map<string, unknown> | undefined;
  const authData = response.get(2) as Uint8Array;
  const signature = response.get(3) as Uint8Array;
  const user = response.get(4) as Map<string, unknown> | undefined;

  if (!(authData instanceof Uint8Array) || !(signature instanceof Uint8Array)) {
    throw new Error('the getAssertion reply is missing authData or the signature');
  }

  const rawId = credential?.get('id');
  const id = rawId instanceof Uint8Array ? toBase64Url(rawId) : fallbackId;
  if (!id) {
    throw new Error(
      'the key returned no credential id and the request had no single ' +
        'allowCredentials entry to fall back on',
    );
  }

  const userHandle = user?.get('id');
  const out: any = {
    id,
    rawId: id,
    type: 'public-key',
    authenticatorAttachment: 'cross-platform',
    clientExtensionResults: {},
    response: {
      authenticatorData: toBase64Url(authData),
      signature: toBase64Url(signature),
    },
  };
  /*
   * userHandle is OMITTED when absent, never sent as null.
   *
   * Chrome refuses the whole response otherwise - "field missing or invalid:
   * userHandle" (fido2credentialrequest_native_android.cc:59), measured
   * 2026-09-17. The W3C serialization calls the field nullable, so emitting
   * null looks correct and is the obvious thing to write; Chrome's JSON-to-Mojo
   * converter disagrees and wants the key gone.
   *
   * It is legitimately absent here: the key returns a user handle only for a
   * discoverable credential, and an assertion answered from an allowList
   * carries none.
   */
  if (userHandle instanceof Uint8Array) {
    out.response.userHandle = toBase64Url(userHandle);
  }
  if (clientDataJSON) {
    out.response.clientDataJSON = clientDataJSON;
  }
  return JSON.stringify(out);
}
