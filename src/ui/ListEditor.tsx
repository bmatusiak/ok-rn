import React from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {theme} from './theme';

/*
 * A LIST YOU ADD TO AND REMOVE FROM, the way a phone's contacts app edits phones and emails (Brad,
 * 2026-10-13: "a list view where we can add and remove items for a contact looks cleaner, following
 * the design i see in other contact apps"). Each row: an optional label (tap to change it - Mobile,
 * Home, Work, Other), the value, and ✕ to remove it; "+ Add …" under the rows. The screen owns the
 * rows and decides when they are saved.
 */

export type ListRow = {label?: string; value: string};

export function ListEditor({
  title,
  rows,
  onChange,
  addTitle,
  labels,
  placeholder,
  keyboardType,
}: {
  title: string;
  rows: ListRow[];
  onChange: (rows: ListRow[]) => void;
  addTitle: string;
  /** the labels a row cycles through on tap; none: rows have no label */
  labels?: string[];
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad' | 'email-address';
}) {
  const set = (i: number, row: ListRow) => onChange(rows.map((r, j) => (j === i ? row : r)));
  const nextLabel = (l?: string) => (labels ? labels[(labels.indexOf(l ?? labels[0]) + 1) % labels.length] : undefined);
  return (
    <View style={styles.block}>
      <Text style={styles.title}>{title}</Text>
      {rows.map((r, i) => (
        <View key={i} style={styles.row}>
          {labels ? (
            <Pressable onPress={() => set(i, {...r, label: nextLabel(r.label)})} style={styles.label} accessibilityRole="button" accessibilityLabel={`${title} label ${r.label ?? labels[0]}, tap to change`}>
              <Text style={styles.labelText}>{r.label ?? labels[0]} ▾</Text>
            </Pressable>
          ) : null}
          <TextInput
            value={r.value}
            onChangeText={v => set(i, {...r, value: v})}
            placeholder={placeholder}
            placeholderTextColor={theme.textDim}
            keyboardType={keyboardType}
            autoCapitalize="none"
            autoCorrect={false}
            importantForAutofill="no"
            style={styles.input}
            accessibilityLabel={`${title} ${i + 1}`}
          />
          <Pressable onPress={() => onChange(rows.filter((_, j) => j !== i))} style={styles.remove} accessibilityRole="button" accessibilityLabel={`Remove ${title} ${i + 1}`}>
            <Text style={styles.removeText}>✕</Text>
          </Pressable>
        </View>
      ))}
      <Pressable onPress={() => onChange([...rows, {label: labels?.[0], value: ''}])} style={styles.add} accessibilityRole="button" accessibilityLabel={addTitle}>
        <Text style={styles.addText}>+ {addTitle}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {gap: 6},
  title: {color: theme.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 8},
  label: {paddingHorizontal: 10, paddingVertical: 9, borderRadius: theme.radius, backgroundColor: theme.surfaceAlt, minWidth: 92},
  labelText: {color: theme.text, fontSize: 14},
  input: {flex: 1, color: theme.text, fontSize: 15, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: theme.inputBg, borderRadius: theme.radius, borderWidth: 1, borderColor: theme.border},
  remove: {paddingHorizontal: 10, paddingVertical: 8},
  removeText: {color: theme.error, fontSize: 18},
  add: {paddingVertical: 8},
  addText: {color: theme.link, fontSize: 15},
});
