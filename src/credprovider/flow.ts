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
 * (FINDING-a-ctaphid-channel-on-a-locked-key-wedged-it.md). That applies for
 * real now: chooseTarget() prefers a hard key whenever one is on the bus, so
 * the locked check below is protecting hardware, not just producing a better
 * error message for the emulator.
 */
import {bytes, device as deviceLib, protocol} from 'node-onlykey-lib';
import {getOnlyKey} from '../onlykey';
import OkEmu from '../transport/OkEmu';
import UsbPipe, {PRODUCT_ID, VENDOR_ID} from '../transport/UsbPipe';
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

const {CtapHid, KEEPALIVE} = (protocol as any).ctaphid;
const {clientpin} = protocol as any;
const {FidoAdmin} = (deviceLib as any).fido;
const {version} = deviceLib as any;
const {fromBase64Url} = bytes as any;

/**
 * Which key this request is going to, and what can be done to it.
 *
 * A hard key wins when one is on the bus, because someone who has plugged a
 * key into the phone means to use THAT key - the soft key is the stand-in for
 * when there is none.
 */
export type Target = {
  backend: 'usb' | 'embedded';
  /** True for a physical key, which changes who does the pressing. */
  hard: boolean;
  /**
   * Whether the app can press this key's buttons at all.
   *
   * Three-valued in the app proper, two here because by this point we have
   * asked. A production key answers false and then the screen must say "press
   * the button on your key" rather than drawing a control that cannot work
   * (useHardKey.ts:34). A developer build with the debug console answers true.
   */
  canPress: boolean;
  /**
   * Whether a hard key is on the bus at all.
   *
   * Not the same as `hard`: someone may be deliberately using the soft key
   * WHILE a hard key is plugged in, and the screen needs to know a switch back
   * is possible. The soft key is always available, so there is no matching
   * flag for it.
   */
  hardOnBus: boolean;
};

/** What to call this key in front of a person. */
export function targetLabel(target: Target): string {
  return target.hard ? 'Hard key' : 'Soft Key';
}

export async function chooseTarget(force?: 'usb' | 'embedded'): Promise<Target> {
  let onBus = false;
  try {
    const devices = await UsbPipe.listDevices();
    onBus = devices.some(
      d => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID,
    );
  } catch {
    /* No USB at all is a soft-key answer, not an error. */
  }

  /*
   * A hard key wins by default, but never against an explicit choice. `force`
   * is someone saying "the credential is on the OTHER one" - which the app
   * cannot work out for itself, because a credential it cannot see is exactly
   * the case where it would have to ask.
   */
  if (!onBus || force === 'embedded') {
    /*
     * START THE SOFT KEY IF NOBODY ELSE HAS.
     *
     * The firmware is started by the MAIN app's startup path, and this screen
     * is not that - the system launches CredProviderActivity directly, and it
     * can be the first thing in the process to run. Without this the flow got
     * as far as "open key: the firmware running inside this app" and then
     * "key state: firmware is not running", which is an accurate message about
     * a situation nobody should be in.
     *
     * isRunning() first, because start() on a running firmware is not free and
     * the main app may well have started it already. A firmware that has been
     * STOPPED cannot be restarted in this process (see the Testing tab), so
     * this can only help the never-started case - which is the one a credential
     * request arriving cold actually hits.
     */
    if (!OkEmu.isRunning()) {
      await OkEmu.start();
    }
    return {backend: 'embedded', hard: false, canPress: true, hardOnBus: onBus};
  }

  /* start() is idempotent, so this cannot disturb a pipe the app already has. */
  if (!UsbPipe.isRunning()) {
    await UsbPipe.start();
  }

  /*
   * ASK THE CONSOLE, NEVER PRESS TO FIND OUT. consoleAnswers() writes one
   * inert byte and watches for the firmware's echo; it presses nothing, so it
   * cannot spend a PIN attempt. Ten spent attempts wipe a key
   * (FINDING #43), which makes "probe by pressing" the most expensive possible
   * way to answer this question.
   */
  let canPress = false;
  try {
    const {device} = await getOnlyKey('usb');
    canPress = (await device.consoleAnswers()) === true;
  } catch {
    canPress = false;
  }
  return {backend: 'usb', hard: true, canPress, hardOnBus: true};
}

