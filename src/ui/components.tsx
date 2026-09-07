import React from 'react';
import {
  FlatList,
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

export function LogList({entries}: {entries: LogEntry[]}) {
  return (
    <FlatList
      data={entries}
      style={styles.log}
      contentContainerStyle={styles.logContent}
      keyExtractor={item => String(item.id)}
      ListEmptyComponent={<Text style={styles.logEmpty}>No traffic yet.</Text>}
      renderItem={({item}) => (
        <Text style={styles.logLine} numberOfLines={3}>
          <Text style={styles.logTime}>{item.at} </Text>
          <Text style={{color: levelColor[item.level]}}>{item.text}</Text>
        </Text>
      )}
    />
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
    flex: 1,
    backgroundColor: '#080a0c',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
  },
  logContent: {padding: 10},
  logEmpty: {color: theme.textDim, fontSize: 12, fontStyle: 'italic'},
  logLine: {fontFamily: theme.mono, fontSize: 11, marginBottom: 3},
  logTime: {color: '#4a5560'},
});
