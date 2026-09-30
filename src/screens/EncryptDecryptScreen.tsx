import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {Segmented} from '../ui/components';
import type {ConfigState} from '../ui/configModeNotes';
import type {EmuSession} from '../hooks/useOkEmu';
import {MessagesScreen, type Direction} from './MessagesScreen';
import {CryptoScreen} from './CryptoScreen';

/*
 * THE WEB APP'S ENCRYPT AND DECRYPT PAGES, AS TWO TABS.
 *
 * The web app's top nav is Encrypt and Decrypt, and under each the same four
 * kinds in the same order - Message, File, PQC-PGP, AGE (apps.onlykey.io
 * src/plugins/pages/mode-tabs.js). The owner's rule for ok-rn is to follow
 * the feel of the original apps, starting with the tab layout and where
 * things are, so someone who knows the web app finds each thing where it
 * already is.
 *
 * Nothing here does crypto. Message, File and PQC-PGP are MessagesScreen with
 * a narrower view; AGE is CryptoScreen's age panel, one half of it per tab.
 * Each sub-tab keeps its own state for as long as the tab is open, as the
 * web app's separate pages do - switching sub-tab starts that one fresh.
 */
const PARTS = ['Message', 'File', 'PQC-PGP', 'AGE'] as const;
type Part = (typeof PARTS)[number];

export function EncryptDecryptScreen({
  direction,
  emu,
  configMode,
  onWantConfigMode,
  blockScreenshots,
  testing,
}: {
  direction: Direction;
  emu: EmuSession;
  configMode: ConfigState;
  onWantConfigMode: () => void;
  blockScreenshots: boolean;
  testing: boolean;
}) {
  const [part, setPart] = useState<Part>('Message');

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Segmented options={PARTS} value={part} onChange={setPart} />
      </View>
      {part === 'AGE' ? (
        <CryptoScreen
          key={`${direction}-age`}
          emu={emu}
          blockScreenshots={blockScreenshots}
          configMode={configMode}
          testing={testing}
          show={direction === 'encrypt' ? ['ageEncrypt'] : ['ageDecrypt']}
        />
      ) : (
        <MessagesScreen
          key={`${direction}-${part}`}
          emu={emu}
          configMode={configMode}
          onWantConfigMode={onWantConfigMode}
          direction={direction}
          part={part === 'Message' ? 'message' : part === 'File' ? 'file' : 'pqc'}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  bar: {paddingHorizontal: 16, paddingTop: 16},
});
