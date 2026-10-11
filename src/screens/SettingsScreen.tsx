import React, {useCallback, useEffect, useState, type ReactNode} from 'react';
import {BackHandler, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';

/*
 * SETTINGS (Brad, 2026-10-11: "i need a new tab called Setting, that opens a view with buttons
 * that take you to a sub view to those tabs ... (that has a back button) like our edge budget
 * details view ... it uses the native action bar/gestures for back also"). PIN Setup,
 * Preferences and Advanced leave the drawer (App.tsx HIDDEN_TABS, their code kept) and open
 * from here instead. The page itself is App's: the same element its old tab drew (render).
 */
export const SETTINGS_PAGES = ['PIN Setup', 'Preferences', 'Backup/Restore', 'Firmware', 'Advanced'] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

export function SettingsScreen({render, hidden = []}: {
  render: (page: SettingsPage) => ReactNode;
  /* pages with nothing to offer this key, left out of the list - Firmware for a soft key (Brad, 2026-10-11) */
  hidden?: readonly SettingsPage[];
}) {
  const [page, setPage] = useState<SettingsPage | null>(null);
  const back = useCallback(() => setPage(null), []);
  /* the phone's own Back (button or gesture) goes back too, as the ‹ Back button does - as Edge's budget view */
  useEffect(() => {
    if (!page) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => sub.remove();
  }, [page, back]);

  if (page) {
    return (
      <View style={styles.root}>
        {/* the page's name beside Back (Brad, 2026-10-11: "next to back button,, should say Preferences") */}
        <View style={styles.row}>
          <Btn title="‹ Back" onPress={back} />
          {/* its own box, offset like a Btn (marginTop 10), so the two texts share one line */}
          <View style={styles.titleBox}>
            <Text style={styles.title}>{page}</Text>
          </View>
        </View>
        <View style={styles.root}>{render(page)}</View>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.list}>
      {SETTINGS_PAGES.filter(p => !hidden.includes(p)).map(p => (
        <Section key={p} title={p}>
          <Text style={styles.body}>{ABOUT[p].what}</Text>
          <Text style={[styles.risk, {color: RISK_COLOR[ABOUT[p].level]}]}>{ABOUT[p].risk}</Text>
          <Btn title={`Open ${p}`} onPress={() => setPage(p)} />
        </Section>
      ))}
    </ScrollView>
  );
}

/*
 * A PANEL PER PAGE, its context and its risks above the button (Brad, 2026-10-11: "a
 * description above the button on the context and risks they contain (advanced has
 * destructive settings, and preferences does not for example)"). Each line says what that
 * screen really holds - keep it true when the screen changes.
 */
type Level = 'safe' | 'care' | 'danger';
const ABOUT: Record<SettingsPage, {what: string; risk: string; level: Level}> = {
  'PIN Setup': {
    what: "The key's PINs: the PIN that unlocks it, and the optional Self-Destruct PIN.",
    risk: 'A PIN cannot be recovered - ten wrong tries wipe the key. A Self-Destruct PIN wipes the key the moment it is entered.',
    level: 'danger',
  },
  Preferences: {
    what: "Settings you can change back: the key's own preferences, the keyboard layout, unlock with biometrics, and this phone's permissions and passkey provider.",
    risk: 'Nothing here is one-way: every setting can be set again.',
    level: 'safe',
  },
  'Backup/Restore': {
    what: "Capture a backup of the key, set the key that protects backups, and restore a backup onto a key. Writing to the key needs config mode.",
    risk: 'A backup holds every slot and key, encrypted - keep the file safe. A restore replaces what is on the key.',
    level: 'care',
  },
  Firmware: {
    what: "Update the firmware of the hard key on USB. Shown only while a hard key is attached: a soft key's firmware is built into the app.",
    risk: 'An update reboots a hard key into its bootloader and needs config mode; do not unplug it halfway.',
    level: 'care',
  },
  Advanced: {
    what: 'Settings that cannot be undone, the key model, and how to do the rest on a computer.',
    risk: 'One-way: once set, these cannot be changed back - they decide, for example, what a future wipe destroys.',
    level: 'danger',
  },
};
const RISK_COLOR: Record<Level, string> = {safe: theme.textDim, care: theme.warn, danger: theme.error};

const styles = StyleSheet.create({
  root: {flex: 1},
  row: {flexDirection: 'row', alignItems: 'stretch', paddingHorizontal: 16, paddingTop: 16},
  titleBox: {marginTop: 10, marginLeft: 16, justifyContent: 'center'},
  title: {color: theme.text, fontSize: 18, fontWeight: '700'},
  list: {padding: 16},
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  risk: {fontSize: 13, lineHeight: 19, marginTop: 8},
});
