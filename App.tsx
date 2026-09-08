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
import {useFidoGatt} from './src/hooks/useFidoGatt';
import {useOkEmu} from './src/hooks/useOkEmu';
import {useUsbHid} from './src/hooks/useUsbHid';
import {Btn} from './src/ui/components';
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

  /*
   * The BLE session is app-scoped on purpose. It holds the GATT server and the
   * bridge that answers CTAP requests from the firmware, and both have to
   * outlive whichever tab happens to be showing - a host does not know or care
   * which screen is in front.
   */
  const fido = useFidoGatt({log: fidoLog.log});
  const emu = useOkEmu({log: emuLog.log, autoStart: true});
  const hid = useUsbHid({log: usbLog.log});

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
          Above the tabs, and on every one of them.

          The only affordance for this used to be a button inside the FIDO
          screen's "Pending request" section - which meant scrolling to find it,
          on the right tab, during the nineteen seconds the firmware waits. A
          browser says "press the button on your security key"; the key has to
          say WHERE, wherever you happen to be looking.
        */}
        {fido.presenceNeeded ? (
          <View style={styles.prompt}>
            <View style={styles.promptText}>
              <Text style={styles.promptTitle}>Confirm on your key</Text>
              <Text style={styles.promptBody}>
                A site is asking for a security key. This is the press it wants.
              </Text>
            </View>
            <Btn title="Confirm" tone="primary" onPress={fido.confirm} />
          </View>
        ) : null}

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
            <SoftKeyScreen emu={emu} entries={emuLog.entries} clear={emuLog.clear} />
          ) : tab === 'USB HID' ? (
            <UsbScreen hid={hid} entries={usbLog.entries} clear={usbLog.clear} />
          ) : tab === 'FIDO2 BLE' ? (
            <FidoScreen fido={fido} entries={fidoLog.entries} clear={fidoLog.clear} />
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
  prompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.warn,
    backgroundColor: '#2a2410',
  },
  promptText: {flex: 1},
  promptTitle: {color: theme.text, fontSize: 14, fontWeight: '700'},
  promptBody: {color: theme.textDim, fontSize: 11, marginTop: 2, lineHeight: 15},
});
