import React, {useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {device as okdevice} from 'node-onlykey-lib';
import {Segmented} from './components';
import {theme} from './theme';

/**
 * A DUO's slots: three buttons, a and b each, in FOUR profiles.
 *
 * The Classic grid draws a photo of the key with six pairs around it; this
 * one said a DUO had "no such picture yet" and drew a bare list. The
 * desktop app has had one all along - `duo-photo.jpg` behind the
 * `okduo-photo-cell` of its DUO slot table (app.html:436,
 * stylesheets/style.css:292) - and it is the same reason the Classic has
 * one: the pads are unlabelled on the device, and a picture is how you know
 * which pad the row in front of you means.
 *
 * The desktop ships it as a JPEG on a white page. On a dark screen that is
 * a bright white card, so the copy in assets/ is a PNG with the white made
 * transparent and scaled to 440px - the desktop's is 2000x2000, which is
 * 2.7 MB to draw something 88 points wide.
 *
 * AND THE PHOTO SHOWS TWO PADS, WHICH IS THE POINT. A DUO has button 1 and
 * button 2 and nothing else; "button 3" is BOTH OF THEM AT ONCE. The
 * firmware makes it on release, after counting iterations where both touch
 * reads are above the threshold at the same time (okcore.cpp:2586-2608 set
 * `button_3_on`, :2724 turns it into `button_selected = '3'`), and the
 * desktop says so in words next to its grid ("Press both buttons #1 and #2
 * at the same time for slot 3", app.html:1854). This listed "button 3"
 * beside the other two as though it were a third pad to look for.
 *
 * The rest is a shape the firmware defines - profile p, button n, side a/b -
 * which the library's slotNumber() turns into the index the device uses. The
 * profile switcher is a DISPLAY FILTER: all 24 labels are read at once and
 * this shows six of them, because a person holds one profile in mind at a
 * time and the firmware itself selects profiles with a button.
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

      <Image
        source={require('../../assets/duo-photo.png')}
        style={styles.device}
        resizeMode="contain"
        accessibilityLabel="OnlyKey DUO, showing its two touch pads"
      />

      <Text style={styles.pads}>
        Two pads. Holding both at once is what the key reads as button 3.
      </Text>

      <View style={styles.rows}>
        {BUTTONS.map(button => {
          const n = 3 * p + button;
          return (
            <View key={button} style={styles.row}>
              <Text style={styles.button}>
                {button === 3 ? '1 + 2' : `button ${button}`}
              </Text>
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
  /*
   * The desktop draws the DUO at 120x180 against the Classic's 210x260
   * (style.css:283,292) - a DUO is a smaller device and its picture is
   * mostly the USB contacts. Same ratio here, centred, because the rows
   * below are full width rather than wrapped around it: six pills will not
   * fit either side of a picture on a phone.
   */
  device: {width: 88, height: 132, alignSelf: 'center', marginTop: 10},
  pads: {color: theme.textDim, fontSize: 11, lineHeight: 16, textAlign: 'center'},
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
