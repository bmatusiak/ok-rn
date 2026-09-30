/**
 * Whether Chrome on this phone can use the app for passkeys - and the words
 * that say so without promising what the phone cannot do.
 *
 * ## No false "yes"
 *
 * The This Key panel used to answer "yes" on any Android 14 phone. On a moto g
 * 5G (2023) with Android 14 that was wrong: the provider is installed, but
 * Chrome never offers it. The status is now read from Android
 * (NativeCredProviderModule.providerStatus) and "yes" means Android lists the
 * app as an ENABLED provider - nothing less.
 *
 * ## Why the settings button cannot be trusted to help
 *
 * Both the Pixel (Android 17) and the moto resolve the provider-settings
 * request to the SAME Settings activity (Settings$AccountDashboardActivity).
 * The Pixel's page is "Passwords, passkeys & accounts", with a switch for
 * OnlyKey; Motorola's is the older "Passwords & accounts", with none. Nothing
 * the app can query tells the two apart. So the button promises only to OPEN
 * the page, the text says what to look for there, and on the way back the
 * status is read again: still off after a visit is said plainly - that is the
 * one moment the app can know the page did not help.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {AppState, Platform} from 'react-native';
import NativeCredProvider, {type ProviderStatus} from '../../specs/NativeCredProvider';

const PASSKEY_PROVIDER_MIN_API = 34;

export type PasskeyProvider = {
  /** null while Android is being asked. */
  status: ProviderStatus | null;
  /** The status in words, for a row. */
  text: string;
  /** True once the user came back from the settings page and it is still off. */
  stillOffAfterVisit: boolean;
  /** Opens the phone's passkey settings; false when it has none. */
  openSettings: () => Promise<boolean>;
};

export function passkeyProviderText(status: ProviderStatus | null, api: number): string {
  if (status === null) return 'checking…';
  if (!status.supported) {
    return api < PASSKEY_PROVIDER_MIN_API ? 'no, needs Android 14' : 'not in this build';
  }
  if (status.enabled) return 'yes, turned on';
  if (status.settingsAvailable) return 'off';
  return "not available: this phone's settings have no way to turn it on";
}

export function usePasskeyProvider(): PasskeyProvider {
  const api = Platform.OS === 'android' ? Number(Platform.Version) : 0;
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [stillOffAfterVisit, setStillOffAfterVisit] = useState(false);
  /* Set when the settings page is opened; read once, on the way back. */
  const visited = useRef(false);

  const refresh = useCallback(() => {
    NativeCredProvider.providerStatus()
      .then(next => {
        setStatus(next);
        if (visited.current) {
          visited.current = false;
          setStillOffAfterVisit(!next.enabled);
        } else if (next.enabled) {
          setStillOffAfterVisit(false);
        }
      })
      .catch(() => setStatus({supported: false, enabled: false, settingsAvailable: false}));
  }, []);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const openSettings = useCallback(async () => {
    const opened = await NativeCredProvider.openProviderSettings().catch(() => false);
    visited.current = opened;
    return opened;
  }, []);

  return {status, text: passkeyProviderText(status, api), stillOffAfterVisit, openSettings};
}
