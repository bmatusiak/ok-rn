import React, {useState} from 'react';
import {StyleSheet, Text} from 'react-native';
import {Btn, Section} from './components';
import {theme} from './theme';
import {useConfigMode} from '../hooks/useConfigMode';
import type {EmuSession} from '../hooks/useOkEmu';

/**
 * Config mode, explained and driven, wherever it is needed.
 *
 * Four screens need it - Keys, Backup, Firmware, Preferences - and each had
 * grown its own version, which is how they came to disagree: Keys and
 * Preferences took the screen over, Backup inlined it, Firmware gated on a
 * different flag and offered its actions before the PIN was back in.
 *
 * ## What the panel has to carry that the key does not
 *
 * Nothing about config mode is announced. Entering it LOCKS the device; the
 * unlock that follows is never broadcast; and it ends only at a reboot. So the
 * app is the only thing that can explain the lock, and the only thing that can
 * discover the unlock - by probing, which App does while `configMode` is on.
 *
 * ## Getting in is not the same on every key
 *
 * On the soft key and a developer hard key the app can hold the button. On a
 * PRODUCTION hard key it cannot: `holdTicks` throws without the debug console
 * (useHardKey.ts), and `canPress` is that console's probe. Offering a button
 * there would be offering one that can only fail, so this shows the
 * instruction instead - and picks the flow up from the lock exactly as if the
 * app had pressed it, because the lock is the same either way.
 */
export function ConfigModePanel({
  emu,
  configMode,
  setConfigMode,
  probe,
  onCheck,
  checking,
  /** What the caller wants config mode FOR, e.g. "load a key". */
  purpose,
}: {
  emu: EmuSession;
  configMode: boolean;
  setConfigMode: (on: boolean) => void;
  probe: {at: number; ok: boolean; note: string} | null;
  /** Runs one label probe, on demand. See App: never on a timer. */
  onCheck: () => Promise<void>;
  checking: boolean;
  purpose: string;
}) {
  const config = useConfigMode(emu);
  const [confirming, setConfirming] = useState(false);

  const locked = emu.device !== 'unlocked';
  const ready = configMode && probe?.ok === true;

  /* Already in, and the PIN is back in: the only state where work can happen. */
  if (ready) {
    return (
      <Section title="Config mode">
        <Text style={styles.body}>
          Ready — you can {purpose}. The key will not sign or type until it is
          restarted: unplug a hard key, restart the app for the soft key.
        </Text>
      </Section>
    );
  }

  /* In config mode, still locked. The PIN goes back in on the key or the pad. */
  if (configMode) {
    return (
      <Section title="Config mode">
        <Text style={styles.body}>
          The key locked itself entering config mode. Enter your PIN again to
          carry on.
        </Text>
        <Text style={styles.note}>
          The key will not announce the unlock, so the app cannot see it happen
          — press this once the PIN is in and it will ask.
        </Text>
        <Btn
          title={checking ? 'Checking…' : 'Check config mode'}
          tone="primary"
          disabled={checking}
          onPress={() => void onCheck()}
        />
        {probe && !probe.ok ? (
          <Text style={styles.note}>
            Still locked — the key refused a label read. Finish the PIN and
            check again.
          </Text>
        ) : null}
      </Section>
    );
  }

  /* Not in it yet. */
  return (
    <Section title="Config mode is required">
      <Text style={styles.body}>
        The firmware only accepts this while the device is in config mode, and
        getting there locks it.
      </Text>
      <Text style={styles.steps}>
        1. hold button 6 — the app does this, or hold it on the key
        {'\n'}2. the key locks, and you enter your PIN again
        {'\n'}3. you {purpose}
        {'\n'}4. restart the key — config mode ends only there, and until then
        it will not sign or type
      </Text>

      {config.error ? <Text style={styles.error}>{config.error}</Text> : null}

      {confirming ? (
        <>
          <Text style={styles.note}>
            This locks the key now. You will enter your PIN again, and the key
            will not sign or type until it is restarted.
          </Text>
          <Btn
            title={config.entering ? 'Holding…' : 'Yes, enter config mode'}
            tone="primary"
            disabled={config.entering}
            onPress={async () => {
              await config.enter();
              setConfigMode(true);
              setConfirming(false);
            }}
          />
          <Btn title="Cancel" onPress={() => setConfirming(false)} />
        </>
      ) : (
        <Btn
          title="Enter config mode"
          tone="primary"
          disabled={locked}
          onPress={() => setConfirming(true)}
        />
      )}

      {locked ? (
        <Text style={styles.note}>Unlock the key first.</Text>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 17},
  error: {color: theme.error, fontSize: 12, lineHeight: 17},
  steps: {color: theme.textSecondary, fontSize: 13, lineHeight: 21},
});
