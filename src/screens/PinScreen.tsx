import React, {useCallback, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Keypad, PinDots} from '../ui/Keypad';
import {Logo} from '../ui/Logo';
import {Btn} from '../ui/components';
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

  const press = useCallback(
    async (button: number) => {
      if (working || count >= MAX_PIN) {
        return;
      }
      setWorking(true);
      try {
        await onPress(button);
        setCount(prev => prev + 1);
      } finally {
        setWorking(false);
      }
    },
    [count, onPress, working],
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
  const startOver = useCallback(async () => {
    if (working || count === 0) {
      return;
    }
    setWorking(true);
    try {
      for (let i = count; i < MAX_PIN; i++) {
        await onPress(6);
      }
      setCount(0);
    } finally {
      setWorking(false);
    }
  }, [count, onPress, working]);

  return (
    <View style={styles.root}>
      <Logo height={30} />

      <Text style={styles.title}>Locked</Text>
      <Text style={styles.hint}>Enter your PIN on the keypad.</Text>

      <View style={styles.dots}>
        <PinDots count={count} max={MAX_PIN} />
      </View>

      <View style={styles.pad}>
        <Keypad onPress={press} disabled={busy || working} />
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
