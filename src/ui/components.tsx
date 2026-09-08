import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type {LogEntry} from '../hooks/useLog';
import {levelColor, stateColor, theme} from './theme';

export function StatusPill({state, label}: {state: string; label?: string}) {
  const color = stateColor(state);
  return (
    <View style={[styles.pill, {borderColor: color}]}>
      <View style={[styles.dot, {backgroundColor: color}]} />
      <Text style={[styles.pillText, {color}]}>{label ?? state}</Text>
    </View>
  );
}

export function Section({
  title,
  right,
  children,
  style,
}: {
  title: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.section, style]}>
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
  const fg = tone === 'default' ? theme.text : '#0b0d10';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({pressed}) => [
        styles.btn,
        {backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1},
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
