import React, {useState} from 'react';
import {Platform, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {Segmented} from './src/ui/components';
import {theme} from './src/ui/theme';
import {useLog} from './src/hooks/useLog';
import {UsbScreen} from './src/screens/UsbScreen';
import {FidoScreen} from './src/screens/FidoScreen';

const TABS = ['USB HID', 'FIDO2 BLE'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>('USB HID');

  // One log buffer per screen so switching tabs does not interleave traffic.
  const usbLog = useLog();
  const fidoLog = useLog();

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>OnlyKey RN</Text>
          <Text style={styles.subtitle}>{Platform.OS} · hardware bridge scaffold</Text>
        </View>

        <View style={styles.tabs}>
          <Segmented options={TABS} value={tab} onChange={setTab} />
        </View>

        <View style={styles.body}>
          {tab === 'USB HID' ? (
            <UsbScreen entries={usbLog.entries} log={usbLog.log} clear={usbLog.clear} />
          ) : (
            <FidoScreen entries={fidoLog.entries} log={fidoLog.log} clear={fidoLog.clear} />
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
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
