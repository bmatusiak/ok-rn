import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * WHO SIGNED THIS APK (EXPLAINER/app-sig-checking.md; Brad, 2026-10-13: "if the app is not
 * signed by the official release key, it shows a banner like test build ... the banner will
 * be called unofficial release").
 *
 * Someone who unpacks the APK to change it cannot sign it again with the release key - they
 * do not have it - so a repackaged app runs under some other certificate. Android says which
 * certificate signed the running APK (PackageManager signing info); the app compares its
 * SHA-256 with the official one built in (BuildConfig.OKRN_OFFICIAL_SIGNERS) and says so on
 * every screen when they differ.
 *
 * This is a notice, not a lock: whoever repackages the app can also cut the check out. It
 * tells an honest user that the copy in their hand is not the one OnlyKey released.
 */
export interface Spec extends TurboModule {
  /** The SHA-256 of the certificate that signed the running APK, AA:BB:..., or '' when Android would not say. */
  signerSha256(): string;
  /** True when that certificate is one of the official ones this build knows. */
  isOfficial(): boolean;
}

/*
 * get, not getEnforcing: on an APK built before this module existed the app must still start;
 * it just cannot tell, and shows no banner.
 */
export default TurboModuleRegistry.get<Spec>('NativeAppSignature');
