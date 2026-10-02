import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * RSA key generation for Key Chain, by OpenSSL (owner, 2026-10-01).
 *
 * The OnlyKey cannot generate RSA, and the JavaScript engine here (Hermes)
 * has no WebCrypto - so node-onlykey-lib's WebCrypto shim takes a HOST
 * generator (webcrypto/subtle install({ rsaGenerate })), and this is ok-rn's:
 * OpenSSL's vetted generator (native-sea-openssl, pinned in
 * android/okssl/build.gradle; NativeRsaGenModule -> OkSsl.rsaPrimes) rather
 * than a prime search written in JavaScript. It began as Android's own
 * KeyPairGenerator and moved to OpenSSL in 05a4cc3.
 *
 * Only the two primes cross: the lib completes the key from them, checks the
 * modulus size, and Key Chain loads it onto the key and/or exports an
 * encrypted copy, then wipes it. Nothing is stored on this side.
 */
export interface Spec extends TurboModule {
  /**
   * A fresh RSA key's primes, "<p hex>:<q hex>", each exactly bits/16 bytes.
   * Rejects with RSA_GEN on any failure.
   */
  generatePrimes(bits: number, publicExponent: number): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeRsaGen');
