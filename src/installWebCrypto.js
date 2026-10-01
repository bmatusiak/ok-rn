/**
 * Put a `crypto.subtle` on the global, as a side effect of being imported.
 *
 * A MODULE rather than a call in index.js, because `import` statements are
 * hoisted: a bare `installWebCrypto()` written between two imports runs after
 * BOTH module bodies have already been evaluated, so anything that reached for
 * WebCrypto while loading would still have missed it. Importing a module for
 * its side effect is the only way to order this against other imports, which is
 * why `react-native-get-random-values` is shaped the same way.
 *
 * ## Why it is needed at all
 *
 * React Native has `crypto.getRandomValues` and no `subtle`. OpenPGP.js v6
 * reads WebCrypto at MODULE SCOPE - a dozen `const webCrypto$N =
 * util.getWebCrypto()` lines - and that throws when subtle is absent, so the
 * vendored fork dies inside its own factory. Metro's guardedLoadModule catches
 * the error, reports it to ErrorUtils and returns undefined WITHOUT
 * rethrowing, which is why `require()` appeared to return undefined for no
 * reason. See FINDING-the-openpgp-fork-does-not-load-under-hermes.md.
 *
 * The implementation is in the library, backed by @noble - the same primitives
 * this app already ships - and it refuses to replace a real SubtleCrypto, so
 * this is a no-op wherever the platform provides one.
 */
import {install} from 'node-onlykey-lib/webcrypto';
import {installTextCodecs} from 'node-onlykey-lib/webcrypto/text';
import {bytes} from 'node-onlykey-lib';
import NativeRsaGen from '../specs/NativeRsaGen';
import NativeKdf from '../specs/NativeKdf';

/*
 * RSA GENERATION - Android's generator, lent to the shim (Key Chain).
 *
 * The shim cannot make an RSA key on its own (@noble has no RSA), so it asks
 * the host for two primes and builds the rest itself; openpgp's RSA keygen and
 * Key Chain's hostKey('rsa') both go through it. specs/NativeRsaGen.ts says
 * why the platform's generator and not a JavaScript one.
 */
async function rsaGenerate(bits, e) {
  const [p, q] = (await NativeRsaGen.generatePrimes(bits, e)).split(':');
  return {p: bytes.fromHex(p), q: bytes.fromHex(q)};
}

/*
 * PBKDF2 - Android's, natively (specs/NativeKdf.ts). Key Chain's encrypted
 * copies use 600000 rounds: about a second here, a long wait in JavaScript.
 */
async function pbkdf2(password, salt, iterations, dkLen) {
  return bytes.fromHex(await NativeKdf.pbkdf2Sha256(bytes.toHex(password), bytes.toHex(salt), iterations, dkLen));
}

const result = install({rsaGenerate, pbkdf2});

/*
 * TextEncoder and TextDecoder, absent from Hermes for the same reason.
 *
 * Composite key GENERATION works without them; reading the armour back does
 * not - openpgp's `read()` calls decodeUTF8 the moment it parses one. So the
 * gap only shows up on the second thing you do, which is how vault.js came to
 * ship a `new TextDecoder()` that passed twenty-one Node tests and threw on
 * the phone.
 */
const textResult = installTextCodecs();

/**
 * What happened, for a screen or a test that wants to say.
 *
 * Not thrown on failure: a phone with no WebCrypto and no shim can still do
 * everything except PGP, and refusing to start the app over it would be a
 * worse outcome than the feature being unavailable.
 */
export const webCryptoInstall = result;

/** Which text codecs had to be supplied, for the same reason. */
export const textCodecInstall = textResult;
