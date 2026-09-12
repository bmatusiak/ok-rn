/**
 * Everything this app does over the radio, in one place.
 *
 * The phone has two Bluetooth roles and they used to be two tabs, "Keyboard"
 * and "Security", which is a split by IMPLEMENTATION rather than by what a
 * person is doing. Both are the same act: the phone standing in for a piece
 * of hardware over BLE.
 *
 *   Keyboard      the phone presents itself as a Bluetooth keyboard, so the
 *                 keystrokes a slot produces have somewhere to go. Without
 *                 it the firmware types into nothing.
 *   Security key  the phone presents itself as a FIDO2 authenticator and
 *                 relays CTAP to whichever key is active, so a desktop
 *                 browser can use a key that is plugged into a phone.
 *
 * A MOVE, NOT A REWRITE. Both halves keep their own hook, their own state and
 * their own controls; this file supplies the one scroll view they now share.
 * The sessions themselves live in App for as long as the app does - the FIDO
 * one especially, because a security key that stops answering when you switch
 * tabs is not a security key (see FidoScreen's header).
 */
import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {theme} from '../ui/theme';
import {BtKeyboardScreen} from './BtKeyboardScreen';
import {FidoScreen} from './FidoScreen';
import type {Keystrokes} from '../hooks/useKeystrokes';
import type {FidoSession} from '../hooks/useFidoGatt';
import type {EmuSession} from '../hooks/useOkEmu';

export function BluetoothScreen({
  emu,
  typed,
  fido,
}: {
  emu: EmuSession;
  typed: Keystrokes;
  fido: FidoSession;
}) {
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <BtKeyboardScreen emu={emu} typed={typed} />
      <FidoScreen fido={fido} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: theme.bg},
  content: {padding: 16, gap: 16, paddingBottom: 48},
});
