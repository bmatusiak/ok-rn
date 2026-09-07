import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Btn, KeyValue, LogList, Section, StatusPill} from '../ui/components';
import {theme} from '../ui/theme';
import {useFidoGatt} from '../hooks/useFidoGatt';
import type {LogEntry, LogLevel} from '../hooks/useLog';

export function FidoScreen({
  entries,
  log,
  clear,
}: {
  entries: LogEntry[];
  log: (level: LogLevel, text: string) => void;
  clear: () => void;
}) {
  const fido = useFidoGatt({log});
  const running = fido.state === 'advertising' || fido.state === 'connected';

  return (
    <View style={styles.root}>
      <Section title="Authenticator" right={<StatusPill state={fido.state} />}>
        <Text style={styles.hint}>
          Advertises the FIDO BLE service 0xFFFD so a desktop browser can use this phone as a
          roaming security key over CTAP2. See EXPLAINER/z.md.
        </Text>
        <View style={styles.kvBlock}>
          <KeyValue label="service" value="0xFFFD" />
          <KeyValue label="ATT MTU" value={fido.mtu ? String(fido.mtu) : '-'} />
          <KeyValue
            label="device support"
            value={fido.supported === null ? 'checking...' : fido.supported ? 'yes' : 'no'}
          />
        </View>
        <View style={[styles.row, styles.rowTop]}>
          <View style={styles.cell}>
            <Btn
              title="Start advertising"
              tone="primary"
              disabled={running || fido.supported === false}
              onPress={fido.start}
            />
          </View>
          <View style={styles.cell}>
            <Btn title="Stop" tone="danger" disabled={!running} onPress={fido.stop} />
          </View>
        </View>
      </Section>

      <Section title="Pending request">
        {fido.pending ? (
          <View>
            <KeyValue
              label="command"
              value={fido.pending.commandName || '0x' + fido.pending.command.toString(16)}
            />
            <KeyValue label="relying party" value={fido.pending.rpId || '-'} />
            <KeyValue label="payload" value={fido.pending.hex.length / 2 + ' bytes'} />
            <View style={[styles.row, styles.rowTop]}>
              <View style={styles.cell}>
                <Btn title="Approve" tone="primary" onPress={fido.approve} />
              </View>
              <View style={styles.cell}>
                <Btn title="Deny" tone="danger" onPress={fido.deny} />
              </View>
            </View>
          </View>
        ) : (
          <Text style={styles.hint}>
            Nothing pending. CTAP2 command handlers and the KeyStore signing path are still
            stubs — approving acks with an empty CBOR map rather than a real assertion.
          </Text>
        )}
      </Section>

      <Section title="CTAP traffic" right={<Btn title="Clear" onPress={clear} />} style={styles.logSection}>
        <LogList entries={entries} />
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  row: {flexDirection: 'row', gap: 8},
  rowTop: {marginTop: 12},
  cell: {flex: 1},
  hint: {color: theme.textDim, fontSize: 11, lineHeight: 16},
  kvBlock: {marginTop: 10},
  logSection: {flex: 1},
});
