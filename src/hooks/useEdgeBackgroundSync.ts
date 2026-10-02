/**
 * The Edge copy kept current in the background, while the soft key runs.
 *
 * WHY (the Pixel, 2026-10-02): the copy was synced only when the Edge tab
 * opened. An ssh login over Bluetooth made link #0 while the tab was shut; the
 * app restarted; a restarted soft key keeps only its LATEST link - so #0 was
 * gone before any copy held it, and the chain could not be proven from its
 * start ("Gap #0", Approve blocked). On the soft key the app is in the middle:
 * it can copy links as they are made, whatever tab is open.
 *
 * WHEN: every PERIOD_MS, and SETTLE_MS after a confirmation clears (a pressed
 * sign was just linked) - but only when the bridge has been quiet for
 * SETTLE_MS. The sync is the app talking to the soft key's vendor interface,
 * and that takes the conversation from a computer mid-request
 * (vendorBridge.ts owner); so it never starts while one is talking, nor while
 * the key is waiting for a confirmation.
 *
 * WHAT: edgeStore.sync - the same sync the tab runs (serialised with it there),
 * into the same stored copy. The tab shows the result when it opens.
 */
import {useEffect, useRef} from 'react';
import {AppState} from 'react-native';
import {sync} from '../edgeStore';
import {SoftKeyEdge} from '../edgeSoftKey';
import {hasSoftKeyPlugin} from '../buildInfo';
import {vendorQuietForMs} from '../vendorBridge';
import type {KeyWaiting} from '../transport/OkEmu';

const PERIOD_MS = 15000;
const SETTLE_MS = 6000;

export function useEdgeBackgroundSync({enabled, waiting}: {enabled: boolean; waiting: KeyWaiting | null}) {
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled || !hasSoftKeyPlugin('edge')) return;
    let alive = true;
    let busy = false;
    const attempt = async () => {
      if (!alive || busy) return;
      if (AppState.currentState !== 'active' || waitingRef.current) return;
      if (vendorQuietForMs() < SETTLE_MS) return; /* a computer is talking to the key */
      busy = true;
      try {
        const source = await SoftKeyEdge.open(); /* null: locked, or no Edge */
        if (source && alive) await sync(source);
      } catch {
        /* the next tick tries again; the tab shows any real error when opened */
      } finally {
        busy = false;
      }
    };
    kick.current = () => setTimeout(() => void attempt(), SETTLE_MS);
    const timer = setInterval(() => void attempt(), PERIOD_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      kick.current = () => {};
    };
  }, [enabled]);

  /* a confirmation just cleared: the request it was for has been linked */
  const was = useRef(false);
  useEffect(() => {
    const now = waiting !== null;
    if (was.current && !now) kick.current();
    was.current = now;
  }, [waiting]);
}
