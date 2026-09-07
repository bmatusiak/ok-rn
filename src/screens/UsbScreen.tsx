import React, {useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, KeyValue, LogList, Section, Segmented, StatusPill} from '../ui/components';
import {theme} from '../ui/theme';
import {useUsbHid} from '../hooks/useUsbHid';
import type {LogEntry, LogLevel} from '../hooks/useLog';
import type {Transport} from '../transport/UsbHid';

const TRANSPORTS: readonly Transport[] = ['auto', 'usb', 'tcp'] as const;

export function UsbScreen({
  entries,
  log,
  clear,
}: {
  entries: LogEntry[];
  log: (level: LogLevel, text: string) => void;
  clear: () => void;
}) {
  const hid = useUsbHid({log});
  const [raw, setRaw] = useState('00ff0001');

  const connected = hid.state === 'connected';

  return (
    <View style={styles.root}>
      <Section
        title="Transport"
        right={<StatusPill state={hid.state} />}>
        <Segmented options={TRANSPORTS} value={hid.transport} onChange={hid.setTransport} />
        <Text style={styles.hint}>
          auto picks the TCP mock on an emulator debug build and UsbManager everywhere else.
          Start the mock with: npm run mock
        </Text>
        <View style={styles.kvBlock}>
          <KeyValue label="report size" value={String(hid.packetSize) + ' bytes'} />
          <KeyValue label="devices seen" value={String(hid.devices.length)} />
        </View>
      </Section>

      <Section title="Connection">
        <View style={styles.row}>
          <View style={styles.cell}>
            <Btn title="Scan" onPress={hid.refreshDevices} />
          </View>
          <View style={styles.cell}>
            <Btn
              title={connected ? 'Connected' : 'Connect'}
              tone="primary"
              disabled={connected || hid.busy}
              onPress={() => hid.connect()}
            />
          </View>
          <View style={styles.cell}>
            <Btn title="Disconnect" tone="danger" disabled={!connected} onPress={hid.disconnect} />
          </View>
        </View>
        {hid.devices.map(device => (
          <Text key={device.deviceName} style={styles.device}>
            {device.productName || device.deviceName} — vid 0x
            {device.vendorId.toString(16)} pid 0x{device.productId.toString(16)}
            {' '}· {device.interfaceCount} iface · max {device.maxReportSize}B
            {device.hasPermission ? '' : ' (no permission)'}
          </Text>
        ))}
      </Section>

      <Section title="Send">
        <View style={styles.row}>
          <View style={styles.cell}>
            <Btn title="CTAPHID_INIT" disabled={!connected} onPress={hid.sendPing} />
          </View>
          <View style={styles.cell}>
            <Btn
              title="Write raw"
              disabled={!connected}
              onPress={() => hid.sendRaw(raw)}
            />
          </View>
        </View>
        <TextInput
          value={raw}
          onChangeText={setRaw}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="hex payload, e.g. 00ff0001"
          placeholderTextColor={theme.textDim}
          style={styles.input}
        />
      </Section>

      <Section title="Traffic" right={<Btn title="Clear" onPress={clear} />} style={styles.logSection}>
        <LogList entries={entries} />
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  row: {flexDirection: 'row', gap: 8},
  cell: {flex: 1},
  hint: {color: theme.textDim, fontSize: 11, marginTop: 8, lineHeight: 15},
  kvBlock: {marginTop: 10},
  device: {color: theme.text, fontFamily: theme.mono, fontSize: 11, marginTop: 8},
  input: {
    marginTop: 10,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    fontFamily: theme.mono,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  logSection: {flex: 1},
});
