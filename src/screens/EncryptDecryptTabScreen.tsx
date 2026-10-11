import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {Segmented} from '../ui/components';
import {EncryptDecryptScreen} from './EncryptDecryptScreen';
import type {EmuSession} from '../hooks/useOkEmu';
import type {ConfigState} from '../ui/configModeNotes';

/*
 * ONE TAB FOR ENCRYPT AND DECRYPT (Brad, 2026-10-11: "encrypt and decrypt ,, they need to be
 * merged into a single tab"; name "Encrypt/Decrypt", a switch at the top). The two old tabs
 * are hidden in App.tsx (HIDDEN_TABS), their code kept as it was; this tab picks the direction
 * and shows the same screen underneath. Switching remounts it, so nothing typed on one side
 * leaks into the other.
 */
const DIRECTIONS = ['Encrypt', 'Decrypt'] as const;

export function EncryptDecryptTabScreen(props: {
  emu: EmuSession;
  configMode: ConfigState;
  onWantConfigMode: () => void;
  blockScreenshots: boolean;
  testing: boolean;
}) {
  const [direction, setDirection] = useState<(typeof DIRECTIONS)[number]>('Encrypt');
  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Segmented options={DIRECTIONS} value={direction} onChange={setDirection} />
      </View>
      <EncryptDecryptScreen key={direction} direction={direction === 'Encrypt' ? 'encrypt' : 'decrypt'} {...props} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  bar: {paddingHorizontal: 16, paddingTop: 16},
});
