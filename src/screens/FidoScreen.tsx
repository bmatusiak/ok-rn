import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
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
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
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
            {fido.presenceNeeded ? (
              <View>
                <Text style={styles.hint}>
                  The key is waiting for a button. It will not produce a
                  credential without one — this is the device asking, not the
                  app.
                </Text>
                <View style={[styles.row, styles.rowTop]}>
                  <View style={styles.cell}>
                    <Btn title="Confirm" tone="primary" onPress={fido.confirm} />
                  </View>
                </View>
              </View>
            ) : (
              <Text style={styles.hint}>
                Forwarding to the firmware. Nothing to do unless it asks for a
                button.
              </Text>
            )}
          </View>
        ) : (
          <Text style={styles.hint}>
            Nothing pending. Requests are answered by the OnlyKey firmware
            running in this app, not by this screen — so the device must be
            unlocked first, on the Soft key tab. There is no Deny: letting the
            ceremony time out is the refusal, and it is the one the host
            understands.
          </Text>
        )}
      </Section>

      <Section title="CTAP traffic" right={<Btn title="Clear" onPress={clear} />}>
        <LogList entries={entries} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  row: {flexDirection: 'row', gap: 8},
  rowTop: {marginTop: 12},
  cell: {flex: 1},
  hint: {color: theme.textDim, fontSize: 11, lineHeight: 16},
  kvBlock: {marginTop: 10},
  content: {paddingBottom: 4},
});
