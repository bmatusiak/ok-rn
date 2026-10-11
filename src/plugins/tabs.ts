import type {AppTab, AppWatch} from './types';

/*
 * The core app plugin: the one place feature plugins add tabs (and a watch that runs with the
 * app). Provides `tabs`; a feature plugin consumes it and calls add() in its setup.
 */
export type TabsService = {
  add(tab: AppTab, watch?: AppWatch): void;
  list(): readonly AppTab[];
  watches(): readonly AppWatch[];
};

export default function setup(_imports: unknown, register: (err: Error | null, services: {tabs: TabsService}) => void) {
  const tabs: AppTab[] = [];
  const watches: AppWatch[] = [];
  register(null, {
    tabs: {
      add(tab, watch) {
        if (tabs.some(t => t.name === tab.name)) throw new Error(`app plugins: two tabs named ${tab.name}`);
        tabs.push(tab);
        if (watch) watches.push(watch);
      },
      list: () => tabs.slice(),
      watches: () => watches.slice(),
    },
  });
}
setup.consumes = [] as string[];
setup.provides = ['tabs'];
