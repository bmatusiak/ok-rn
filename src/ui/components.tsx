import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {device as okdevice} from 'node-onlykey-lib';
import type {LogEntry} from '../hooks/useLog';
import {ledColor, levelColor, stateColor, theme} from './theme';

export function StatusPill({
  state,
  label,
  dotColor,
  tone,
}: {
  state: string;
  label?: string;
  /**
   * Colour for the DOT ONLY, leaving the border and the word alone.
   *
   * The pill says what the device IS - locked, unlocked - and that reading
   * must not change colour just because a light blinked. The dot says what it
   * is DOING: on a soft key it mirrors the firmware's own NeoPixel, which is
   * the only activity feedback a real key gives you. Nothing passes this for a
   * hard key, so its dot keeps the state colour.
   */
  dotColor?: string | null;
  /**
   * Overrides the pill's colour while leaving the WORD alone.
   *
   * For config mode, which is not a lock state and must not be drawn as one.
   * The key may well be unlocked and the word has to keep saying so - but it
   * will not sign or type, and only a restart ends that. The reading stays
   * true; the colour carries the caveat.
   */
  tone?: string | null;
}) {
  const color = tone ?? stateColor(state);
  return (
    <View style={[styles.pill, {borderColor: color}]}>
      <View style={[styles.dot, {backgroundColor: dotColor ?? color}]} />
      <Text style={[styles.pillText, {color}]}>{label ?? state}</Text>
    </View>
  );
}

/**
 * The device's own LED, drawn as the part it is.
 *
 * SOFT KEYS ONLY. It is the only feedback a key gives while a PIN goes in -
 * the device says nothing about how many digits have landed or whether one was
 * wrong - so callers pass `pixels` for the soft key and nothing for a hard
 * one, whose LED is on the key in your hand.
 */
export function LedCircle({
  pixels,
  size = 44,
}: {
  pixels: number[];
  size?: number;
}) {
  return (
    <View
      style={[
        styles.led,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: ledColor(pixels) ?? theme.surface,
        },
      ]}
    />
  );
}

/**
 * The counted hold, somewhere a thumb is not, coloured by the band it is in.
 *
 * It used to be drawn on the key being held - the one spot guaranteed to be
 * under a finger.
 *
 * THREE PRESS TYPES, in the words a user thinks in. `bandFor()` owns where the
 * edges are, so this cannot drift from the library that decides what a press
 * means - but its names are the firmware's, and two of them read wrong to
 * someone holding a button:
 *
 *   bandFor     shown as   ticks    what the key does
 *   tap         tap        0-20     types the slot
 *   hold        press      21-71    types the b profile
 *   gesture     hold       72-89    backup / lock / config mode
 *   rejected    too long   90+      the firmware stops banding it at all
 *
 * Green, amber, red. Red starts at the gesture band because that is where a
 * press stops typing something and starts doing something that cannot be taken
 * back - and the label says which, so it can be read before letting go.
 */
const BAND_LABEL: Record<string, string> = {
  tap: 'tap',
  hold: 'press',
  gesture: 'hold',
  rejected: 'too long',
};

export function HoldTicks({ticks}: {ticks?: {button: number; ticks: number} | null}) {
  if (!ticks) {
    return null;
  }
  const band = okdevice.press.bandFor(ticks.ticks);
  const color =
    band === 'tap' ? theme.ok : band === 'hold' ? theme.warn : theme.error;
  const gestures: Record<number, string | undefined> = okdevice.press.GESTURES;
  const does = gestures[ticks.button];
  return (
    <Text style={[styles.holdTicks, {color}]}>
      {ticks.ticks} · {BAND_LABEL[band] ?? band}
      {band === 'gesture' && does ? ` · ${does}` : ''}
    </Text>
  );
}

