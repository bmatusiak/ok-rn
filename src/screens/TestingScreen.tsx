import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn, KeyValue, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {E2EScreen} from './E2EScreen';
import {UsbScreen} from './UsbScreen';
import type {EmuSession} from '../hooks/useOkEmu';
import type {UsbSession} from '../hooks/useUsbHid';
import type {LogEntry} from '../hooks/useLog';

/**
 * Everything that is useful while building this and dangerous while using it.
 *
 * Reachable only in testing mode, which is the point: the E2E suite stops the
 * firmware and cannot restart it, and a factory reset is exactly as final as it
 * sounds. Neither belongs one stray tap away from a PIN pad.
 */
export function TestingScreen({
  emu,
  hid,
  usbEntries,
  clearUsb,
}: {
  emu: EmuSession;
  hid: UsbSession;
  usbEntries: LogEntry[];
  clearUsb: () => void;
}) {
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title="Firmware">
        <View style={styles.kv}>
          <KeyValue label="state" value={emu.state} />
          <KeyValue label="device" value={emu.device} />
          <KeyValue label="version" value={emu.version || '-'} />
          <KeyValue label="storage" value={tail(emu.storageDir)} />
          <KeyValue label="LED" value={describeLed(emu.led)} />
        </View>
        <View style={styles.row}>
          <View style={styles.cell}>
            <Btn title="OKCONNECT" onPress={emu.connect} disabled={emu.busy} />
          </View>
          <View style={styles.cell}>
            <Btn title="Stop" tone="danger" onPress={emu.stop} />
          </View>
        </View>
      </Section>

      <E2EScreen />

      <UsbScreen hid={hid} entries={usbEntries} clear={clearUsb} />

      <Text style={styles.note}>
        Testing mode bypasses the PIN, so nothing here is behind one. It is on
        by default in a debug build because the terminal e2e runner cannot type
        a PIN.
      </Text>
    </ScrollView>
  );
}

function tail(path: string): string {
  if (!path) {
    return '-';
  }
  return path.split('/').slice(-2).join('/');
}

function describeLed(pixels: number[]): string {
  if (!pixels.length) {
    return 'off';
  }
  return pixels
    .slice(0, 3)
    .map(p => `#${p.toString(16).padStart(6, '0')}`)
    .join(' ');
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {paddingBottom: 4},
  kv: {marginTop: 6},
  row: {flexDirection: 'row', gap: 8, marginTop: 12},
  cell: {flex: 1},
  note: {
    color: theme.textDim,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
    paddingHorizontal: 4,
  },
});
