import {useEffect, useState} from 'react';
import Rectify from '@bmatusiak/rectify';

import tabs, {type TabsService} from './tabs';
import recipients, {type RecipientSource, type RecipientsService} from './recipients';
import passwords from './passwords/plugin';
import guestbook from './guestbook/plugin';
import cryptobox from './cryptobox/plugin';
import type {AppTab, AppWatch} from './types';

/*
 * THE APP PLUGINS, composed with Rectify as src/onlykey.ts composes the library's (Brad: Rectify
 * is the plugin system). A feature that is its own plugin lives in one folder under src/plugins/
 * and is named only here (PLUGINS, and E2E for its in-app suite). Removing it = deleting its
 * folder and its lines here; App.tsx never
 * names it - it draws whatever tabs the plugins added (Brad, 2026-10-11, the Password Manager:
 * "i want the password manager to act as its own plugin, keeping it easy to remove and work on
 * seperatly").
 */
const PLUGINS: any[] = [tabs, recipients, passwords, guestbook, cryptobox];

let started: TabsService | null = null;
let recipientsService: RecipientsService | null = null;
const waiting = new Set<() => void>();

const app = Rectify.build(PLUGINS, (err: Error | null, ready: any) => {
  if (err) {
    console.warn('[plugins] did not start:', err.message);
    return;
  }
  started = ready.services.tabs as TabsService;
  recipientsService = ready.services.recipients as RecipientsService;
  for (const w of waiting) w();
  waiting.clear();
});
app.start();

/** The plugins' tabs; empty until they have started (a moment after launch, before login). */
export function pluginTabs(): readonly AppTab[] {
  return started ? started.list() : [];
}

/** The plugins that offer people's public keys to core screens (src/plugins/recipients.ts). */
export function pluginRecipientSources(): readonly RecipientSource[] {
  return recipientsService ? recipientsService.list() : [];
}

export function pluginWatches(): readonly AppWatch[] {
  return started ? started.watches() : [];
}

/** Re-renders once when the plugins have started. */
export function usePluginsStarted(): boolean {
  const [ok, setOk] = useState(started !== null);
  useEffect(() => {
    if (ok) return;
    const w = () => setOk(true);
    if (started) w();
    else waiting.add(w);
    return () => void waiting.delete(w);
  }, [ok]);
  return ok;
}

/*
 * Each plugin's in-app e2e suite, by plugin name (__e2e_tests__/13b-passwords.e2e.js asks for it):
 * the e2e folder never names a plugin's files, so removing a plugin leaves its suite empty.
 */
const E2E: Record<string, () => any> = {
  passwords: () => require('./passwords/e2e'),
  guestbook: () => require('./guestbook/e2e'),
};
export function pluginE2E(name: string): ((harness: any) => void)[] {
  const load = E2E[name];
  return load ? [load()] : [];
}
