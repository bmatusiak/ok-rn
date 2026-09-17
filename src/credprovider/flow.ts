/**
 * Driving one WebAuthn request all the way to the key and back.
 *
 * EXPERIMENT - see REMOVAL.md.
 *
 * Written as a plain async function rather than a hook so that every step is
 * visible in order and the screen is only a renderer. The screen the user
 * picked is the diagnostic one: it shows each CTAP step as it happens, which
 * means this function has to ANNOUNCE what it is about to do before doing it,
 * not merely report afterwards. Hence `emit` being called twice per step -
 * once as 'run', once as 'ok' or 'fail'.
 *
 * ## The order is not arbitrary
 *
 * getInfo comes before anything that could need a PIN, because pinState() is
 * read from getInfo's options map and asking for a PIN the key does not have
 * wastes a round trip and produces a misleading error (device/fido.js:88).
 *
 * And nothing opens a CTAPHID channel speculatively. A channel against a LOCKED
 * key is the thing that preceded a bench key having to be physically replugged
 * (FINDING-a-ctaphid-channel-on-a-locked-key-wedged-it.md). Here the key is the
 * soft key, which cannot be damaged that way, but the shape of the code should
 * not have to change when milestone 4 points it at real hardware.
 */
import {bytes, device as deviceLib, protocol} from 'node-onlykey-lib';
import {getOnlyKey} from '../onlykey';
import OkEmu from '../transport/OkEmu';
import {
  authenticationResponseJSON,
  getAssertionParams,
  makeCredentialParams,
  registrationResponseJSON,
  type CreationOptionsJSON,
  type PinAuth,
  type RequestOptionsJSON,
} from './ctapTranslate';
import type {PendingCredRequest} from './types';

const {CtapHid} = (protocol as any).ctaphid;
const {clientpin} = protocol as any;
const {FidoAdmin} = (deviceLib as any).fido;
const {version} = deviceLib as any;
const {fromBase64Url} = bytes as any;

export const pressSoftKey = () => OkEmu.pressButton(1);

/** One button on the soft key. PIN entry is taps, and taps ARE presses. */
export const pressSoftKeyButton = (button: number) => OkEmu.pressButton(button);

/**
 * What the key says it is, right now.
 *
 * Exported because the unlock panel has to ask again after every digit. The
 * firmware evaluates the PIN hash after each press (OnlyKey.ino:697) and
 * announces UNLOCKED the moment it matches - there is no "submit" to wait on,
 * and no length to count up to, so the only way to know is to look.
 */
export async function readKeyState() {
  const app = await getOnlyKey('embedded');
  const connected = await app.device.connect();
  return version.parseStatus(String(connected?.status ?? '').trim());
}

export type StepStatus = 'run' | 'ok' | 'fail';
export type Emit = (label: string, status: StepStatus, detail?: string) => void;

/** Asks the user for the key's FIDO PIN. Resolves empty if they decline. */
export type AskPin = (retriesLeft: number | null) => Promise<string>;

/**
 * The key is waiting for a finger. Resolves once the person has provided one.
 *
 * A callback rather than an automatic press, even though the soft key could
 * press its own pad. User presence is the one part of the ceremony that exists
 * to be a HUMAN act - a soft key that satisfies it by itself is not a
 * comparable stand-in for the hard key, it is a different thing wearing its
 * name. The screen decides how to ask; this file only says when.
 */
export type AskPresence = () => Promise<void>;

/**
 * The key is locked. Resolves once the person has unlocked it.
 *
 * A passkey is not worth much if using it requires having already opened
 * another app first, so the ceremony the browser started carries the unlock
 * too.
 */
export type AskUnlock = (state: string) => Promise<void>;

