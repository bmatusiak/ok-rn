import React, {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
// The harness is VENDORED into this repo - see __e2e_tests__/harness/README.md.
// It is plain CommonJS; allowJs picks up its types structurally.
import MonikerView from '../../__e2e_tests__/harness/MonikerView';

import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';

/**
 * The suites to hand MonikerView, narrowed by __e2e_tests__/only.js.
 *
 * Iterating on one suite meant sitting through all thirteen, which is minutes
 * per attempt against a device that has to be pressed and unlocked. The filter
 * makes that one suite; the full run is what happens by default and before a
 * commit, because only.js is restored to empty after every filtered run.
 *
 * A name matching nothing THROWS rather than running zero suites. An empty run
 * reports a pass, and a pass from a typo is the worst outcome available here.
 */
function selected() {
  /*
   * Deliberately NOT annotated. MonikerView is plain CommonJS with no types, so
   * its `tests` prop infers as never[]; giving this an explicit array type makes
   * the assignment an error where the untyped require was simply accepted.
   */
  const all = require('../../__e2e_tests__');
  const only: string[] = require('../../__e2e_tests__/only.js');
  if (!only.length) {
    return all;
  }

  const picked = all.filter((suite: {name: string}) => only.includes(suite.name));
  if (picked.length !== only.length) {
    const found = picked.map((s: {name: string}) => s.name);
    throw new Error(
      `__e2e_tests__/only.js names suites that do not exist: ` +
        `${only.filter(n => !found.includes(n)).join(', ')}. ` +
        `Known: ${all.map((s: {name: string}) => s.name).join(', ')}`,
    );
  }
  return picked;
}

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
export function E2EScreen({onRunStart}: {onRunStart?: () => void}) {
  const [armed, setArmed] = useState(false);

  if (armed) {
    /*
     * Read at run time, not at module load, so tools/e2e.js can write it and
     * have Metro serve the new value without the screen caching the old one.
     */
    const options: {bail?: boolean} = require('../../__e2e_tests__/runOptions.js');
    return (
      <View style={[styles.wrap, styles.armed]}>
        <MonikerView tests={selected()} bail={options.bail === true} />
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
          <Btn
            title="RUN TESTS"
            tone="primary"
            onPress={() => {
              /*
               * BLUETOOTH OFF FIRST, and this is not tidiness.
               *
               * backupCapture holds button 1 past the gesture band on
               * purpose, and the key answers by TYPING ITS WHOLE BACKUP on
               * the keyboard interface. The suite expects to capture that
               * itself. But if this phone is paired to a computer as a BLE
               * keyboard, the keystrokes go there instead - into whatever
               * window happens to have focus.
               *
               * Measured, once, the hard way (2026-09-20): the backup was
               * typed into the terminal driving the run, the app lost the
               * screen, and the suite aborted with no verdict. The key
               * material went somewhere nobody chose.
               *
               * Turning it off here rather than in tools/e2e.js because the
               * run can be started from the phone too, and the hazard is the
               * run's, not the runner's.
               */
              onRunStart?.();
              setArmed(true);
            }}
          />
        </View>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {backgroundColor: theme.bg},
  /*
   * A minHeight, not flex: 1, and only once the suite is mounted.
   *
   * This screen sits inside the Testing tab's ScrollView, and a flex child of
   * a scrolling container has no height to take a share of - MonikerView
   * collapsed to a white sliver under the banner, visible only because it
   * draws its own light background. Applying the height unconditionally was
   * the other half of the same mistake: it left 520px of nothing above the USB
   * section whenever the suite was NOT running.
   */
  armed: {minHeight: 520},
  hint: {color: theme.textDim, fontSize: 11, lineHeight: 16},
  warn: {color: theme.warn, fontSize: 11, lineHeight: 16, marginTop: 10},
  row: {marginTop: 14},
});
