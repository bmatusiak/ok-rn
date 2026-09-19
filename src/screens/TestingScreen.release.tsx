/**
 * What `TestingScreen` resolves to in a RELEASE bundle.
 *
 * Not a feature flag and not a disabled screen - a substitution made by Metro
 * at bundle time, so the real screen and everything it pulls in are not in the
 * shipped apk at all.
 *
 * ## Why a stub rather than a gate
 *
 * Testing mode bypasses the PIN and exposes a factory reset, a soft-key wipe,
 * the on-device test runner and the raw USB surface. Gating that at runtime
 * makes it unreachable; it does not make it absent. A release apk was unzipped
 * and its bundle still contained "Enter testing mode" and "Wipe the Soft Key"
 * - so anyone unpacking it could read the whole surface and see exactly what
 * the app can be made to do.
 *
 * For an app whose entire job is a PIN, "cannot be reached" is a weaker claim
 * than "is not there", and the second one is available for the cost of this
 * file. See metro.config.js, which does the swap, and tools/release.js, which
 * fails the build if any of those strings come back.
 *
 * Nothing routes here: `useTestingMode` cannot be enabled outside `__DEV__`,
 * and App.tsx does not render the tab. This exists so the import resolves.
 */
export function TestingScreen(): null {
  return null;
}