export async function runCredentialFlow(
  request: PendingCredRequest,
  emit: Emit,
  askPin: AskPin,
  askPresence: AskPresence,
  askUnlock: AskUnlock,
): Promise<string> {
  /* ---- 1. the request itself ------------------------------------------- */

  emit('read request', 'run');
  if (request.action !== 'CREATE' && request.action !== 'GET') {
    emit('read request', 'fail', 'no live request');
    throw new Error('there is no request to answer');
  }
  const options = JSON.parse(request.requestJson);

  /*
   * A privileged caller (Chrome is one) computed clientDataJSON itself and sent
   * only the hash. We sign exactly those bytes and return no clientDataJSON.
   *
   * The empty case is deliberately refused rather than guessed. Building our
   * own would need the caller's origin as "android:apk-key-hash:<...>", which
   * means this app reading the CALLER's signing certificate - more native code,
   * and untestable from Chrome, which never takes this path.
   */
  if (!request.clientDataHashB64) {
    emit('read request', 'fail', 'caller sent no clientDataHash');
    throw new Error(
      'this caller is not privileged and sent no clientDataHash; building ' +
        'clientDataJSON for it is not implemented',
    );
  }
  const clientDataHash: Uint8Array = fromBase64Url(request.clientDataHashB64);
  emit(
    'read request',
    'ok',
    request.action + ' from ' + request.callerPackage + ', hash ' + clientDataHash.length + 'B',
  );

  /* ---- 2. the key ------------------------------------------------------ */

  emit('open soft key', 'run');
  const {transport} = await getOnlyKey('embedded');
  emit('open soft key', 'ok');

  /*
   * ASK BEFORE KNOCKING.
   *
   * okcore.cpp:639,651 gate FIDO dispatch on `unlocked == true` and drop the
   * packet SILENTLY otherwise - no error frame at all. So a CTAPHID init
   * against a locked key does not fail, it WAITS, and the eight-second timeout
   * that follows is indistinguishable from a key that is not there. The same
   * reasoning is already written down in src/fidoBridge.ts:47 and enforced by
   * useFidoAdmin.ts:69.
   *
   * It is not only about the error message. Opening a channel on a locked key
   * is the sequence that preceded a bench key whose VENDOR interface refused
   * writes until it was physically replugged
   * (FINDING-a-ctaphid-channel-on-a-locked-key-wedged-it.md). The soft key
   * cannot be hurt that way, but this code points at real hardware at
   * milestone 4 and the shape of it should not have to change then.
   */
  emit('key state', 'run');
  let status = await readKeyState();

  if (status.state !== 'unlocked') {
    /*
     * BEING LOCKED IS NOT A REFUSAL.
     *
     * Sending the PIN belongs to this ceremony. The browser asked for a
     * credential, the key wants to know who is asking, and making the person
     * leave for another app to answer that is a worse version of the same
     * question - it also means a passkey can only be used by someone who
     * remembered to unlock beforehand, which is not how a security key is
     * meant to feel.
     *
     * An UNINITIALIZED key is genuinely different: there is no PIN yet, so no
     * keypad would help. That one is still reported rather than prompted for.
     */
    if (status.state === 'uninitialized') {
      emit('key state', 'fail', status.state);
      throw new Error(
        'this key has never been set up, so it has no PIN and cannot hold a ' +
          'credential yet. Set it up in the OnlyKey app first.',
      );
    }

    emit('key state', 'run', status.state + ' - waiting for the PIN');
    await askUnlock(status.state);

    status = await readKeyState();
    if (status.state !== 'unlocked') {
      emit('key state', 'fail', status.state);
      throw new Error('the key is still ' + status.state + '; it was not unlocked.');
    }
  }
  emit('key state', 'ok', status.version ?? status.state);

  emit('CTAPHID init', 'run');
  const ctap = new CtapHid(transport);
  await ctap.init({timeoutMs: 8000});
  emit('CTAPHID init', 'ok');

  const admin = new FidoAdmin(ctap);

  /* ---- 3. PIN, only if the key has one --------------------------------- */

  emit('getInfo / PIN state', 'run');
  const state = await admin.pinState();
  emit(
    'getInfo / PIN state',
    'ok',
    state.set ? 'a client PIN is set' : state.supported ? 'no PIN set' : 'no PIN support',
  );

  let pin: PinAuth | undefined;
  if (state.set) {
    let retries: number | null = null;
    try {
      retries = await admin.getRetries();
    } catch {
      // getRetries is free and advisory. Not knowing the count is not a reason
      // to refuse to ask for the PIN.
      retries = null;
    }

    emit('PIN', 'run', retries === null ? undefined : retries + ' attempts left');
    const entered = await askPin(retries);
    if (!entered) {
      emit('PIN', 'fail', 'cancelled');
      throw new Error('the PIN was not entered');
    }
    const pinToken = await admin.getPinToken(entered);
    pin = {
      pinUvAuthParam: clientpin.pinTokenAuth(pinToken, clientDataHash),
      pinUvAuthProtocol: 1,
    };
    emit('PIN', 'ok', 'token obtained');
  }

  /* ---- 4. the one CTAP2 call that matters ------------------------------ */

  if (request.action === 'CREATE') {
    const creation = options as CreationOptionsJSON;
    emit('makeCredential', 'run', creation.rp?.id ?? '');
    const params = makeCredentialParams(creation, clientDataHash, pin);
    const reply = await ctap.makeCredential(params, {
      timeoutMs: 10000,
      /*
       * The firmware sends ONE keepalive when it starts wanting a finger and
       * then goes quiet for up to 19 seconds (device.cpp:172, ctap.h:173).
       * That frame is the only signal it is waiting, so the prompt is raised
       * from it rather than on a timer - too early and touch_sense_loop() has
       * already returned, too late and the window has shut.
       */
      presenceTimeoutMs: 60000,
      onKeepAlive: async () => {
        emit('touch the key', 'run');
        await askPresence();
        emit('touch the key', 'ok');
      },
    });
    emit('makeCredential', 'ok');

    emit('assemble response', 'run');
    const json = registrationResponseJSON(reply);
    emit('assemble response', 'ok', JSON.parse(json).id);
    return json;
  }

  const assertion = options as RequestOptionsJSON;
  emit('getAssertion', 'run', assertion.rpId ?? '');
  const params = getAssertionParams(assertion, clientDataHash, pin);
  const reply = await ctap.getAssertion(params, {
      timeoutMs: 10000,
      /*
       * The firmware sends ONE keepalive when it starts wanting a finger and
       * then goes quiet for up to 19 seconds (device.cpp:172, ctap.h:173).
       * That frame is the only signal it is waiting, so the prompt is raised
       * from it rather than on a timer - too early and touch_sense_loop() has
       * already returned, too late and the window has shut.
       */
      presenceTimeoutMs: 60000,
      onKeepAlive: async () => {
        emit('touch the key', 'run');
        await askPresence();
        emit('touch the key', 'ok');
      },
    });
  emit('getAssertion', 'ok');

  emit('assemble response', 'run');
  /*
   * The key may omit the credential id when the allowList held exactly one
   * entry, on the grounds that the caller already knows which one it asked
   * for. That entry is the only legitimate fallback.
   */
  const only =
    assertion.allowCredentials?.length === 1 ? assertion.allowCredentials[0].id : undefined;
  const json = authenticationResponseJSON(reply, only);
  emit('assemble response', 'ok', JSON.parse(json).id);
  return json;
}
