import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * Android's native PBKDF2-HMAC-SHA256, lent to node-onlykey-lib
 * (webcrypto/subtle install({ pbkdf2 })) - owner, 2026-10-01.
 *
 * Key Chain protects an exported private key with 600000 PBKDF2 rounds. In
 * JavaScript under Hermes (no JIT) that is a long wait; natively it is about
 * a second. Bytes in, bytes out (hex across the bridge), so the passphrase is
 * hashed exactly as the lib encoded it - no character-set guesswork on this
 * side. The lib checks the result's length and falls back to its own loop
 * where no native one is lent.
 */
export interface Spec extends TurboModule {
  /** PBKDF2-HMAC-SHA256(password, salt, iterations) -> dkLen bytes, all hex. Rejects with KDF on failure. */
  pbkdf2Sha256(passwordHex: string, saltHex: string, iterations: number, dkLen: number): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeKdf');
