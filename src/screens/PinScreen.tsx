import React, {useCallback, useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import OkEmu from '../transport/OkEmu';
import {Keypad} from '../ui/Keypad';
import {usePressQueue} from '../hooks/usePressQueue';
import {Logo} from '../ui/Logo';
import {Btn, LedCircle, Segmented} from '../ui/components';
import * as biometrics from '../biometrics';
import {DuoPinForm} from '../ui/DuoPinForm';
import {useActiveKey} from '../hooks/KeyContext';
import {theme} from '../ui/theme';

/**
 * The firmware accepts 7-10 digits, each of them a button number.
 *
 * From the library, which is where the firmware is transcribed - the same
 * number decides where the buffer rolls over, and two copies of it would be two
 * places to get the cap wrong.
 */

/**
 * PIN entry, on the device's own buttons.
 *
 * Every tap is a REAL button press through okemu_set_button(); there is no
 * "submit". The firmware evaluates the hash after every press
 * (OnlyKey.ino:697) and announces UNLOCKED the moment it matches, so success
 * arrives as the device's own broadcast rather than as a reply to anything -
 * the shell watches for it and moves on.
 *
 * This deliberately does NOT use the library's device.unlock(), and the reason
 * has changed. It used to be that unlock() could only send digits with
 * pressLine over IFACE.SEREMU - the DEBUG console, absent from a release build.
 * That was fixed: unlock() takes an `enterDigits` strategy now, and the e2e
 * suite passes it one that presses buttons.
 *
 * What keeps this screen separate is the KEYPAD. unlock() takes a PIN it
 * already has; this screen is someone typing one digit at a time, so it needs
 * the press queue below - presses that merge without an idle gap sum their
 * durations - and it needs to render progress as each one lands. Handing
 * unlock() a promise that resolves when the user finishes would be the same
 * queue with a worse shape.
 */
/**
 * The two keys, by the names they are called everywhere else in the app.
 *
 * Literal strings rather than a code/label pair because `Segmented` renders
 * the option itself - one place to read, one place to change.
 */
export type KeyPick = 'Hard key' | 'Soft Key';
const PICK_OPTIONS: readonly KeyPick[] = ['Hard key', 'Soft Key'];

export function PinScreen({
  onPress,
  onPressRun,
  onBack,
  configMode = false,
  onCheckConfig,
  checking = false,
  busy = false,
  canPress = true,
  model = 'classic',
  settling = null,
  led,
  keyPick = null,
}: {
  /**
   * Whether the app believes the key is in config mode.
   *
   * It changes what this screen can promise. Normally the key announces its
   * own unlock and the shell moves on by itself; in config mode it never does
   * (OnlyKey.ino:707), so the PIN can go all the way in and nothing happens.
   * Asking is the only way to find out, and THIS is where someone is standing
   * when they need to - not on Keys or Backup, where the panel lives.
   */
  /**
   * Which key this screen is talking to, and how to change it - or null to
   * offer no choice at all, which is the honest state when nothing is plugged
   * in: there is no second key to pick.
   */
  keyPick?: {value: KeyPick; onChange: (next: KeyPick) => void} | null;
  /** Why a press would be dropped right now (useKey / useOkEmu.settling), or null. */
  settling?: string | null;
  onPress: (button: number) => Promise<void> | void;
  /**
   * Enter a whole PIN at once, for the biometric unlock.
   *
   * Optional: without it the digits go in one at a time, which still works and
   * is what a caller that has not been wired for it gets.
   */
  onPressRun?: (buttons: string) => Promise<void> | void;
  onBack?: () => void;
  /** At PRE: the key locked entering config mode and will not report the unlock. */
  configMode?: boolean;
  onCheckConfig?: () => void;
  checking?: boolean;
  busy?: boolean;
  /**
   * A DUO takes its PIN TYPED into the message body, not pressed; the
   * keypad below is the wrong control for one. See DuoPinForm.
   */
  model?: 'classic' | 'duo';
  /**
   * Whether a tap here reaches the key at all.
   *
   * A HARD KEY HAS ITS OWN BUTTONS, and the design rule is that the app does
   * not draw a keypad for one unless the firmware's debug console can press
   * for it. So this is three-valued, from useHardKey: true draws the pad,
   * false says "use the key", and null - not yet asked - says so too rather
   * than guessing either way. The soft key is always true; it has no buttons
   * but these.
   */
  canPress?: boolean | null;
  /**
   * The soft key's NeoPixel, packed 0xRRGGBB per pixel, or undefined.
   *
   * SOFT KEYS ONLY. A hard key's LED is on the key in your hand; there is no
   * feed for it over USB, so the caller passes nothing and no circle is drawn.
   */
  led?: number[];
}) {

  /* The DUO path: the library's unlock() types the PIN for a DUO. */
  const getKey = useActiveKey();
  const [duoBusy, setDuoBusy] = useState(false);
  const [duoError, setDuoError] = useState<string | null>(null);
  const unlockTyped = useCallback(
    async (pin: string) => {
      setDuoBusy(true);
      setDuoError(null);
      try {
        const {device} = await getKey();
        await device.unlock(pin);
      } catch (e) {
        setDuoError(String((e as Error)?.message ?? e));
      } finally {
        setDuoBusy(false);
      }
    },
    [getKey],
  );

  /* The queue lives in usePressQueue now; setup needed the same code. */
  const {press, pressRun} = usePressQueue(onPress, onPressRun);


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

  /*
   * THE BUFFER CANNOT BE CLEARED, so this does not pretend to.
   *
   * There is no message for it - the firmware's clearPinEntry APPENDS before it
   * resets - and the only clean way back to empty is its own rollover. The
   * arithmetic and the reasoning live in the library
   * (node-onlykey-lib/src/device/pin.js, rolloverPresses), because it is a
   * property of the firmware rather than of this screen: a second host would
   * have to work it out again, and getting it wrong pads with the lock gesture.
   *
   * What stays here is the PRESSING. Each padded press goes through the same
   * queue as a typed one, because they merge the same way if they do not.
   */

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
      /*
       * The whole PIN as ONE queued run. It used to go in digit by digit,
       * which was right when every press was a sensed ~855ms and the queue's
       * pacing was the only thing keeping them from merging. The presses are
       * handed to the firmware now, so there is nothing to merge and nothing
       * to pace - and this is a PIN we already hold in full, so sending it as
       * seven separate crossings was seven chances to interleave with a tap.
       */
      pressRun(pin);
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
  }, [pressRun]);

  return (
    <View style={styles.root}>
      <Logo height={30} />

      {/*
        * WHICH KEY, before anything that depends on which key it is.
        *
        * Everything below this row differs between the two: the soft key draws
        * an LED and a keypad because the app drives both, and the hard key
        * draws neither - its light is on the desk and its buttons are under
        * your finger. Choosing after seeing a keypad that is about to vanish
        * would be the wrong order.
        */}
      {keyPick ? (
        <View style={styles.pick}>
          <Segmented
            options={PICK_OPTIONS}
            value={keyPick.value}
            onChange={keyPick.onChange}
          />
        </View>
      ) : null}

      {led ? (
        <View style={styles.ledRow}>
          <LedCircle pixels={led} />
        </View>
      ) : null}

      <Text style={styles.title}>Locked</Text>

      {model === 'duo' ? (
        <>
          <DuoPinForm mode="unlock" busy={busy || duoBusy} onUnlock={unlockTyped} />
          {duoError ? <Text style={styles.bioError}>{duoError}</Text> : null}
          {onBack ? (
            <View style={styles.footer}>
              <Btn title="Back" onPress={onBack} />
            </View>
          ) : null}
        </>
      ) : canPress !== true ? (
        /*
         * NO KEYPAD, NO DOTS. The digits go in on the key itself, so there
         * is nothing here to count; the firmware announces UNLOCKED on its
         * own broadcast the moment the last one is right, and the shell
         * follows that exactly as it does for a tap here. Biometric replay
         * is hidden for the same reason: it works by pressing.
         */
        <>
          <Text style={styles.hint}>
            {canPress === null
              ? 'Asking this key whether it takes presses from the app…'
              : 'Enter your PIN on the key’s own buttons.'}
          </Text>
          <Text style={styles.note}>
            This key checks after every press and unlocks itself when the
            last digit is right; this screen follows. To start over, hold any
            button for a few seconds or unplug and reattach it.
          </Text>
          {/*
            THE ONLY WAY TO FINISH, ON THE SCREEN WHERE IT MATTERS MOST.

            The note above is true outside config mode: the key announces its
            own unlock and this screen follows. In config mode it never does,
            so someone can type the whole PIN on the key and nothing happens
            at all. Asking is the only way out, and this is where they are
            standing.
          */}
          {configMode && onCheckConfig ? (
            <>
              <Text style={styles.note}>
                In config mode the key does not announce the unlock. Enter your
                PIN, then check.
              </Text>
              <View style={styles.footer}>
                <Btn
                  title={checking ? 'Checking…' : 'Check config mode'}
                  tone="primary"
                  disabled={checking}
                  onPress={onCheckConfig}
                />
              </View>
            </>
          ) : null}
          {onBack ? (
            <View style={styles.footer}>
              <Btn title="Back" onPress={onBack} />
            </View>
          ) : null}
        </>
      ) : (
      <>
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

      {settling ? <Text style={styles.settling}>{settling}</Text> : null}
      <View style={styles.pad}>
        <Keypad onPress={press} disabled={busy} />
      </View>

      {/*
        RESTART, NOT "START OVER".
        The old button ran the firmware's PIN buffer to its rollover, which is
        the only reset the buffer has - but it needed to know how many digits
        had gone in, and a PIN is 7 to 10 so the screen never did. Restarting
        the app is the reset that always works: the firmware thread goes with
        the process, flash and EEPROM persist, and the key comes back locked.
      */}
      {/*
        THE SAME QUESTION ON THE KEYPAD LAYOUT.

        Both layouts need it and for the same reason - the unlock is never
        announced in config mode, so the PIN can go all the way in with
        nothing happening on screen. The first attempt put both copies in
        the key-buttons branch and the soft key, which uses this one, was
        left with no way out of PRE at all.
      */}
      {configMode && onCheckConfig ? (
        <>
          <Text style={styles.note}>
            In config mode the key does not announce the unlock. Enter your
            PIN, then check.
          </Text>
          <View style={styles.footer}>
            <Btn
              title={checking ? 'Checking…' : 'Check config mode'}
              tone="primary"
              disabled={checking}
              onPress={onCheckConfig}
            />
          </View>
        </>
      ) : null}
      <View style={styles.footer}>
        <Btn title="Restart app" onPress={() => OkEmu.restartApp()} />
        {onBack ? <Btn title="Back" onPress={onBack} /> : null}
      </View>
      </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bioError: {color: theme.error, fontSize: 12, lineHeight: 18, marginTop: 8, textAlign: 'center'},
  root: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24},
  title: {color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 28},
  hint: {color: theme.textDim, fontSize: 13, marginTop: 4},
  pick: {marginTop: 20, width: '100%', maxWidth: 320},
  ledRow: {marginTop: 18, marginBottom: 10},
  pad: {width: '100%', maxWidth: 320},
  footer: {flexDirection: 'row', gap: 10, marginTop: 22, width: '100%', maxWidth: 320},
  settling: {
    color: theme.warn,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginBottom: 12,
    maxWidth: 320,
  },
  note: {
    color: theme.textDim,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 18,
    maxWidth: 320,
  },
});
