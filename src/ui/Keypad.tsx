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
 * Press length is banded in MAIN-LOOP ITERATIONS, not milliseconds:
 *
 *     <= 20      types the slot
 *     21 .. 71   types the b profile
 *     >= 72      backup (button 1), restart (3), config mode (6)
 *
 * This used to be taps only, because a hold timed in milliseconds is a bet
 * against the handset's loop speed with an irreversible action on the losing
 * side. Holds are safe now for a structural reason rather than a careful one:
 * `onHoldStart` arms a COUNTED hold one tick below the gesture band, so the
 * emulator releases the pad at 71 whatever the thumb does. Holding longer
 * simply does nothing.
 *
 * `ticks` is that counter, shown live. On hardware the LED tells you which
 * band you are in while you are still in it; on a phone the pad and the LED
 * are the same screen, so the number goes on the key itself.
 */
export function Keypad({
  onPress,
  onHoldStart,
  onHoldEnd,
  ticks = null,
  disabled = false,
}: {
  onPress: (button: number) => void;
  /** Arms a counted hold. Omit both to keep the pad taps-only. */
  onHoldStart?: (button: number) => void;
  onHoldEnd?: (button: number) => void;
  /** The counted hold in progress, if any. */
  ticks?: {button: number; ticks: number} | null;
  disabled?: boolean;
}) {
  const holdable = Boolean(onHoldStart && onHoldEnd);

  /*
   * A tap must not also fire the hold path. Pressable calls onPressIn for
   * every touch, so the hold is armed on every tap too - and releasing it
   * before the counter has moved is exactly a tap, which is what the firmware
   * then sees. So there is only one path here, and `onPress` is used only
   * when the pad is not holdable at all.
   */
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
              onPress={holdable ? undefined : () => onPress(n)}
              onPressIn={holdable ? () => onHoldStart!(n) : undefined}
              onPressOut={holdable ? () => onHoldEnd!(n) : undefined}
              accessibilityRole="button"
              accessibilityLabel={`Button ${n}`}
              style={({pressed}) => [
                styles.key,
                pressed && styles.keyPressed,
                disabled && styles.keyDisabled,
              ]}>
              <Text style={styles.keyText}>{n}</Text>
              {ticks?.button === n ? (
                <Text
                  style={[
                    styles.ticks,
                    ticks.ticks > 20 && styles.ticksHold,
                  ]}>
                  {ticks.ticks} · {ticks.ticks <= 20 ? 'tap' : 'hold'}
                </Text>
              ) : null}
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
  /*
   * Absolutely positioned so the key does not change height when the counter
   * appears. A pad that grows under your thumb mid-press is a pad you let go
   * of at the wrong moment - and the moment is the whole point here.
   */
  ticks: {
    position: 'absolute',
    bottom: 6,
    color: theme.textDim,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  ticksHold: {color: theme.warn},

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
