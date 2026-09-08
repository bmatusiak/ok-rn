import React, {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
// test-moniker is plain CommonJS; allowJs picks up its types structurally.
import MonikerView from 'test-moniker/MonikerView';

import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';

/**
 * The on-device end-to-end suite.
 *
 * test-moniker runs tests INSIDE the app on the phone, which is the only place
 * the answers mean anything: the whole point of this project is firmware
 * compiled for Android and reached over JNI, and none of that exists in Node
 * or in a Jest environment.
 *
 * BEHIND A BUTTON, NOT BEHIND THE TAB.
 *
 * MonikerView auto-runs shortly after it mounts, so while it was rendered
 * directly by this screen, merely SELECTING THE TAB started the suite - and the
 * suite reloads the JS bundle when it finishes. That stops the firmware, and
 * the firmware cannot be started again in this process (its thread only exits
 * through the AIRCR trap, and nativeStart refuses to spawn a second one). So
 * one stray tap on a tab left the whole app dead until it was force-stopped:
 *
 *     'Tests already running - reloading'
 *     okemu: firmware stopped
 *     [softkey] firmware did not start
 *
 * Tabs are for looking at things. Running a suite that tears down the device is
 * a decision, so it needs a press.
 */
export function E2EScreen() {
  const [armed, setArmed] = useState(false);

  if (armed) {
    return (
      <View style={styles.wrap}>
        <MonikerView tests={require('../../__e2e_tests__')} />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Section title="On-device suite">
        <Text style={styles.hint}>
          Runs the whole suite against the firmware in this app — boot, unlock,
          slots, CTAPHID, the BLE bridge. It is the only place these answers
          mean anything, because the device here is real C over JNI.
        </Text>
        <Text style={styles.warn}>
          It ends by reloading, which stops the firmware — and the firmware
          cannot be restarted in this process. Expect to force-stop and reopen
          the app afterwards.
        </Text>
        <View style={styles.row}>
          {/* Labelled to match what tools/e2e.js looks for, so the suite can
              still be driven from a terminal without touching the phone. */}
          <Btn title="RUN TESTS" tone="primary" onPress={() => setArmed(true)} />
        </View>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: theme.bg},
  hint: {color: theme.textDim, fontSize: 11, lineHeight: 16},
  warn: {color: theme.warn, fontSize: 11, lineHeight: 16, marginTop: 10},
  row: {marginTop: 14},
});