/** One button press, on whichever key this request is talking to. */
export async function pressKeyButton(target: Target, button: number) {
  if (target.backend === 'embedded') {
    /*
     * Handed to the firmware, not sensed. This runs while a BROWSER is
     * waiting on user presence, which is the worst moment to spend the ~855ms
     * an emulated finger costs; pressQueue lands it in about 96ms. Same press
     * either way - see OkEmu.pressQueue.
     */
    await OkEmu.pressQueue(String(button));
    return;
  }
  if (!target.canPress) {
    /* The finger is the user's. Nothing to send. */
    return;
  }
  const {device} = await getOnlyKey('usb');
  await device.press(String(button));
}

/**
 * ONE CTAPHID CHANNEL, KEPT.
 *
 * CTAPHID_INIT allocates a channel record; the firmware keeps ten and frees
 * NONE (ctaphid.cpp:67). Opening one per request therefore works perfectly for
 * the first several requests and then stops working altogether - the key goes
 * on answering the vendor interface, so it looks alive, while CTAPHID says
 * nothing at all and every attempt dies on an 8s timeout. Measured on the bench
 * after a day of testing against one hard key.
 *
 * useFidoAdmin.ts:8 already carried this warning for the app's own screens.
 * This file ignored it. So: one channel per backend, held for the life of the
 * process, exactly as that hook holds one for the life of its screen.
 *
 * A key that is unplugged takes its channel with it, so any failure drops the
 * cache and the next request opens a fresh one.
 */
let held: {backend: string; ctap: any} | null = null;

async function openChannel(target: Target, transport: any) {
  if (held && held.backend === target.backend) {
    return held.ctap;
  }
  const ctap = new CtapHid(transport);
  await ctap.init({timeoutMs: 8000});
  held = {backend: target.backend, ctap};
  return ctap;
}

/** Forget the channel, so the next request opens one. */
export function dropChannel() {
  held = null;
}

/** The user-presence press, which is always button 1 on a soft key. */
export const pressForPresence = (target: Target) => pressKeyButton(target, 1);

/**
 * What the key says it is, right now.
 *
 * Exported because the unlock panel has to ask again after every digit. The
 * firmware evaluates the PIN hash after each press (OnlyKey.ino:697) and
 * announces UNLOCKED the moment it matches - there is no "submit" to wait on,
 * and no length to count up to, so the only way to know is to look.
 */
export async function readKeyState(target: Target) {
  const app = await getOnlyKey(target.backend);
  const connected = await app.device.connect();
  return version.parseStatus(String(connected?.status ?? '').trim());
}

export type StepStatus = 'run' | 'ok' | 'fail';
export type Emit = (label: string, status: StepStatus, detail?: string) => void;

/** Asks the user for the key's FIDO PIN. Resolves empty if they decline. */
export type AskPin = (retriesLeft: number | null) => Promise<string>;

/**
 * Tell the screen the key is waiting for a finger. Returns NOTHING and is
 * never awaited.
 *
 * It used to return a promise that this file awaited, and that was a design
 * mistake with real consequences. The call happens inside the CTAPHID keepalive
 * handler, which the library awaits before it resumes READING - so blocking
 * there stops us hearing the device. Someone who pressed the physical key
 * instead of the on-screen button satisfied the firmware, the firmware
 * answered, and the app sat there still showing "waiting for a touch" because
 * it was waiting on a button nobody had any reason to press. Measured on the
 * bench with a hard key.
 *
 * The rule it cost: THE UI MUST NEVER GATE THE PROTOCOL. Raise the prompt,
 * return, keep reading. A press - finger or button - reaches the key by its own
 * path, and the answer arrives when the key is satisfied.
 */
export type AskPresence = (target: Target) => void;

/**
 * The key is locked. Resolves once the person has unlocked it.
 *
 * A passkey is not worth much if using it requires having already opened
 * another app first, so the ceremony the browser started carries the unlock
 * too.
 */
export type AskUnlock = (state: string, target: Target) => Promise<void>;

