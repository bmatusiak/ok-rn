import React from 'react';
import type {ConfigState} from '../ui/configModeNotes';
import type {EmuSession} from '../hooks/useOkEmu';
import {PreferencesScreen} from './PreferencesScreen';

/*
 * THE PIN SETUP TAB - the PIN changes the desktop App's Setup offers a key
 * that is already set up.
 *
 * The desktop App shows them as a row of links: Set Backup Passphrase |
 * Change Primary PIN | Change Secondary PIN | Change Self-Destruct PIN. ok-rn
 * keeps the three PIN changes here, with the desktop's names and order, so
 * the tab is called PIN Setup. The backup passphrase is NOT here (owner's
 * call): it lives on Backup/Restore, beside the restore that needs the same
 * passphrase - one place to set it and to use it. First-time setup stays on
 * This Key, the landing page.
 *
 * The panels are the Preferences screen's PIN panels, one per PIN, in a list
 * (owner's call: no sub-tabs - every change in sight at once).
 */
export function SetupTabScreen({
  emu,
  configMode,
  onWantConfigMode,
}: {
  emu: EmuSession;
  configMode: ConfigState;
  onWantConfigMode: () => void;
  blockScreenshots: boolean;
}) {
  return (
    <PreferencesScreen
      emu={emu}
      configMode={configMode}
      onWantConfigMode={onWantConfigMode}
      show={['pins']}
    />
  );
}
