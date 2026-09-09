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

const result = install();

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
