import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Logo} from './Logo';
import {theme} from './theme';

/*
 * A left menu, opened by the logo in the top bar.
 *
 * Plain absolute positioning rather than a Modal or a navigation library: a
 * Modal renders in its own window and would sit OUTSIDE the SafeAreaView, so it
 * would need its own insets and would cover the testing banner. Nothing here
 * needs a route - the drawer picks which of four views is mounted.
 */
export function Drawer<T extends string>({
  open,
  tabs,
  value,
  onChange,
  onClose,
  footer,
}: {
  open: boolean;
  tabs: readonly T[];
  value: T;
  onChange: (next: T) => void;
  onClose: () => void;
  footer?: React.ReactNode;
}) {
  /*
   * The panel carries its own insets.
   *
   * It is absolutely positioned, and an absolute child is laid out against the
   * border box - so it spans the SafeAreaView's padding rather than sitting
   * inside it. Without this the logo hides behind the status bar and the
   * footer button lands on top of the navigation bar, which is exactly what
   * happened.
   */
  const insets = useSafeAreaInsets();

  if (!open) {
    return null;
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Tapping anywhere off the panel closes it - the usual escape. */}
      <Pressable
        style={styles.scrim}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close menu"
      />
      <View
        style={[
          styles.panel,
          {paddingTop: insets.top + 14, paddingBottom: insets.bottom + 12},
        ]}>
        <View style={styles.head}>
          <Logo height={24} />
        </View>

        {/*
          * THE TABS SCROLL; the logo and the footer do not.
          *
          * They were laid out directly in the panel, which is fixed to the
          * full height of the screen - so once the list outgrew that height
          * the overflow was simply unreachable. In landscape that was the
          * last two entries, Log and Passkeys, with no indication they
          * existed. A list whose length depends on which capabilities the
          * key reports is not one to lay out as if it always fits.
          *
          * flex: 1 gives it whatever is left between the two fixed pieces,
          * which is also what keeps the footer pinned to the bottom. The
          * panel's own paddingBottom still clears the gesture bar, and the
          * ScrollView sits inside it, so nothing needs to move.
          */}
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}>
          {tabs.map(tab => {
            const active = tab === value;
            return (
              <Pressable
                key={tab}
                onPress={() => {
                  onChange(tab);
                  onClose();
                }}
                style={({pressed}) => [
                  styles.item,
                  active && styles.itemActive,
                  pressed && styles.itemPressed,
                ]}>
                <Text style={[styles.itemText, active && styles.itemTextActive]}>
                  {tab}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 232,
    backgroundColor: theme.surface,
    borderRightWidth: 1,
    borderRightColor: theme.border,
    paddingHorizontal: 12,
  },
  head: {paddingHorizontal: 8, paddingBottom: 16},
  list: {flex: 1},
  /* No flexGrow: the list is content-sized and scrolls only when it overflows. */
  listContent: {paddingBottom: 4},
  item: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: theme.radius,
    marginBottom: 2,
  },
  itemActive: {backgroundColor: theme.surfaceAlt},
  itemPressed: {opacity: 0.7},
  itemText: {color: theme.textSecondary, fontSize: 15},
  itemTextActive: {color: theme.text, fontWeight: '700'},
  footer: {marginTop: 'auto', paddingHorizontal: 4, gap: 8},
});
