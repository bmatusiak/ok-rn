/**
 * BottomDrawer - a panel that slides up from the bottom of the screen (Brad,
 * 2026-10-04: "turn agents panel into a slide up drawer"). Re-usable: a handle
 * bar sits at the bottom of the screen (its title, a count); tap it or swipe it
 * up and the panel slides up over the screen; tap the backdrop, the handle
 * again, swipe it down, or press Back to close it.
 *
 * The screen under it gives its list `bottomInset={DRAWER_HANDLE}` so the last
 * row is never under the handle (src/ui/EdgeList.tsx).
 */
import React, {useMemo, useState} from 'react';
import {PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import {Sheet} from './Sheet';
import {theme} from './theme';

/* the handle's height - what a list under it leaves free */
export const DRAWER_HANDLE = 56;

export function BottomDrawer({title, count, children}: {title: string; count?: number; children: React.ReactNode}) {
  const [open, setOpen] = useState(false);
  /* a swipe on the handle: up opens, down closes */
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 12,
        onPanResponderRelease: (_e, g) => {
          if (g.dy < -24) setOpen(true);
          else if (g.dy > 24) setOpen(false);
        },
      }),
    [],
  );
  const label = count !== undefined ? `${title} (${count})` : title;
  return (
    <>
      {/* pinned to the bottom of the screen's content, which already ends above the gesture / 3-button
          bar (the Shell's SafeAreaView) - adding the inset here counted it twice (Pixel, 2026-10-12) */}
      <View style={styles.handleBar} {...swipe.panHandlers}>
        <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`Open ${title}`} style={styles.handleTap}>
          <View style={styles.grip} />
          <Text style={styles.handleText}>{`▲ ${label}`}</Text>
        </Pressable>
      </View>
      {/* open: the app's Sheet - it keeps the panel clear of the system bars */}
      <Sheet
        visible={open}
        flush
        extraBottom={16}
        onClose={() => setOpen(false)}
        header={
          <View {...swipe.panHandlers}>
            <Pressable onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel={`Close ${title}`} style={styles.handleTap}>
              <View style={styles.grip} />
              <Text style={styles.handleText}>{`▼ ${label}`}</Text>
            </Pressable>
          </View>
        }>
        {children}
      </Sheet>
    </>
  );
}

/* an area of its own inside a drawer (a toggle, a group of controls): full width, a hairline under it */
export function DrawerArea({children}: {children: React.ReactNode}) {
  return <View style={styles.area}>{children}</View>;
}

const styles = StyleSheet.create({
  handleBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: DRAWER_HANDLE,
    backgroundColor: theme.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border,
    borderTopLeftRadius: 14, borderTopRightRadius: 14,
  },
  handleTap: {height: DRAWER_HANDLE, alignItems: 'center', justifyContent: 'center', gap: 4},
  grip: {width: 40, height: 4, borderRadius: 2, backgroundColor: theme.border},
  handleText: {color: theme.text, fontWeight: '600', fontSize: 14},
  area: {paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, gap: 8},
});
