import React, {useState} from 'react';
import {StyleSheet, Text} from 'react-native';
import {Btn, Section} from './components';
import {theme} from './theme';
import {WANTED, PRE, ON, type ConfigState} from './configModeNotes';
import type {EmuSession} from '../hooks/useOkEmu';
import type {Backend} from '../hooks/keySession';

/**
 * The way into config mode, as four states.
 *
 * ## It reports; it does not decide
 *
 * The version deleted in 98f8760 called `setConfigMode(true)` on the tap, and
 * `config.enter()` could not throw - so the app believed a key was in config
 * mode that nobody had touched, which on a production hard key was every time.
 * Reported 2026-09-19.
 *
 * This one calls `onWant()` and stops. App owns the flag, App watches for the
 * lock, App acts on the check. There is one writer and it is not here.
 *
 * ## The hold, and the one thing that differs between keys
 *
 * Config mode is button 6 held past 72 ticks - 3.6 s at TIME_POLL 50, with NO
 * ceiling (the gesture branch returns before the band dispatch that rejects
 * long presses, OnlyKey.ino:895). Five seconds is the honest instruction: over
 * the floor with margin, and overshooting costs nothing.
 *
 * The SOFT key takes that hold from the app, through the emulator's press
 * queue. A hard key is a physical object and the person holds it. That is the
 * whole difference, and it is read off `backend` rather than by probing the
 * debug interface for a console - asked for directly, and the honest question
 * anyway: "is this key a thing in your hand" needs no message sent to find out.
 */
export function ConfigModePanel({
  state,
  emu,
  backend,
  onWant,
  /** What the caller wants config mode FOR, e.g. "set a backup key". */
  purpose,
}: {
  state: ConfigState;
  emu: EmuSession;
  backend: Backend;
  onWant: () => void;
  purpose: string;
}) {
  const soft = backend === 'embedded';
  const locked = emu.device !== 'unlocked';
  const [error, setError] = useState<string | null>(null);

  /*
   * THE HOLD, AND THEN THE STATE - in that order, and only on the soft key.
   *
   * Written the other way round first and caught on the device: the panel said
   * "holding button 6" while nothing had been held, because `onWant()` was the
   * whole handler. That is the same defect the whole feature was torn out for,
   * rebuilt by hand in the rebuild meant to avoid it.
   *
   * 80 ticks: eight over the 72-tick floor (OnlyKey.ino:895), the same margin
   * the library's own enterConfigMode uses. `allowGesture` because this is one
   * of the few places a gesture-length press is meant rather than a mistake.
   *
   * The state is set even if the hold throws. It means "we are watching for
   * the lock", and watching costs nothing - whereas swallowing the failure and
   * staying at OFF would leave a key that DID lock with an app that had
   * stopped caring. The error says what happened.
   */
  const want = async () => {
    setError(null);
    if (soft) {
      try {
        await emu.holdTicks(6, 80, {allowGesture: true});
      } catch (e) {
        setError(
          `The app could not hold the button: ${String((e as Error)?.message ?? e)}. ` +
            'Hold button 6 on the keypad for about 5 seconds instead.',
        );
      }
    }
    onWant();
  };

  /* Through it. Nothing to offer somebody already inside. */
  if (state === ON) {
    return (
      <Section title="Config mode">
        <Text style={styles.body}>
          In config mode — you can {purpose}. It ends only when the key
          restarts: unplug a hard key, restart the app for the soft key.
        </Text>
      </Section>
    );
  }

  /*
   * The lock landed and the PIN is being asked for - which happens on the
   * login screen, not here, because a locked key puts the door up and this tab
   * is not on screen. Reachable only in testing mode, which holds the app past
   * the door. Says what is true rather than pretending.
   */
  if (state === PRE) {
    return (
      <Section title="Config mode">
        <Text style={styles.body}>
          The key locked itself on the way in. Enter your PIN, then press
          “Check config mode”.
        </Text>
      </Section>
    );
  }

  /* Asked for, waiting for the key to lock. */
  if (state === WANTED) {
    return (
      <Section title="Config mode">
        <Text style={styles.body}>
          {soft
            ? 'Holding button 6 — waiting for the key to lock. It takes about a second.'
            : 'Hold button 6 on the key for about 5 seconds, then let go. Waiting for it to lock.'}
        </Text>
        <Text style={styles.note}>
          {soft
            ? 'Locking is how config mode announces itself; there is nothing else to see.'
            : 'A hold does nothing while the light is still fading, or for up to 20 seconds after a security-key request. If nothing happens, wait and hold it again.'}
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </Section>
    );
  }

  /* Not in it. */
  return (
    <Section title="Config mode">
      <Text style={styles.body}>
        The firmware accepts this only in config mode, and getting there locks
        the key.
      </Text>
      <Text style={styles.steps}>
        1. {soft ? 'the app holds button 6' : 'you hold button 6 for about 5 seconds'}
        {'\n'}2. the key locks, and you enter your PIN again
        {'\n'}3. press “Check config mode”
        {'\n'}4. you {purpose}
        {'\n'}5. restart the key — config mode ends only there
      </Text>
      <Btn
        title={soft ? 'Enter config mode' : 'I will hold button 6'}
        tone="primary"
        disabled={locked}
        onPress={() => void want()}
      />
      {locked ? (
        <Text style={styles.note}>Unlock the key first.</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 17},
  steps: {color: theme.textSecondary, fontSize: 13, lineHeight: 21},
  error: {color: theme.error, fontSize: 12, lineHeight: 17},
});
