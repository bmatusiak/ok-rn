import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {theme} from './theme';

/*
 * The device's entire input surface: six buttons.
 *
 * On hardware these are capacitive pads on the key itself. Here the phone is
 * the key, so this pad IS the device's buttons - every tap goes through
 * okemu_set_button() into the firmware's touch_sense_loop(), and the firmware
 * cannot tell the difference.
 *
 * Taps only, deliberately. Press length is banded in MAIN-LOOP ITERATIONS
 * rather than milliseconds, so the millisecond boundaries are not the
 * hardware's and nothing here has measured them - and the long bands are where
 * the irreversible gestures live: >=72 iterations on button 1 runs backup(), on
 * button 3 locks the device with CPU_RESTART(), on button 6 enters config mode.
 */
export function Keypad({
  onPress,
  disabled = false,
}: {
  onPress: (button: number) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.pad}>
      {[
        [1, 2, 3],
        [4, 5, 6],
      ].map(row => (
        <View key={row[0]} style={styles.row}>
          {row.map(n => (
            <Pressable
              key={n}
              disabled={disabled}
              onPress={() => onPress(n)}
              accessibilityRole="button"
              accessibilityLabel={`Button ${n}`}
              style={({pressed}) => [
                styles.key,
                pressed && styles.keyPressed,
                disabled && styles.keyDisabled,
              ]}>
              <Text style={styles.keyText}>{n}</Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * How many digits have been entered, without saying which.
 *
 * `max` is the longest PIN the firmware accepts, so the row does not resize as
 * you type - a pad that reflows under your thumb is a pad you mis-tap.
 */
export function PinDots({count, max = 10}: {count: number; max?: number}) {
  return (
    <View style={styles.dots}>
      {Array.from({length: max}, (_, i) => (
        <View key={i} style={[styles.dot, i < count && styles.dotFilled]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: {gap: 12},
  row: {flexDirection: 'row', gap: 12},
  key: {
    flex: 1,
    // Comfortably past the 44px touch minimum: this is the control a PIN is
    // typed on, under time pressure, and a mis-tap costs a login attempt.
    height: 68,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  keyPressed: {backgroundColor: theme.surfaceAlt, borderColor: theme.accent},
  keyDisabled: {opacity: 0.35},
  keyText: {color: theme.text, fontSize: 24, fontWeight: '600'},

  dots: {flexDirection: 'row', gap: 8, justifyContent: 'center'},
  dot: {
    width: 10,
    height: 10,
    borderRadius: theme.radiusPill,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: 'transparent',
  },
  dotFilled: {backgroundColor: theme.accent, borderColor: theme.accent},
});
