import React, {useState} from 'react';
import {Platform, StatusBar, StyleSheet, Text, View} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {Segmented} from './src/ui/components';
import {theme} from './src/ui/theme';
import {useLog} from './src/hooks/useLog';
import {UsbScreen} from './src/screens/UsbScreen';
import {FidoScreen} from './src/screens/FidoScreen';
import {SoftKeyScreen} from './src/screens/SoftKeyScreen';
import {E2EScreen} from './src/screens/E2EScreen';

// Soft key first: the phone being the OnlyKey is the point, and a physical
// key over USB is the optional extra rather than the other way round.
const TABS = ['Soft key', 'USB HID', 'FIDO2 BLE', 'E2E'] as const;
type Tab = (typeof TABS)[number];

/*
 * The provider has to be ABOVE whatever reads the insets, so the shell is a
 * separate component rather than one function with a hook in it -
 * useSafeAreaInsets() inside App would be reading a provider that is its own
 * child, and gets zeros.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('Soft key');
  const insets = useSafeAreaInsets();

  // One log buffer per screen so switching tabs does not interleave traffic.
  const usbLog = useLog();
  const fidoLog = useLog();
  const emuLog = useLog();

  return (
    <>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>OnlyKey RN</Text>
          <Text style={styles.subtitle}>{Platform.OS} · hardware bridge scaffold</Text>
        </View>

        <View style={styles.tabs}>
          <Segmented options={TABS} value={tab} onChange={setTab} />
        </View>

        {/*
          A floor under the bottom inset, not just the inset.

          This handset reports zero: its navigation bar sits OUTSIDE the app
          window (the window is 1465 of 1600 pixels), so there is nothing to
          inset past - and the last section then ends on the final pixel of the
          window, hard against the buttons, with its own bottom border clipped.
          A phone using gesture navigation reports a real inset instead and
          needs it honoured. Taking the larger of the two covers both without
          asking which kind of phone this is.
        */}
        <View style={[styles.body, {paddingBottom: Math.max(insets.bottom, 12)}]}>
          {tab === 'Soft key' ? (
            <SoftKeyScreen entries={emuLog.entries} log={emuLog.log} clear={emuLog.clear} />
          ) : tab === 'USB HID' ? (
            <UsbScreen entries={usbLog.entries} log={usbLog.log} clear={usbLog.clear} />
          ) : tab === 'FIDO2 BLE' ? (
            <FidoScreen entries={fidoLog.entries} log={fidoLog.log} clear={fidoLog.clear} />
          ) : (
            <E2EScreen />
          )}
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: theme.bg},
  header: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12},
  title: {color: theme.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.4},
  subtitle: {color: theme.textDim, fontSize: 12, marginTop: 2},
  tabs: {paddingHorizontal: 16, paddingBottom: 12},
  body: {flex: 1, paddingHorizontal: 16},
});
