import NativeAppSignature from '../specs/NativeAppSignature';

/*
 * The APK's signer, read once at start (specs/NativeAppSignature.ts). `unofficial` drives the
 * UNOFFICIAL RELEASE banner; false when Android would not say or the module is missing (an APK
 * from before it), because the app cannot tell then - it does not guess.
 */
function read(): {sha256: string; unofficial: boolean} {
  if (!NativeAppSignature) return {sha256: '', unofficial: false};
  try {
    const sha256 = NativeAppSignature.signerSha256();
    return {sha256, unofficial: sha256 !== '' && !NativeAppSignature.isOfficial()};
  } catch {
    return {sha256: '', unofficial: false};
  }
}

export const appSignature = read();
