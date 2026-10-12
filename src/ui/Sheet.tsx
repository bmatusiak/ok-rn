import React from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {theme} from './theme';

/*
 * THE SHEET: one bottom sheet for every prompt in the app (Brad, 2026-10-12: "the sheet view is
 * used in many areas, it should be reusable, one thing i always notice when you add stuff to the
 * UI, you never consider the action/guesture or status/notification bar's space. if we make stuff
 * re-usable, it prevents this kinda thing").
 *
 * THE SYSTEM BARS ARE HANDLED HERE, AND ONLY HERE. The app draws edge to edge
 * (android/gradle.properties edgeToEdgeEnabled), and a Modal is its own window, so a sheet has to
 * keep its own content off the bars:
 *   - bottom: the gesture bar (the Pixel) or the 3-button bar (the A13 - which once covered a
 *     sheet's Close, 2026-10-10) - the content sits above the bottom inset;
 *   - top: the status bar and a camera cutout - the sheet is never taller than the window less the
 *     top inset, so its top edge stays below the clock.
 * The Modal is told it draws under both bars (statusBarTranslucent, navigationBarTranslucent), so
 * the insets mean the same thing on every phone.
 *
 * A COLOUR PER FEATURE, so a person sees at a glance which feature is asking (Brad, 2026-10-12):
 * Edge = yellow, Guest Book = blue, neutral = none. The title takes the same colour.
 *
 * Closing: with onClose, Back and a tap on the dimmed backdrop close it; without, nothing does (a
 * press waiting on the key, a live Edge request) - the sheet goes away when its owner hides it.
 */

export type SheetTone = 'edge' | 'guestbook' | 'neutral';

const TONE_COLOR: Record<SheetTone, string | null> = {edge: theme.warn, guestbook: theme.accentHover, neutral: null};
/* room left above a full-height sheet, under the status bar */
const TOP_GAP = 24;

export function Sheet({
  visible = true,
  tone = 'neutral',
  title,
  titleColor,
  onClose,
  header,
  footer,
  flush = false,
  extraBottom = 0,
  children,
}: {
  visible?: boolean;
  tone?: SheetTone;
  title?: string;
  /* a title colour other than the tone's (the press sheet's TESTNET) */
  titleColor?: string;
  onClose?: () => void;
  /* fixed above the scrolling body (the drawer's handle) */
  header?: React.ReactNode;
  /* buttons that stay in view under the scrolling body */
  footer?: React.ReactNode;
  /* no padding around the body: its rows draw their own (the drawer's areas) */
  flush?: boolean;
  /* more room under the body (the press sheet's: React Native's debug warnings sit along the bottom) */
  extraBottom?: number;
  children?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const {height} = useWindowDimensions();
  const edge = TONE_COLOR[tone];
  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose ?? (() => undefined)}>
      <View style={styles.backdrop}>
        {onClose ? <Pressable style={styles.dismiss} onPress={onClose} accessibilityLabel="Close" /> : null}
        <View
          testID="sheet"
          style={[
            styles.sheet,
            edge ? {borderTopWidth: 2, borderColor: edge} : styles.plainEdge,
            {maxHeight: height - insets.top - TOP_GAP, paddingBottom: insets.bottom},
          ]}>
          {header}
          <ScrollView contentContainerStyle={[flush ? null : styles.body, {paddingBottom: (flush ? 8 : 16) + extraBottom}]} keyboardShouldPersistTaps="handled">
            {title ? <Text style={[styles.title, {color: titleColor ?? edge ?? theme.text}]}>{title}</Text> : null}
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  dismiss: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  sheet: {backgroundColor: theme.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14},
  plainEdge: {borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border},
  body: {padding: 16, gap: 8},
  title: {fontWeight: '600', fontSize: 17},
  footer: {paddingHorizontal: 16, paddingBottom: 16, paddingTop: 8, gap: 8},
});
