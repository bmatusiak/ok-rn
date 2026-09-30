import React from 'react';
import {ScrollView, StyleSheet, Text} from 'react-native';
import {Section} from '../ui/components';
import {theme} from '../ui/theme';
import {FirmwareScreen} from './FirmwareScreen';
import {ConfigModePanel} from '../ui/ConfigModePanel';
import type {ConfigState} from '../ui/configModeNotes';
import {useActiveKeyWithBackend} from '../hooks/KeyContext';
import type {EmuSession} from '../hooks/useOkEmu';

/*
 * THE FIRMWARE TAB - updating a production key's firmware.
 *
 * Its own tab because the desktop App gives it one (Setup, Slots, Keys,
 * Backup/Restore, FIRMWARE, Preferences, Advanced), and ok-rn follows the
 * original apps' layout. It used to sit inside Advanced; it moved whole -
 * FirmwareScreen and the config-mode way in are unchanged.
 */
export function FirmwareTabScreen({
  emu,
  hardRunning,
  configMode,
  onWantConfigMode,
}: {
  emu: EmuSession;
  /** A hard key is on the USB bus - the only key there is firmware to update on. */
  hardRunning: boolean;
  configMode: ConfigState;
  onWantConfigMode: () => void;
}) {
  const {backend} = useActiveKeyWithBackend();

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      {hardRunning ? (
        <FirmwareScreen emu={emu} backend={backend} configMode={configMode} />
      ) : (
        <Section title="Firmware update">
          <Text style={styles.note}>
            Needs a hard key on the USB bus. The soft key runs firmware built
            from source by this repository, so there is nothing to update.
          </Text>
        </Section>
      )}
      {/*
        THE WAY IN, AT THE FOOT - after the panel it unlocks. The
        reboot-into-bootloader request is refused outside config mode, and on
        a production key only a thumb on button 6 can enter it.
      */}
      {hardRunning ? (
        <ConfigModePanel
          state={configMode}
          emu={emu}
          backend={backend}
          onWant={onWantConfigMode}
          purpose="update the firmware"
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: theme.bg},
  content: {padding: 14, paddingBottom: 48},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18, marginTop: 8},
});
