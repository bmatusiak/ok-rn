import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Btn, KeyValue, LogList, Section, StatusPill} from '../ui/components';
import {theme} from '../ui/theme';
import {useOkEmu} from '../hooks/useOkEmu';
import type {LogEntry, LogLevel} from '../hooks/useLog';

/**
 * The phone as the OnlyKey.
 *
 * The firmware here is the same C that runs on the hardware, with its flash and
 * EEPROM backed by files in the app sandbox - so this is a device, not a
 * simulation of one.
 */
/** Digits are button numbers, so each must be 1-6, and the firmware wants 7-10. */
const TEST_PIN = '1234561';

export function SoftKeyScreen({
  entries,
  log,
  clear,
}: {
  entries: LogEntry[];
  log: (level: LogLevel, text: string) => void;
  clear: () => void;
}) {
  const emu = useOkEmu({log, autoStart: true});
  const running = emu.state === 'running';

  return (
    <View style={styles.root}>
      <Section title="Firmware" right={<StatusPill state={pillState(emu.state)} label={emu.state} />}>
        {emu.state === 'halted' ? (
          <Text style={styles.warn}>
            The firmware called CPU_RESTART() and its thread has exited. It
            cannot be started again in this process — restart the app. Nothing
            is lost: flash and EEPROM are files, so the device comes back
            exactly as it was.
          </Text>
        ) : emu.state === 'unavailable' ? (
          <Text style={styles.warn}>
            libokemu.so was not built for this device's ABI. Check that the APK
            carries it — a 32-bit-only handset needs armeabi-v7a.
          </Text>
        ) : (
          <Text style={styles.hint}>
            The OnlyKey firmware, compiled for Android and running in-process.
            Its flash and EEPROM are files in this app's private storage, so the
            device state here survives exactly as it does across a power cycle.
          </Text>
        )}

        <View style={styles.kvBlock}>
          <KeyValue label="storage" value={emu.storageDir ? tail(emu.storageDir) : '-'} />
          <KeyValue label="LED" value={describeLed(emu.led)} />
        </View>

        <View style={[styles.row, styles.rowTop]}>
          <View style={styles.cell}>
            <Btn
              title="Start"
              tone="primary"
              disabled={
                running ||
                emu.busy ||
                emu.state === 'unavailable' ||
                emu.state === 'halted'
              }
              onPress={emu.start}
            />
          </View>
          <View style={styles.cell}>
            <Btn title="Restart" disabled={!running || emu.busy} onPress={emu.restart} />
          </View>
          <View style={styles.cell}>
            <Btn title="Stop" tone="danger" disabled={!running} onPress={emu.stop} />
          </View>
        </View>
      </Section>

      <Section title="Health check">
        <Text style={styles.hint}>
          OKCONNECT performs the key exchange, which reaches the emulated flash.
          "It booted" does not prove the mapping survived Android's
          mmap_min_addr floor; a completed OKCONNECT does.
        </Text>
        <View style={[styles.row, styles.rowTop]}>
          <View style={styles.cell}>
            <Btn title="OKCONNECT" tone="primary" disabled={!running || emu.busy} onPress={emu.connect} />
          </View>
          <View style={styles.cell}>
            <Btn
              title="Set PIN"
              disabled={!running || emu.busy}
              onPress={() => emu.provision(TEST_PIN)}
            />
          </View>
        </View>
        <Text style={styles.hint}>
          Set PIN provisions the device with {TEST_PIN}. Storing a PIN
          encrypts, and encrypting reaches the bottom of the flash array — so
          this is the step a protocol-only port cannot pass. It does not
          restart: the PIN only takes effect on the next boot, and the firmware
          thread cannot be restarted in place, so restart the app to check it
          stuck.
        </Text>
      </Section>

      <Section title="Buttons">
        <Text style={styles.hint}>
          The device's entire input surface. A PIN is a sequence of these, and
          user presence for a FIDO2 ceremony is three of them — chosen by the
          request being approved, so the press approves that request rather
          than merely proving somebody was here.
        </Text>
        <View style={[styles.row, styles.rowTop]}>
          {[1, 2, 3].map(n => (
            <View key={n} style={styles.cell}>
              <Btn title={String(n)} disabled={!running} onPress={() => emu.press(n)} />
            </View>
          ))}
        </View>
        <View style={[styles.row, styles.rowTop]}>
          {[4, 5, 6].map(n => (
            <View key={n} style={styles.cell}>
              <Btn title={String(n)} disabled={!running} onPress={() => emu.press(n)} />
            </View>
          ))}
        </View>
        <Text style={styles.hint}>
          Taps only. The firmware bands press length in main-loop iterations
          rather than milliseconds, and the long bands are where the
          destructive gestures live — a two-second hold on 3 locks the device
          by calling CPU_RESTART(), which on this build ends the firmware
          thread for good.
        </Text>
      </Section>

      <Section title="Firmware log" right={<Btn title="Clear" onPress={clear} />} style={styles.logSection}>
        <LogList entries={entries} />
      </Section>
    </View>
  );
}

function pillState(state: string): string {
  if (state === 'running') return 'connected';
  if (state === 'starting') return 'connecting';
  // 'halted' is the firmware having ended itself. It is not 'stopped': nothing
  // here can start it again, so showing it as idle would invite a Start press
  // that is refused.
  if (state === 'error' || state === 'unavailable' || state === 'halted') return 'error';
  return 'idle';
}

/** Storage paths are long and the interesting part is the end. */
function tail(path: string): string {
  const parts = path.split('/');
  return parts.slice(-2).join('/');
}

function describeLed(pixels: number[]): string {
  if (!pixels.length) return 'off';
  return pixels
    .slice(0, 3)
    .map(p => `#${p.toString(16).padStart(6, '0')}`)
    .join(' ');
}

const styles = StyleSheet.create({
  root: {flex: 1},
  row: {flexDirection: 'row', gap: 8},
  rowTop: {marginTop: 12},
  cell: {flex: 1},
  hint: {color: theme.textDim, fontSize: 11, lineHeight: 16},
  warn: {color: theme.warn, fontSize: 11, lineHeight: 16},
  kvBlock: {marginTop: 10},
  logSection: {flex: 1},
});