export function Section({
  title,
  right,
  children,
  style,
  faded,
}: {
  title: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * The firmware on the attached key does not have what this section does.
   *
   * FADED, NOT HIDDEN, and that is the long-standing rule here rather than a
   * choice made for these two screens. A section that vanishes teaches
   * nothing: the person wonders whether they are on the wrong tab, whether
   * the app is broken, or whether the feature was removed. A faded one that
   * says which firmware it needs answers the question on the screen where it
   * was asked.
   *
   * The caller is expected to disable its controls as well. Fading alone
   * leaves a button that looks inert and is not, and pressing it reaches the
   * device, where a missing feature answers with a refusal or with silence -
   * which is the worst of the three outcomes to have to interpret.
   */
  faded?: boolean;
}) {
  return (
    <View style={[styles.section, faded && styles.sectionFaded, style]}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

export function Btn({
  title,
  onPress,
  disabled,
  tone = 'default',
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger';
}) {
  const bg =
    tone === 'primary' ? theme.accent : tone === 'danger' ? theme.error : theme.surfaceAlt;
  /*
   * DARK TEXT ON THE RED, WHITE ON THE BLUE - they are different brightnesses
   * and cannot share a foreground.
   *
   * Both used near-black. Against `accent` (#0056b3) that is 2.8:1, well under
   * the 4.5:1 body text needs, and it reads as smudged rather than as a label -
   * reported from the Backup screen, where the primary button is the one you
   * are looking for. White on the same blue is 7.0:1.
   *
   * `danger` (#f87171) is a LIGHT red and keeps the dark text, which is 7.0:1
   * there; white on it would be 2.7:1, the same mistake mirrored.
   *
   * Fixed values, not theme tokens: the button paints its own background, so
   * the contrast is a property of that pair and not of the surface behind it.
   */
  const fg =
    tone === 'primary' ? '#ffffff' : tone === 'danger' ? '#0b0d10' : theme.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({pressed}) => [
        styles.btn,
        /*
         * 0.4 WAS TOO FAR. A disabled button still has to be READ - it is how
         * you find out what is unavailable and, with the reason beside it, why.
         * At 0.4 the dark text on `danger` fell to about 2:1 against the
         * surface and read as a smear rather than a label; reported from the
         * Backup screen, where Restore sits disabled until a file is read.
         *
         * 0.55 still says "not now" at a glance - it is well below the
         * enabled state - without making the word itself a guess.
         */
        {backgroundColor: bg, opacity: disabled ? 0.55 : pressed ? 0.75 : 1},
      ]}>
      <Text style={[styles.btnText, {color: fg}]}>{title}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map(option => {
        const active = option === value;
        return (
          <Pressable
            key={option}
            onPress={() => onChange(option)}
            style={[styles.segment, active && styles.segmentActive]}>
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function KeyValue({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue}>{value}</Text>
    </View>
  );
}

/**
 * The log, rendered inline rather than in a list of its own.
 *
 * It was a FlatList, which meant it had to own its scrolling and therefore had
 * to be pinned outside the page's ScrollView - a VirtualizedList inside a
 * ScrollView of the same orientation breaks both. Pinned, it sat across the
 * bottom of every screen taking space the controls needed.
 *
 * Nothing was gained by virtualising it: useLog keeps 200 entries at most and
 * drops the oldest, so the worst case is bounded and small. Plain Views scroll
 * with the rest of the page, which is where a log belongs.
 */
export function LogList({entries, limit = 40}: {entries: LogEntry[]; limit?: number}) {
  /*
   * Newest first, and only the newest few.
   *
   * useLog holds 200, and rendering all of them makes the log longer than
   * everything else on the page put together - the controls become a thing you
   * scroll past to reach the part you were not looking for. Forty is about two
   * screens, which is as far back as anyone reads without wanting to search.
   */
  const shown = entries.slice(0, limit);
  const hidden = entries.length - shown.length;

  return (
    <View style={styles.log}>
      {entries.length === 0 ? (
        <Text style={styles.logEmpty}>No traffic yet.</Text>
      ) : (
        <>
          {shown.map(item => (
            <Text key={item.id} style={styles.logLine} numberOfLines={3}>
              <Text style={styles.logTime}>{item.at} </Text>
              {item.count > 1 ? (
                <Text style={styles.logCount}>{'×' + item.count + ' '}</Text>
              ) : null}
              <Text style={{color: levelColor[item.level]}}>{item.text}</Text>
            </Text>
          ))}
          {hidden > 0 ? (
            <Text style={styles.logEmpty}>{hidden} older lines not shown</Text>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  led: {borderWidth: 1, borderColor: theme.border, alignSelf: 'center'},
  holdTicks: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 6,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    gap: 6,
  },
  dot: {width: 7, height: 7, borderRadius: 4},
  pillText: {fontSize: 12, fontWeight: '600'},

  sectionFaded: {opacity: 0.45},
  section: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
    marginBottom: 12,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  sectionTitle: {color: theme.text, fontSize: 15, fontWeight: '700'},

  btn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnText: {fontSize: 13, fontWeight: '600'},

  segmented: {
    flexDirection: 'row',
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    padding: 3,
  },
  segment: {flex: 1, paddingVertical: 7, borderRadius: 6, alignItems: 'center'},
  segmentActive: {backgroundColor: theme.accent},
  segmentText: {color: theme.textDim, fontSize: 12, fontWeight: '600'},
  segmentTextActive: {color: '#0b0d10'},

  kv: {flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3},
  kvLabel: {color: theme.textDim, fontSize: 12},
  kvValue: {color: theme.text, fontSize: 12, fontFamily: theme.mono},

  log: {
    // No flex. It sizes to its content and the page scrolls; claiming a share
    // of the screen is what made it crowd the controls out.
    padding: 10,
    backgroundColor: '#080a0c',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
  },
  logEmpty: {color: theme.textDim, fontSize: 12, fontStyle: 'italic'},
  logLine: {fontFamily: theme.mono, fontSize: 11, marginBottom: 3},
  logTime: {color: '#4a5560'},
  // A repeat count, not a value - dim enough to read past when scanning.
  logCount: {color: theme.textDim, fontWeight: '700'},
});
