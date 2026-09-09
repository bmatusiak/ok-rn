import React, {useCallback, useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Keypad, PinDots} from '../ui/Keypad';
import {Logo} from '../ui/Logo';
import {Btn} from '../ui/components';
import * as biometrics from '../biometrics';
import {theme} from '../ui/theme';

/** The firmware accepts 7-10 digits, each of them a button number. */
const MAX_PIN = 10;

/**
 * PIN entry, on the device's own buttons.
 *
 * Every tap is a REAL button press through okemu_set_button(); there is no
 * "submit". The firmware evaluates the hash after every press
 * (OnlyKey.ino:697) and announces UNLOCKED the moment it matches, so success
 * arrives as the device's own broadcast rather than as a reply to anything -
 * the shell watches for it and moves on.
 *
 * This deliberately does NOT use the library's device.unlock(). That sends
 * digits with pressLine over IFACE.SEREMU, the DEBUG console, which does not
 * exist in a release build.
 */
export function PinScreen({
  onPress,
  onBack,
  busy = false,
}: {
  onPress: (button: number) => Promise<void> | void;
  onBack?: () => void;
  busy?: boolean;
}) {
  const [count, setCount] = useState(0);
  const [working, setWorking] = useState(false);

  /*
   * Presses are QUEUED, NOT DROPPED
   * (FINDING-pin-taps-are-dropped-not-queued.md).
   *
   * A press is not instantaneous: it is ten firmware loop iterations at
   * ~36ms each, plus the poll that notices the release, so about 400ms. A
   * finger moving between two keys takes half that. Ignoring a tap that
   * arrives mid-press - which is what a `working` guard does - threw away
   * roughly every second digit, and the buffer this feeds CANNOT BE CLEARED
   * except by running it to its rollover, so one lost digit costs the entry
   * twice over.
   *
   * Serialising is still required - okemu_set_button_ticks holds one counter
   * per button, and a second press starting before the first is released
   * overwrites the count being aged - but a chain serialises without
   * discarding anything.
   */
  const queue = useRef<Promise<void>>(Promise.resolve());

  /*
   * Whether a PIN is saved behind a biometric. Asked WITHOUT prompting, so the
   * button appears or does not without anyone being made to touch a sensor to
   * find out.
   */
  const [hasStoredPin, setHasStoredPin] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    biometrics
      .has(biometrics.ALIAS.devicePin)
      .then(stored => {
        if (alive) setHasStoredPin(stored);
      })
      .catch(() => {
        /* No module, no biometrics, no button. Not worth reporting. */
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Presses ACCEPTED, including ones still waiting their turn.
   *
   * The cap has to be counted here rather than off `count`, which only moves
   * once a press has landed: ten fast taps must queue ten presses, not however
   * many happened to have finished by the time the tenth arrived.
   */
  const accepted = useRef(0);

  /** How many are still in flight, so the screen knows when it has drained. */
  const outstanding = useRef(0);

  const press = useCallback(
    (button: number) => {
      if (accepted.current >= MAX_PIN) {
        return;
      }
      accepted.current += 1;
      outstanding.current += 1;
      setWorking(true);

      queue.current = queue.current
        .then(() => onPress(button))
        .then(
          () => {
            setCount(prev => prev + 1);
          },
          () => {
            /* It never reached the key, so it does not count against the cap. */
            accepted.current -= 1;
          },
        )
        .then(() => {
          outstanding.current -= 1;
          if (outstanding.current === 0) setWorking(false);
        });
    },
    [onPress],
  );

  /*
   * THE BUFFER CANNOT BE CLEARED, so this does not pretend to.
   *
   * clearPinEntry() appends before it resets, and the only clean way back to an
   * empty buffer is the firmware's own rollover: pass_keypress starts at 1 and
   * the tenth press takes the else branch, which calls password.reset()
   * (OnlyKey.ino:964-989). So "Start over" presses the rest of the way there.
   *
   * Button 6 for the padding, and never button 3 - a press is a press, and 3 is
   * the lock gesture. Padding with a single repeated digit also makes an
   * accidental match on someone's real PIN vanishingly unlikely.
   */
  const startOver = useCallback(() => {
    if (accepted.current === 0 || accepted.current >= MAX_PIN) {
      return;
    }

    /* press() stops at MAX_PIN by itself, so this pads exactly to the edge. */
    const padding = MAX_PIN - accepted.current;
    for (let i = 0; i < padding; i++) {
      press(6);
    }

    /*
     * The counters go back to zero behind the padding rather than beside it -
     * the buffer is only empty once the last of those presses has been sent.
     */
    queue.current = queue.current.then(() => {
      accepted.current = 0;
      setCount(0);
    });
  }, [press]);

  /*
   * Unlock with a fingerprint, by REPLAYING the stored PIN through press().
   *
   * Not a shortcut past the firmware - there is none. The device is unlocked by
   * button presses and nothing else, so this presses the same buttons a finger
   * would, through the same queue, at the same pace. Everything the queue
   * exists for still applies: presses that merge without an idle gap sum their
   * durations, and a lost digit costs the entry twice because the buffer cannot
   * be cleared.
   *
   * The PIN is read back from the Android Keystore under a key that cannot be
   * used without a biometric, so the prompt is the gate rather than this code.
   */
  const unlockWithBiometric = useCallback(async () => {
    setBioError(null);
    setBioBusy(true);
    try {
      const pin = await biometrics.load(
        biometrics.ALIAS.devicePin,
        'Unlock your OnlyKey',
        'Your PIN is stored on this phone behind your biometric.',
      );
      for (const ch of pin) {
        const button = Number(ch);
        if (Number.isInteger(button) && button >= 1 && button <= 6) {
          press(button);
        }
      }
    } catch (e) {
      /*
       * The enrolment case is not a retry. The key is destroyed on purpose
       * when the phone's biometrics change, so the PIN has to be stored again
       * - and saying "try again" would be advice that cannot work.
       */
      setBioError(
        biometrics.wasInvalidated(e)
          ? 'Your saved PIN was cleared because this phone’s biometrics changed. Enter it once and save it again.'
          : String((e as Error)?.message ?? e),
      );
      setHasStoredPin(false);
    } finally {
      setBioBusy(false);
    }
  }, [press]);

  return (
    <View style={styles.root}>
      <Logo height={30} />

      <Text style={styles.title}>Locked</Text>
      <Text style={styles.hint}>Enter your PIN on the keypad.</Text>

      {hasStoredPin ? (
        <>
          <Btn
            title={bioBusy ? 'Waiting…' : 'Unlock with biometrics'}
            tone="primary"
            disabled={bioBusy || busy}
            onPress={unlockWithBiometric}
          />
          {bioError ? <Text style={styles.bioError}>{bioError}</Text> : null}
        </>
      ) : null}

      <View style={styles.dots}>
        <PinDots count={count} max={MAX_PIN} />
      </View>

      <View style={styles.pad}>
        <Keypad onPress={press} disabled={busy} />
      </View>

      <View style={styles.footer}>
        <Btn
          title="Start over"
          disabled={count === 0 || working}
          onPress={startOver}
        />
        {onBack ? <Btn title="Back" onPress={onBack} /> : null}
      </View>

      <Text style={styles.note}>
        The key checks after every press. Start over runs the buffer to its
        rollover, which is the only clean reset it has.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bioError: {color: theme.error, fontSize: 12, lineHeight: 18, marginTop: 8, textAlign: 'center'},
  root: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24},
  title: {color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 28},
  hint: {color: theme.textDim, fontSize: 13, marginTop: 4},
  dots: {marginTop: 22, marginBottom: 26},
  pad: {width: '100%', maxWidth: 320},
  footer: {flexDirection: 'row', gap: 10, marginTop: 22, width: '100%', maxWidth: 320},
  note: {
    color: theme.textDim,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 18,
    maxWidth: 320,
  },
});
