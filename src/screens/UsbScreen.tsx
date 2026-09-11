import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, KeyValue, LogList, Section, Segmented, StatusPill} from '../ui/components';
import {theme} from '../ui/theme';
import {IFACE_NAMES, type UsbSession} from '../hooks/useUsbHid';
import type {LogEntry} from '../hooks/useLog';

/**
 * The byte-level view of the hard key: what is on the wire, and a way to put
 * bytes on it by hand.
 *
 * A window onto the SHARED pipe, not a second connection - see useUsbHid for
 * why that mattered. Connect here opens the same pipe the hard key uses, or
 * finds it open; Disconnect closes it for everyone, which is what the
 * button says.
 */
export function UsbScreen({
  hid,
  entries,
  clear,
}: {
  hid: UsbSession;
  entries: LogEntry[];
  clear: () => void;
}) {
  const [raw, setRaw] = useState('00ff0001');
  const connected = hid.state === 'connected';

  /*
   * Only interfaces the device CARRIES are offered once it is open. A
   * production key has three; offering the debug console on one would be
   * offering a write into nothing.
   */
  const offered = hid.interfaces.length
    ? IFACE_NAMES.filter(n => hid.interfaces.some(i => i.iface === n.iface))
    : IFACE_NAMES;
  const names = offered.map(n => n.name);
  const current = IFACE_NAMES.find(n => n.iface === hid.iface)?.name ?? names[0];

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <Section
        title="Hard Key transport"
        right={<StatusPill state={hid.state} />}>
        <Text style={styles.hint}>
          The same USB pipe the hard key is read through. Everything it carries,
          on every interface, appears below; Disconnect releases it for the
          whole app.
        </Text>
        <View style={styles.kvBlock}>
          <KeyValue label="report size" value={String(hid.packetSize) + ' bytes'} />
          <KeyValue label="devices seen" value={String(hid.devices.length)} />
          <KeyValue label="interfaces open" value={String(hid.interfaces.length)} />
        </View>
        {hid.interfaces.map(i => (
          <Text key={i.iface} style={styles.device}>
            {IFACE_NAMES.find(n => n.iface === i.iface)?.name ?? i.iface}
            {' '}· bInterfaceNumber {i.interfaceNumber} · usage 0x
            {i.usagePage.toString(16)}/0x{i.usage.toString(16)}
            {' '}· in {i.packetSizeIn} out {i.packetSizeOut} · by {i.identifiedBy}
          </Text>
        ))}
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
        <Text style={styles.hint}>Which interface a raw write goes to.</Text>
        <Segmented
          options={names}
          value={current}
          onChange={name => {
            const hit = IFACE_NAMES.find(n => n.name === name);
            if (hit) hid.setIface(hit.iface);
          }}
        />
        <View style={[styles.row, styles.kvBlock]}>
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

      <Section title="Traffic" right={<Btn title="Clear" onPress={clear} />}>
        <LogList entries={entries} />
      </Section>
    </ScrollView>
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
  content: {paddingBottom: 4},
});
