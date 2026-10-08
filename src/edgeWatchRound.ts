/**
 * One round of the background Edge watch: when it runs, and what it asks the key.
 *
 * WHY (the A13, 2026-10-07): every 15 s the watch ran a full sync and then four
 * key reads (state, budgets, past budgets, siblings) - ~1.8 s of key traffic on
 * the thread that answers Bluetooth - even when no link had been made since the
 * last round. And it ran on two clocks: the JS timer and the native watch tick
 * each started rounds, so the log showed two interleaved 15 s series.
 *
 * Now a round asks the one chain state (edgeStore chainState.validity): when the
 * head and the stored copy are what the last check saw, that is one head read and
 * no sync. A moved head still syncs at once (the copy must catch every link
 * while the key still has it - the reason this watch exists).
 *
 * The alarms are not all about the head: a receipt owed past 10 minutes, a budget
 * that expired, a sibling that stopped syncing - those change with the clock
 * while the head stands still. So they run after every round that saw a change,
 * and otherwise on their own slower clock (alarmEveryMs), never not at all.
 *
 * Kept free of React Native so jest can drive it with fakes.
 */
export type WatchAnswer = {path: 'full' | 'new-links' | 'sealed' | 'skipped' | null};

export type WatchDeps<A extends WatchAnswer> = {
  /** the chain state's answer: from memory when nothing moved, else one sync */
  validity(): Promise<A>;
  /** the key's state reads and the alarms raised from them */
  alarms(answer: A): Promise<void>;
  now?: () => number;
};

export type WatchClock = {periodMs: number; alarmEveryMs: number};

export function createWatchRound<A extends WatchAnswer>(deps: WatchDeps<A>, clock: WatchClock) {
  const now = deps.now ?? Date.now;
  let lastRound = -Infinity;
  let lastAlarms = -Infinity;
  /*
   * A second's slack: the timer and the tick drift against each other, and a
   * round missed by a few ms would wait a whole extra period.
   */
  const due = () => now() - lastRound >= clock.periodMs - 1000;
  return {
    /** is a round due? (a forced round - a link was just made - skips this) */
    due,
    /** run one round; the caller has checked the key is free */
    async run(): Promise<A> {
      lastRound = now();
      const a = await deps.validity();
      if (a.path !== 'skipped' || now() - lastAlarms >= clock.alarmEveryMs) {
        lastAlarms = now();
        await deps.alarms(a);
      }
      return a;
    },
  };
}
