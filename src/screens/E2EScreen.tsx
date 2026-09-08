import React from 'react';
import {StyleSheet, View} from 'react-native';
// test-moniker is plain CommonJS; allowJs picks up its types structurally.
import MonikerView from 'test-moniker/MonikerView';

import {theme} from '../ui/theme';

/**
 * The on-device end-to-end suite.
 *
 * test-moniker runs tests INSIDE the app on the phone, which is the only place
 * the answers mean anything: the whole point of this project is firmware
 * compiled for Android and reached over JNI, and none of that exists in Node
 * or in a Jest environment.
 *
 * The suite has been in `__e2e_tests__/` for some time and, as far as anything
 * shows, has never run - nothing referenced MonikerView, so there was no way to
 * reach it. This screen is that missing half.
 *
 * BEHIND A TAB, DELIBERATELY. MonikerView auto-runs shortly after it mounts,
 * and these tests stop the firmware, start it again and provision a PIN. Doing
 * that at app launch would fight the soft-key screen's own auto-start for the
 * same single firmware thread. Selecting the tab is the trigger.
 */
export function E2EScreen() {
  return (
    <View style={styles.wrap}>
      <MonikerView tests={require('../../__e2e_tests__')} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: theme.bg},
});
