import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * RANDOM BYTES FROM ANDROID'S SecureRandom, our own (Brad, 2026-10-18: "as a security app, we
 * must vendor anything we use for creating crypto stuff" - "replace it with our own"). It replaced
 * the react-native-get-random-values package: every key, nonce and seed the JS side makes draws
 * on this, so it lives in this repo where it can be read.
 *
 * src/installRandom.js puts it on the global as crypto.getRandomValues, before anything else runs.
 */
export interface Spec extends TurboModule {
  /** `byteLength` random bytes as lower-case hex (at most 65536, Web Crypto's limit). */
  getRandomHex(byteLength: number): string;
}

/* getEnforcing: the app must not run without it - there is no acceptable fallback for randomness */
export default TurboModuleRegistry.getEnforcing<Spec>('NativeRandom');
