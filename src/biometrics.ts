import NativeSecrets from '../specs/NativeSecrets';

/**
 * Biometric-gated secrets, as a capability rather than one button.
 *
 * Three things want it and they want the same machinery:
 *
 *   REVEAL      show a slot password or a derived key, behind a prompt
 *   AUTO-UNLOCK remember the device PIN so unlocking is a fingerprint
 *   CONFIRM     gate an action that is hard to undo
 *
 * The prompt is not what protects anything. A boolean returned from native code
 * is a boolean, and a boolean can be made to say true. What protects a stored
 * secret is that its AES key lives in the Android Keystore with
 * `setUserAuthenticationRequired`, so the ciphertext cannot be decrypted at all
 * without a real authentication - not by this app, and not by anything that can
 * read the app's files. See android/.../secrets/BiometricVault.kt.
 *
 * ## Storing the device PIN is a real trade-off
 *
 * An OnlyKey is two factors: the key you have and the PIN you know. Here the
 * key IS the phone, so storing the PIN on it puts both factors in one place,
 * and whoever passes the biometric has both. That is a defensible choice - it
 * is roughly what a phone's own lock screen offers - and it is not one to make
 * on someone's behalf. `PIN_WARNING` is the sentence a screen shows before
 * offering it.
 */

/** Aliases, in one place so two screens cannot disagree about a name. */
export const ALIAS = {
  /** The device PIN, for auto-unlock. */
  devicePin: 'device-pin',
} as const;

/** What a screen says before offering to remember the PIN. */
export const PIN_WARNING =
  'Your OnlyKey is two things: the key you have and the PIN you know. Here the ' +
  'key is this phone — so storing the PIN on it puts both on one device, and ' +
  'anyone who can pass your biometric has both.';

export type BiometricStatus =
  | 'available'
  | 'none-enrolled'
  | 'no-hardware'
  | 'unavailable';

/** What each status means for a screen, in words someone can act on. */
export const STATUS_TEXT: Record<BiometricStatus, string> = {
  available: 'Ready.',
  /* Fixable by the person holding the phone, which is why it is not merged
     with 'unavailable'. */
  'none-enrolled': 'No fingerprint or face is set up on this phone yet.',
  'no-hardware': 'This phone has no biometric hardware.',
  unavailable: 'Biometrics are not usable right now.',
};

export async function status(): Promise<BiometricStatus> {
  try {
    return (await NativeSecrets.biometricStatus()) as BiometricStatus;
  } catch {
    // A module that cannot answer is not available, and saying so beats
    // throwing from a screen that only wanted to decide whether to show a row.
    return 'unavailable';
  }
}

export async function isAvailable(): Promise<boolean> {
  return (await status()) === 'available';
}

/** Whether something is stored under this alias. Does NOT prompt. */
export function has(alias: string): Promise<boolean> {
  return NativeSecrets.biometricHas(alias);
}

/** Store a secret behind the prompt. Prompts, because using the key requires it. */
export function store(
  alias: string,
  secret: string,
  title: string,
  subtitle: string,
): Promise<boolean> {
  return NativeSecrets.biometricStore(alias, secret, title, subtitle);
}

/**
 * Prompt and return the secret.
 *
 * Rejects when the prompt is cancelled, and separately when the stored secret
 * was destroyed because the phone's biometrics changed - which is not a failure
 * to retry but a reason to offer storing it again.
 */
export function load(
  alias: string,
  title: string,
  subtitle: string,
): Promise<string> {
  return NativeSecrets.biometricLoad(alias, title, subtitle);
}

export function forget(alias: string): Promise<boolean> {
  return NativeSecrets.biometricForget(alias);
}

/**
 * Was this rejection the enrolment case?
 *
 * Worth telling apart: everything else means "try again", and this one means
 * "it is gone, store it afresh". The key is destroyed on purpose when
 * biometrics change - otherwise a fingerprint added later by whoever has the
 * unlocked phone would open secrets stored before it.
 */
export function wasInvalidated(error: unknown): boolean {
  return /biometrics changed/i.test(String((error as Error)?.message ?? error));
}

/**
 * Run something behind a prompt, without storing anything.
 *
 * The REVEAL case. There is no secret to seal, so this stores a marker under a
 * per-purpose alias and reads it back - which means the gate is still the
 * Keystore's authentication requirement rather than a boolean this code
 * decided. A prompt that only returned true would be a prompt in front of an
 * `if`.
 */
export async function confirm(
  purpose: string,
  title: string,
  subtitle: string,
): Promise<boolean> {
  const alias = `confirm:${purpose}`;
  const marker = 'ok';
  if (!(await has(alias))) {
    await store(alias, marker, title, subtitle);
    return true;
  }
  const back = await load(alias, title, subtitle);
  return back === marker;
}
