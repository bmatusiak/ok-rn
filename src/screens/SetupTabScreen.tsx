import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {Btn} from '../ui/components';
import type {ConfigState} from '../ui/configModeNotes';
import type {EmuSession} from '../hooks/useOkEmu';
import {BackupScreen} from './BackupScreen';
import {PIN_TITLE, PreferencesScreen, type PinKind} from './PreferencesScreen';

/*
 * THE SETUP TAB - what the desktop App's Setup offers a key that is already
 * set up.
 *
 * The desktop App shows it as a row of links: Set Backup Passphrase | Change
 * Primary PIN | Change Secondary PIN | Change Self-Destruct PIN. ok-rn follows
 * the original apps' layout, so the same four, the same names, the same
 * order. First-time setup is not here - it stays on This Key, the landing
 * page, which is where a new key sends you.
 *
 * Nothing here is new: the backup passphrase is the Backup screen's "Set a
 * backup key" panel and the PIN changes are the Preferences screen's, each
 * drawn alone. Links, not a segmented bar - four names this long do not fit
 * across a phone, and wrapping them is how the desktop's row reads anyway.
 */
type Item = 'passphrase' | PinKind;
const ITEMS: readonly Item[] = ['passphrase', 'primary', 'secondary', 'selfDestruct'];
const TITLE: Record<Item, string> = {passphrase: 'Set Backup Passphrase', ...PIN_TITLE};

export function SetupTabScreen({
  emu,
  configMode,
  onWantConfigMode,
  blockScreenshots,
}: {
  emu: EmuSession;
  configMode: ConfigState;
  onWantConfigMode: () => void;
  blockScreenshots: boolean;
}) {
  const [item, setItem] = useState<Item>('passphrase');

  return (
    <View style={styles.root}>
      <View style={styles.links}>
        {ITEMS.map(i => (
          <Btn key={i} title={TITLE[i]} tone={i === item ? 'primary' : undefined} onPress={() => setItem(i)} />
        ))}
      </View>
      {item === 'passphrase' ? (
        <BackupScreen
          emu={emu}
          blockScreenshots={blockScreenshots}
          configMode={configMode}
          onWantConfigMode={onWantConfigMode}
          show={['backupKey']}
        />
      ) : (
        <PreferencesScreen
          key={item}
          emu={emu}
          configMode={configMode}
          onWantConfigMode={onWantConfigMode}
          show={['pins']}
          pin={item}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  links: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 16},
});
