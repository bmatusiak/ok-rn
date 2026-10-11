import React, {useCallback, useEffect, useState, type ReactNode} from 'react';
import {BackHandler, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn} from '../ui/components';
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

export function SettingsScreen({render}: {render: (page: SettingsPage) => ReactNode}) {
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
      {SETTINGS_PAGES.map(p => <Btn key={p} title={p} onPress={() => setPage(p)} />)}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  row: {flexDirection: 'row', alignItems: 'stretch', paddingHorizontal: 16, paddingTop: 16},
  titleBox: {marginTop: 10, marginLeft: 16, justifyContent: 'center'},
  title: {color: theme.text, fontSize: 18, fontWeight: '700'},
  list: {padding: 16, gap: 12},
});
