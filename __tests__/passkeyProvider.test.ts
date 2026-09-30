/**
 * "yes" only when Android lists the app as an enabled passkey provider.
 * Android 14 alone said "yes" on a moto g 5G (2023) whose Settings cannot
 * switch the provider on - the false positive these pin down.
 */
import {passkeyProviderText} from '../src/hooks/usePasskeyProvider';

const status = (supported: boolean, enabled: boolean, settingsAvailable: boolean) => ({
  supported,
  enabled,
  settingsAvailable,
});

describe('passkeyProviderText', () => {
  it('says yes only when Android lists the provider as enabled', () => {
    expect(passkeyProviderText(status(true, true, true), 34)).toBe('yes, turned on');
    expect(passkeyProviderText(status(true, true, false), 34)).toBe('yes, turned on');
  });

  it('never says yes when it is off, even with the settings screen there', () => {
    expect(passkeyProviderText(status(true, false, true), 34)).toBe('off');
  });

  it('says unavailable on a phone with no settings screen (the moto case)', () => {
    expect(passkeyProviderText(status(true, false, false), 34)).toMatch(/^not available/);
  });

  it('names Android 14 below API 34, and the build above it', () => {
    expect(passkeyProviderText(status(false, false, false), 33)).toBe('no, needs Android 14');
    expect(passkeyProviderText(status(false, false, false), 34)).toBe('not in this build');
  });

  it('says it is checking before Android has answered', () => {
    expect(passkeyProviderText(null, 34)).toBe('checking…');
  });
});
