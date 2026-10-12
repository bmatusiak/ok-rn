import React, {useCallback, useEffect, useState} from 'react';
import {AppState, NativeModules, StyleSheet, Text, View} from 'react-native';

import {Btn} from '../../../ui/components';
import {theme} from '../../../ui/theme';

/*
 * TURNING AUTOFILL ON, from the Passwords tab. Two switches, and both must be on for Chrome:
 *  - the phone's autofill service is OnlyKey (Android's own chooser - opened from here);
 *  - Chrome's own setting, Settings > Autofill settings > "Autofill using another service" (Chrome
 *    has no link into it; seen on the Pixel, Chrome 155, 2026-10-11 - until it is set, Chrome
 *    shows Google's passwords and never asks OnlyKey).
 * Apps (not Chrome) need only the first.
 */

type Native = {status(): Promise<{supported: boolean; enabled: boolean}>; openSettings(): Promise<boolean>};
const OkAutofill: Native | undefined = NativeModules.OkAutofill;

export function AutofillCard() {
  const [status, setStatus] = useState<{supported: boolean; enabled: boolean} | null>(null);
  const refresh = useCallback(() => {
    OkAutofill?.status().then(setStatus).catch(() => setStatus(null));
  }, []);
  /* read again when the person comes back from the phone's settings */
  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', s => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);

  if (!OkAutofill) return <Text style={styles.dim}>This build has no Autofill.</Text>;
  if (status && !status.supported) return <Text style={styles.dim}>This phone has no autofill.</Text>;
  return (
    <View>
      <Text style={[styles.body, {color: status?.enabled ? theme.ok : theme.text}]}>
        {status?.enabled
          ? 'OnlyKey is this phone\'s autofill service.'
          : 'OnlyKey is not this phone\'s autofill service yet.'}
      </Text>
      <Text style={styles.dim}>
        A login form then shows an "OnlyKey" row; tapping it opens OnlyKey to pick the entry for that site. In
        Chrome, also choose Settings › Autofill settings › "Autofill using another service".
      </Text>
      {status?.enabled ? null : (
        <View style={styles.buttons}>
          <Btn title="Turn on Autofill" tone="primary" onPress={() => void OkAutofill.openSettings().catch(() => {})} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {fontSize: 14, lineHeight: 20},
  dim: {color: theme.textDim, fontSize: 12, lineHeight: 17, marginTop: 4},
  buttons: {flexDirection: 'row', gap: 8},
});
