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
 * sign was just linked) - but only when the soft key's vendor interface has
 * been quiet for SETTLE_MS, whoever was using it. The sync is the app talking
 * to that interface, and two conversations at once swap answers: a computer's
 * (vendorBridge.ts owner), and the app's own. MEASURED ON THE A13
 * (2026-10-03): Key Chain read its slots while a sync ran - the same slots
 * read "unknown", then ECC1 as ed25519 (it holds x25519), and signing the PGP
 * key locked the firmware on the production build. So every vendor report
 * and write on the soft key's transport, the app's included, counts as
 * traffic; and nothing starts while the key waits for a confirmation.
 * (The lib serialises Edge requests among themselves; the device and crypto
 * plugins do not yet wait for them - that is the lasting fix.)
 *
 * WHAT: edgeStore.sync - the same sync the tab runs (serialised with it there),
 * into the same stored copy. The tab shows the result when it opens.
 */
import {detail, errText} from '../logSafe';
import {useEffect, useRef} from 'react';
import {sync} from '../edgeStore';
import {beat, onHoldRequested, onWatchTick, raiseWatchAlarms, takeHoldRequest, watching} from '../edgeAlerts';
import {SoftKeyEdge} from '../edgeSoftKey';
import {hasSoftKeyPlugin} from '../buildInfo';
import {vendorQuietForMs} from '../vendorBridge';
import {getOnlyKey} from '../onlykey';
import {transport as oktransport} from 'node-onlykey-lib';
import type {KeyWaiting} from '../transport/OkEmu';

const PERIOD_MS = 15000;
const SETTLE_MS = 6000;
const BEAT_MS = 10000;
const HOLD_RETRY_MS = 3000;
const IFACE_VENDOR = oktransport.IFACE.VENDOR;

export function useEdgeBackgroundSync({enabled, waiting}: {enabled: boolean; waiting: KeyWaiting | null}) {
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled || !hasSoftKeyPlugin('edge')) return;
    let alive = true;
    let busy = false;
    /* the last vendor report or write on the soft key, from anyone - ours during a sync too */
    let lastTraffic = Date.now();
    const offs: (() => void)[] = [];
    void getOnlyKey('embedded').then(app => {
      if (!alive) return;
      /*
       * Other requests from this app hold it off - not its own Edge requests
       * (OKEDGE frames, byte 4 = 0xF8): those queue one at a time in the lib, and
       * since the watcher runs in the background the Edge tab's 4 s head check
       * runs there too - counted as traffic, it kept every sync away ("skip: key
       * traffic", the Pixel, 2026-10-04). Replies are not counted: a computer's
       * conversation is vendorQuietForMs's to judge.
       */
      const mark = ({iface, data}: {iface: number; data?: ArrayLike<number>}) => {
        if (iface !== IFACE_VENDOR) return;
        if (data && data[4] === 0xf8) return;
        lastTraffic = Date.now();
      };
      offs.push(app.transport.on('write', mark));
    }).catch(() => {});
    const attempt = async () => {
      if (!alive || busy) return;
      /*
       * B7 stage 2, option A (spec 2026-10-04): no longer only with the app in
       * front - the soft key's foreground service keeps this process alive, and
       * the alarms must reach a phone in a pocket. A press waiting still skips.
       */
      if (waitingRef.current) return;
      if (vendorQuietForMs() < SETTLE_MS) return; /* a computer is talking to the key */
      if (Date.now() - lastTraffic < SETTLE_MS) return; /* the key is in use - by this app too */
      busy = true;
      try {
        const source = await SoftKeyEdge.open(); /* null: locked, or no Edge */
        if (source && alive) {
          const {mirror, view} = await sync(source);
          const [st, live, past] = await Promise.all([source.state(), source.budgets(), source.pastBudgets()]);
          await raiseWatchAlarms(mirror, view, {refusedArms: st.refusedArms, live: live.map(b => b.grantId), past});
        }
      } catch (e) {
        console.log(`[edge-watch] sync failed: ${errText(e)}`);
        /* the next tick tries again; the tab shows any real error when opened */
      } finally {
        busy = false;
      }
    };
    kick.current = () => setTimeout(() => void attempt(), SETTLE_MS);
    const timer = setInterval(() => void attempt(), PERIOD_MS);

    /* the heartbeat: the native watchdog posts "Edge watching stopped" 30 s after the last one */
    watching(true);
    beat();
    const beats = setInterval(beat, BEAT_MS);
    /*
     * THE NATIVE CLOCK. React Native pauses JS timers in the background and with
     * the screen off (the Pixel, 2026-10-04: the beats stopped a minute after the
     * screen went off, the "watching stopped" notice came, no alarm did). The
     * native watchdog sends a tick every 10 s while watching; a tick still runs
     * JS. Beat on each, sync at most every PERIOD_MS.
     */
    let lastAttempt = 0;
    const offTick = onWatchTick(() => {
      beat();
      if (Date.now() - lastAttempt >= PERIOD_MS) {
        lastAttempt = Date.now();
        void attempt();
      }
    });

    /*
     * Hold from a notification (spec 2026-10-04): every live budget, at once if
     * this side is running; one tapped while it was not is waiting in native and
     * done as soon as the key answers (tried every few seconds until it does).
     */
    let holdWanted = takeHoldRequest();
    const holdAll = async () => {
      const source = await SoftKeyEdge.open();
      if (!source) return false;
      const st = await source.state();
      const ids = (await source.budgets()).map(b => b.grantId).filter(id => !st.held.includes(id));
      for (const id of ids) await source.hold(id);
      console.log(`[edge-watch] hold: ${ids.length ? detail(ids.join(', '), `${ids.length} budget(s)`) : 'nothing live to hold'}`);
      return true;
    };
    const tryHold = async () => {
      if (!holdWanted || !alive) return;
      if (await holdAll().catch(() => false)) holdWanted = false;
    };
    const holdTimer = setInterval(() => void tryHold(), HOLD_RETRY_MS);
    void tryHold();
    const offHold = onHoldRequested(() => { console.log('[edge-watch] hold requested from a notification'); holdWanted = true; void tryHold(); });

    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(beats);
      offTick();
      clearInterval(holdTimer);
      offHold();
      watching(false);
      for (const off of offs) off();
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
