import React, {useState} from 'react';
import {StyleSheet, Text} from 'react-native';
import {Btn, Section} from './components';
import {theme} from './theme';
import {useConfigMode} from '../hooks/useConfigMode';
import type {EmuSession} from '../hooks/useOkEmu';

/**
 * Config mode, explained and driven, wherever it is needed.
 *
 * Three screens need it - Keys, Backup, Preferences - and each had grown its
 * own version, which is how they came to disagree: Keys and Preferences took
 * the screen over, Backup inlined it.
 *
 * ## What the panel has to carry that the key does not
 *
 * Nothing about config mode is announced. Entering it LOCKS the device, and it
 * ends only at a reboot. So the app is the only thing that can explain the
 * lock, and the only thing that can say when it is over.
 *
 * ## THIS PANEL DOES NOT TAKE A PIN
 *
 * It used to. Entering config mode locks the key, so every screen that offered
 * config mode also had to offer a way back in - and each one grew its own PIN
 * pad and its own "check config mode" button, sitting inside a backup form or
 * a key loader. Reported 2026-09-19 as a defect: *"the enter config mode
 * should not have any pin entry or check config mode - the only place it
 * should exist is on the main login for unlock"*.
 *
 * It is also redundant, because the lock is already handled one level up. The
 * door in App follows `emu.device` (App.tsx:448), so a key that locks itself -
 * for any reason, config mode included - puts the login screen back, and THAT
 * screen has the pad and the check button (App.tsx:692). A screen behind the
 * door is a screen whose key is unlocked, so a PIN pad there is a pad for a
 * lock that cannot be in front of you.
 *
 * Which is why `ready` asks `emu.device`, not a probe. The probe answers a
 * question only the door can be asked: "the PIN went in but the key never said
 * so" - true of a PRODUCTION HARD KEY, which broadcasts nothing while in
 * config mode. It is resolved there by `checkConfig`, which calls
 * `emu.markUnlocked()` on success - so by the time you are back on this
 * screen, the answer has already become `emu.device === 'unlocked'`.
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
  /** What the caller wants config mode FOR, e.g. "load a key". */
  purpose,
}: {
  emu: EmuSession;
  configMode: boolean;
  purpose: string;
}) {
  const config = useConfigMode(emu);
  const [confirming, setConfirming] = useState(false);

  const locked = emu.device !== 'unlocked';
  const ready = configMode && !locked;

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

  /*
   * In config mode and still locked. Normally unreachable - the door would be
   * showing instead - but testing mode holds `phase` at 'main' regardless of
   * the lock (App.tsx:449), so this says what is true rather than pretending.
   */
  if (configMode) {
    return (
      <Section title="Config mode">
        <Text style={styles.body}>
          In config mode, but the key is locked — it locks itself on the way in.
          Enter your PIN on the login screen and come back.
        </Text>
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
        {'\n'}2. the key locks, and you enter your PIN again at the login screen
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
            /*
             * NOTHING IS ASSERTED HERE. This used to call setConfigMode(true)
             * straight after the hold, which is how the app came to believe a
             * key was in config mode that nobody had touched: config.enter()
             * swallows its own failure, so the line ran either way.
             *
             * enterConfigMode only reports success after a label read came
             * back REFUSED - the key locked, and the lock is the only evidence
             * config mode exists, since nothing on the wire reports it. That
             * result is the flag, read back through useInConfigMode.
             */
            onPress={async () => {
              await config.enter();
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
