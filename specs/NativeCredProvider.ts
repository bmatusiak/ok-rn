import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * The bridge for the Android Credential Manager experiment.
 *
 * EXPERIMENT — see REMOVAL.md. Delete this file, src/credprovider/ and the
 * com.okrn.credprovider package to remove it.
 *
 * Why a module at all, when the request already arrives as an Intent: the
 * request is delivered to a system-launched ACTIVITY, and the activity is
 * Kotlin. JS never sees the Intent. This is the narrowest possible pipe across
 * that gap — hand the request over as a string, take an answer back as a
 * string, and keep every decision about what the bytes MEAN on the JS side,
 * where node-onlykey-lib already knows CBOR, COSE and clientPIN.
 *
 * There is deliberately no event emitter. The request exists before the surface
 * mounts and never changes, so a pull is honest and a subscription would only
 * add a race where the screen can miss the one event it exists for.
 */

/** What Android handed us, flattened for JS. */
export type PendingCredRequest = {
  /**
   * 'CREATE' for navigator.credentials.create(), 'GET' for .get(), or 'NONE'
   * when the activity was reached without a live request — which happens if
   * the user rotates or returns to a finished sheet, and is not an error.
   */
  action: 'CREATE' | 'GET' | 'NONE';

  /** The app that made the WebAuthn call, e.g. 'com.android.chrome'. */
  callerPackage: string;

  /**
   * The W3C JSON serialization of the request: PublicKeyCredentialCreationOptionsJSON
   * for CREATE, PublicKeyCredentialRequestOptionsJSON for GET. Passed through
   * verbatim, parsed in JS.
   */
  requestJson: string;

  /**
   * base64url of the 32-byte hash the CALLER computed, or '' when absent.
   *
   * This is the single most important field. A privileged caller — Chrome is
   * one, measured on the bench 2026-09-17 — computes clientDataJSON itself and
   * passes only this hash. When it is present these exact bytes are what the
   * key must sign, and the response must carry NO clientDataJSON of ours: the
   * browser already holds the real one, and a second one differing by so much
   * as a key order is an origin mismatch at the relying party.
   *
   * Empty means we are talking to a non-privileged caller and must build
   * clientDataJSON ourselves.
   */
  clientDataHashB64: string;
};

export interface Spec extends TurboModule {
  /**
   * The request this activity was launched for. Rejects only if the activity
   * is gone; an absent request comes back as action 'NONE'.
   */
  getPendingRequest(): Promise<PendingCredRequest>;

  /**
   * Hand the finished WebAuthn response back to the caller and close.
   *
   * @param responseJson the W3C registrationResponseJSON or
   *   authenticationResponseJSON, already assembled in JS.
   * @returns true once the result has been set. The activity finishes itself
   *   immediately afterwards, so nothing should be scheduled after this.
   */
  respond(responseJson: string): Promise<boolean>;

  /**
   * Give up, telling the caller why.
   *
   * Always preferred to simply finishing: a cancelled activity leaves Chrome
   * waiting on a PendingIntent that will never answer, and the page hangs until
   * the framework's own timeout rather than showing the user an error.
   */
  fail(message: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeCredProvider');