export async function runCredentialFlow(
  request: PendingCredRequest,
  emit: Emit,
  askPin: AskPin,
  askPresence: AskPresence,
  askUnlock: AskUnlock,
  opts: {force?: 'usb' | 'embedded'; onTarget?: (target: Target) => void} = {},
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

  emit('open key', 'run');
  const target = await chooseTarget(opts.force);
  opts.onTarget?.(target);
  const {transport} = await getOnlyKey(target.backend);
  emit(
    'open key',
    'ok',
    target.hard
      ? 'over USB' + (target.canPress ? ', console presses' : ', press it yourself')
      : 'the firmware running inside this app',
  );

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
  let status = await readKeyState(target);

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
    await askUnlock(status.state, target);

    status = await readKeyState(target);
    if (status.state !== 'unlocked') {
      emit('key state', 'fail', status.state);
      throw new Error('the key is still ' + status.state + '; it was not unlocked.');
    }
  }
  emit('key state', 'ok', status.version ?? status.state);

  emit('CTAPHID init', 'run');
  let ctap;
  try {
    ctap = await openChannel(target, transport);
  } catch (e) {
    dropChannel();
    throw e;
  }
  emit('CTAPHID init', 'ok', held ? 'channel reused where possible' : undefined);

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

  /* Whether a touch was ever asked for, so it can be marked done afterwards. */
  let raisedPresence = false;

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
      onKeepAlive: async (status: number) => {
        /*
         * ONLY UP_NEEDED MEANS A FINGER.
         *
         * A keepalive carries a status and there are two of them
         * (ctaphid.js:148): PROCESSING 0x01, the key saying it is busy, and
         * UP_NEEDED 0x02, the key saying it is waiting for a touch. This
         * handler used to ignore the byte and prompt for BOTH, so every
         * ceremony asked for a second press it did not need - the key sends
         * PROCESSING while it computes the signature, immediately after the
         * press that satisfied it. Reported from the bench as "I press it, and
         * then I have to press it again", and blamed on the firmware, which
         * was doing exactly what it should.
         *
         * The stray press was harmless here only because nothing was waiting
         * on it. Asking a person to touch a security key when nothing is
         * asking for a touch is worse than a wasted tap: it teaches them to
         * confirm prompts they have not read.
         */
        if (status !== KEEPALIVE.UP_NEEDED) {
          emit('key is working', 'run');
          return;
        }
        emit('key is working', 'ok');
        emit('touch the key', 'run');
        /* Not awaited - see AskPresence. The read loop must not stop here. */
        askPresence(target);
        raisedPresence = true;
      },
    });
    if (raisedPresence) {
      emit('touch the key', 'ok');
    }
    emit('makeCredential', 'ok');

    emit('assemble response', 'run');
    /*
     * Chrome refuses a registration response with no `transports`, so one is
     * always sent - and it is true either way: a hard key is reached over USB,
     * and the soft key is firmware inside this phone, which is "internal".
     */
    const json = registrationResponseJSON(
      reply,
      undefined,
      target.hard ? ['usb'] : ['internal'],
    );
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
      onKeepAlive: async (status: number) => {
        /*
         * ONLY UP_NEEDED MEANS A FINGER.
         *
         * A keepalive carries a status and there are two of them
         * (ctaphid.js:148): PROCESSING 0x01, the key saying it is busy, and
         * UP_NEEDED 0x02, the key saying it is waiting for a touch. This
         * handler used to ignore the byte and prompt for BOTH, so every
         * ceremony asked for a second press it did not need - the key sends
         * PROCESSING while it computes the signature, immediately after the
         * press that satisfied it. Reported from the bench as "I press it, and
         * then I have to press it again", and blamed on the firmware, which
         * was doing exactly what it should.
         *
         * The stray press was harmless here only because nothing was waiting
         * on it. Asking a person to touch a security key when nothing is
         * asking for a touch is worse than a wasted tap: it teaches them to
         * confirm prompts they have not read.
         */
        if (status !== KEEPALIVE.UP_NEEDED) {
          emit('key is working', 'run');
          return;
        }
        emit('key is working', 'ok');
        emit('touch the key', 'run');
        /* Not awaited - see AskPresence. The read loop must not stop here. */
        askPresence(target);
        raisedPresence = true;
      },
    });
  if (raisedPresence) {
    emit('touch the key', 'ok');
  }
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
