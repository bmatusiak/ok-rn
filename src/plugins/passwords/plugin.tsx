import React from 'react';
import {AppRegistry} from 'react-native';

import {nameDerive} from '../../pressAsk';

import type {TabsService} from '../tabs';
import type {WatchContext} from '../types';
import {PasswordsScreen} from './PasswordsScreen';
import {usePasswordWatch} from './usePasswordManager';

/*
 * THE PASSWORD MANAGER as an app plugin (Brad, 2026-10-11: "its own plugin, keeping it easy to
 * remove and work on seperatly"). Everything it is lives in this folder; the app names it once,
 * in src/plugins/index.ts. It adds its tab and a watch that closes a key's store when that key
 * locks, whether the tab is open or not.
 */

/*
 * The Autofill sheet's root (android/autofill AutofillAuthActivity renders OkRNAutofill).
 * Registered here, at load, because Chrome can wake the app cold and the sheet must exist before
 * any tab is drawn; App.tsx loads src/plugins at once, so this runs at start.
 */
/* what the press sheet calls this plugin's store derive (src/pressAsk.ts nameDerive) */
nameDerive('vault:ok-rn-manager', 'Passwords: open your password store');

AppRegistry.registerComponent('OkRNAutofill', () => require('./autofill/AutofillSheet').default);

function Watch({unlocked}: WatchContext) {
  usePasswordWatch(unlocked);
  return null;
}

export default function setup({tabs}: {tabs: TabsService}, register: (err: Error | null, services: {passwords: object}) => void) {
  /* placed after Key Chain for now - where it sits in the drawer is Brad's call */
  tabs.add({name: 'Passwords', after: 'Key Chain', render: ctx => <PasswordsScreen ctx={ctx} />}, Watch);
  register(null, {passwords: {}});
}
setup.consumes = ['tabs'];
setup.provides = ['passwords'];
