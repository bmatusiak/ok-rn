import type {ReactNode} from 'react';
import type {Backend} from '../hooks/keySession';

/*
 * What an app plugin gets from the app, and what it gives back. The plugin never reaches into
 * App.tsx: everything it may know comes in through these.
 */

/** Each key's capabilities reading, as useOkEmu/useHardKey hold it (null before one). */
export type KeyCaps = {deviceVault?: boolean; touchFreeDerive?: string; [k: string]: unknown} | null | undefined;

/** Given to a tab's render, each time the app draws it. */
export type TabContext = {
  /** the key chosen as active */
  backend: Backend;
  /** that key is running and unlocked */
  unlocked: boolean;
  caps: KeyCaps;
  /** FLAG_SECURE wanted (release builds): a screen showing secrets turns it on */
  blockScreenshots: boolean;
};

/** Given to a plugin's watch, mounted once with the app whether its tab is shown or not. */
export type WatchContext = {
  /** each key: running and unlocked */
  unlocked: Record<Backend, boolean>;
};

export type AppTab = {
  /** the drawer's label, unique among tabs */
  name: string;
  /** shown after this tab of the app's (its place in the drawer); at the end when absent */
  after?: string;
  render: (ctx: TabContext) => ReactNode;
};

export type AppWatch = (props: WatchContext) => ReactNode;
