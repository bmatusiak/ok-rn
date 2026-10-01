import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * The linked OpenSSL's self-checks (android/okssl), for the e2e suite - owner,
 * 2026-10-01: "OpenSSL is all about security, so test its core for sanity and
 * randomness". Key Chain itself uses NativeRsaGen and NativeKdf; nothing in
 * the app draws keys or secrets from here.
 */
export interface Spec extends TurboModule {
  /** OpenSSL_version(OPENSSL_VERSION), e.g. "OpenSSL 3.5.9 ...". */
  version(): Promise<string>;
  /** RAND_status() == 1: the RNG says it is seeded. */
  randStatus(): Promise<boolean>;
  /** RAND_bytes(n), hex. 1..65536 bytes. */
  randomBytes(n: number): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeOkSsl');
