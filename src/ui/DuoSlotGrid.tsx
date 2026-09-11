import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {device as okdevice} from 'node-onlykey-lib';
import {Segmented} from './components';
import {theme} from './theme';

/**
 * A DUO's slots: three buttons, a and b each, in FOUR profiles.
 *
 * The Classic grid draws a photo of the key with six pairs around it. A DUO
 * has 24 slots and no such picture yet; what it has is a shape the firmware
 * defines - profile p, button n, side a/b - and the library's slotNumber()
 * turns that into the index the device uses. The profile switcher is a
 * DISPLAY FILTER: all 24 labels are read at once and this shows six of them,
 * because a person holds one profile in mind at a time and the firmware
 * itself selects profiles with a button.
 *
 * Slot ids here are the library's DUO ids: button numbers run 1-12 across
 * the four profiles (profile 2's first button is "4"), so the editor's
 * readSlot() and setSlot() take them as they are.
 */
const PROFILES = ['1', '2', '3', '4'] as const;
type Profile = (typeof PROFILES)[number];
const BUTTONS = [1, 2, 3];
const EMPTY_SLOT_LABEL = 'no label';

export function DuoSlotGrid({
  labels,
  onSelect,
  selected = null,
}: {
  /** Indexed by slot number 1..24, as readLabels returns them. */
  labels: (string | null)[];
  onSelect: (slot: {id: string; index: number}) => void;
  selected?: number | null;
}) {
  const [profile, setProfile] = useState<Profile>('1');
  const p = Number(profile) - 1;

  return (
    <View style={styles.root}>
      <Text style={styles.label}>Profile</Text>
      <Segmented options={PROFILES} value={profile} onChange={setProfile} />
      <View style={styles.rows}>
        {BUTTONS.map(button => {
          const n = 3 * p + button;
          return (
            <View key={button} style={styles.row}>
              <Text style={styles.button}>button {button}</Text>
              {(['a', 'b'] as const).map(side => {
                const id = `${n}${side}`;
                const index = okdevice.slots.slotNumber(id, okdevice.slots.DEVICE_TYPE.DUO);
                const label = labels[index - 1];
                return (
                  <Pressable
                    key={id}
                    onPress={() => onSelect({id, index})}
                    accessibilityRole="button"
                    accessibilityLabel={`Slot ${id}${label ? `, ${label}` : ', no label'}`}
                    style={({pressed}) => [
                      styles.pill,
                      pressed && styles.pillPressed,
                      selected === index && styles.pillSelected,
                    ]}>
                    <Text style={styles.pillId}>{`${button}${side}`}</Text>
                    <Text style={[styles.pillLabel, !label && styles.pillEmpty]} numberOfLines={1}>
                      {label || EMPTY_SLOT_LABEL}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          );
        })}
      </View>
      <Text style={styles.note}>
        Profile {profile} of 4. Slot ids on the key run {3 * p + 1}a to {3 * p + 3}b for
        this profile; the editor uses those.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {gap: 8},
  label: {color: theme.text, fontSize: 13, fontWeight: '600'},
  rows: {gap: 10, marginTop: 4},
  row: {flexDirection: 'row', alignItems: 'center', gap: 8},
  button: {color: theme.textDim, fontSize: 12, width: 64},
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  pillPressed: {backgroundColor: theme.surfaceAlt},
  pillSelected: {borderColor: theme.accent},
  pillId: {color: theme.textDim, fontFamily: theme.mono, fontSize: 12},
  pillLabel: {color: theme.text, fontSize: 14, flex: 1},
  pillEmpty: {color: theme.textDim, fontStyle: 'italic'},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18},
});
