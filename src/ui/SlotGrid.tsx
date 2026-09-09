import React from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {theme} from './theme';

/*
 * The slot grid, mirroring the desktop app.
 *
 * Three rows of labelled buttons with the device between them, so the layout
 * says which physical button a slot belongs to without anyone having to explain
 * it: 1a and 1b are on the left of the top row because button 1 is at the top
 * left of the key. That is the whole reason for the photo, and it is why this
 * is not a list.
 *
 * Source: ok-app-rewrite SlotGrid.tsx:59-90 and CLASSIC_SLOT_ROWS in
 * firmwareConstants.ts:141-148. There it is a CSS grid with the image spanning
 * three rows; here it is three columns side by side, which produces the same
 * picture without needing row spans.
 *
 * IT IS TIGHT IN PORTRAIT and the numbers below are the compromise. On a phone
 * a pill cannot hold a 16-character label at a readable size next to a photo,
 * so the label truncates to one line and the slot id stays fixed-width beside
 * it - the id is what someone scans for, and a label that wraps would make the
 * rows different heights and the grid stop reading as a device.
 */

/** The desktop's CLASSIC_SLOT_ROWS, transcribed. */
export const CLASSIC_SLOT_ROWS: {
  left: {id: string; index: number}[];
  right: {id: string; index: number}[];
}[] = [
  {left: [{id: '1a', index: 1}, {id: '1b', index: 7}], right: [{id: '2a', index: 2}, {id: '2b', index: 8}]},
  {left: [{id: '3a', index: 3}, {id: '3b', index: 9}], right: [{id: '4a', index: 4}, {id: '4b', index: 10}]},
  {left: [{id: '5a', index: 5}, {id: '5b', index: 11}], right: [{id: '6a', index: 6}, {id: '6b', index: 12}]},
];

/**
 * What the desktop shows for a slot the device reported no label for.
 *
 * NOT "unused". The device only ever sends labels - never urls, usernames or
 * passwords - so an unlabelled slot may still be full. The desktop app says so
 * in a note under the grid and this repeats it, because the word "empty" is
 * exactly the wrong inference to invite.
 */
export const EMPTY_SLOT_LABEL = 'no label';

export function SlotGrid({
  labels,
  onSelect,
  selected = null,
}: {
  /** Indexed by slot number 1..12, as readLabels returns them. */
  labels: (string | null)[];
  onSelect: (slot: {id: string; index: number}) => void;
  selected?: number | null;
}) {
  return (
    <View style={styles.grid}>
      <View style={styles.column}>
        {CLASSIC_SLOT_ROWS.map(row => (
          <SlotPair
            key={row.left[0].id}
            slots={row.left}
            labels={labels}
            onSelect={onSelect}
            selected={selected}
            align="flex-end"
          />
        ))}
      </View>

      <Image
        source={require('../../assets/onlykey-photo.png')}
        style={styles.device}
        resizeMode="contain"
        accessibilityLabel="OnlyKey device"
      />

      <View style={styles.column}>
        {CLASSIC_SLOT_ROWS.map(row => (
          <SlotPair
            key={row.right[0].id}
            slots={row.right}
            labels={labels}
            onSelect={onSelect}
            selected={selected}
            align="flex-start"
          />
        ))}
      </View>
    </View>
  );
}

/** The two slots of one button: the a profile above the b profile. */
function SlotPair({
  slots,
  labels,
  onSelect,
  selected,
  align,
}: {
  slots: {id: string; index: number}[];
  labels: (string | null)[];
  onSelect: (slot: {id: string; index: number}) => void;
  selected: number | null;
  align: 'flex-start' | 'flex-end';
}) {
  return (
    <View style={styles.pair}>
      {slots.map(slot => {
        const label = labels[slot.index - 1];
        return (
          <Pressable
            key={slot.id}
            onPress={() => onSelect(slot)}
            accessibilityRole="button"
            accessibilityLabel={`Slot ${slot.id}${label ? `, ${label}` : ', no label'}`}
            style={({pressed}) => [
              styles.pill,
              {alignSelf: 'stretch'},
              pressed && styles.pillPressed,
              selected === slot.index && styles.pillSelected,
            ]}>
            <View style={[styles.pillInner, align === 'flex-end' && styles.pillInnerRight]}>
              <Text style={styles.pillId}>{slot.id}</Text>
              <Text
                style={[styles.pillLabel, !label && styles.pillEmpty]}
                numberOfLines={1}>
                {label || EMPTY_SLOT_LABEL}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {flexDirection: 'row', alignItems: 'center', gap: 8},

  /*
   * The two label columns share what the photo does not take. flex on both
   * with a fixed-width image between them keeps the pills equal on each side
   * whatever the screen width, which is what stops the grid looking lopsided
   * on a narrow phone.
   */
  column: {flex: 1, gap: 14, justifyContent: 'center'},
  pair: {gap: 6},

  /*
   * 1583x2050 in the source, so height/width is 1.295. Stated rather than left
   * to resizeMode so the two columns get a stable width to divide - an image
   * that sized itself would resize the pills beside it as it loaded.
   */
  device: {width: 104, height: 135},

  pill: {
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  pillPressed: {backgroundColor: theme.surfaceAlt, borderColor: theme.accent},
  pillSelected: {borderColor: theme.accent},

  pillInner: {flexDirection: 'row', alignItems: 'center', gap: 8},
  pillInnerRight: {justifyContent: 'flex-end'},

  /* Fixed width so the labels line up down the column rather than stepping. */
  pillId: {
    color: theme.textDim,
    fontSize: 12,
    fontFamily: theme.mono,
    width: 20,
  },
  pillLabel: {color: theme.text, fontSize: 13, flexShrink: 1},
  pillEmpty: {color: theme.textDim, fontStyle: 'italic'},
});
