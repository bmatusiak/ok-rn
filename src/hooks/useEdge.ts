/**
 * The Edge tab's state: one key source, its mirror, and the verdict.
 *
 * WHICH KEY: the soft key, when this build staged the edge firmware plugin
 * (OKEMU_PLUGINS=edge, buildInfo.hasSoftKeyPlugin) and the soft key is the
 * active key; otherwise there is no Edge here and the tab says so (the fake key
 * that stood in went 2026-10-08 - the testnet soft key is the real thing; it stays
 * only as a test fixture). One instance per app
 * session, kept outside React so switching tabs keeps it.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {type EdgeBudget, type EdgeCopyCheck, type EdgeEnded, type EdgeInbox, type EdgeKeyState, type EdgeRequest, type EdgeSource} from '../edgeFake';
import {SoftKeyEdge} from '../edgeSoftKey';
import {computerHoldsKey, onKeyFree} from '../vendorBridge';
import {hasSoftKeyPlugin} from '../buildInfo';
import {useBackend} from './KeyContext';
import {blocksOf, chainState, evaluate, forgetVerifiedFor, liveView, loadMirror, sync as syncMirror, tamper as tamperMirror, type EdgeView, type Tamper} from '../edgeStore';
import NativeShare from '../../specs/NativeShare';

type Source = EdgeSource & EdgeInbox;

/* how often the open Edge tab checks whether the key's chain moved */
const HEAD_POLL_MS = 4000;

let real: SoftKeyEdge | null = null;

export function useEdge() {
  const backend = useBackend();
  const wantReal = backend === 'embedded' && hasSoftKeyPlugin('edge');
  const [view, setView] = useState<EdgeView | null>(null);
  const [budgets, setBudgets] = useState<EdgeBudget[]>([]);
  const [past, setPast] = useState<EdgeBudget[]>([]);
  /* your other devices' budgets (full cards, Brad 2026-10-09) - their own list: each phone numbers its budgets from 1 */
  const [others, setOthers] = useState<EdgeBudget[]>([]);
  /* this phone's nametag, for its own cards' corner */
  const [ownName, setOwnName] = useState<string | null>(null);
  /* each of your other devices' chain views, by device id - drawn with this phone's own rows */
  const [deviceViews, setDeviceViews] = useState<Record<string, EdgeView>>({});
  const [requests, setRequests] = useState<EdgeRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * What the key is waiting for a PHYSICAL press on: a request ('r<id>'), a
   * resume ('resume:<id>') or a settle ('settle').
   */
  const [pressFor, setPressFor] = useState<string | null>(null);
  /* debts and holds, from HEAD (keys that have them) */
  const [keyState, setKeyState] = useState<EdgeKeyState | null>(null);
  /* budgets a lock or reboot ended, with what is left (Continue) */
  const [ended, setEnded] = useState<EdgeEnded[]>([]);
  /* R27: whether a budget may be asked for from this phone's copy (Yes is off, with the reason, until it may) */
  const [copyCheck, setCopyCheck] = useState<EdgeCopyCheck | null>(null);

  /* the key to talk to; null = no Edge here (not the soft key with the Edge plugin), or it did not answer (locked?) */
  const source = useCallback(async (): Promise<Source | null> => {
    if (!wantReal) return null;
    if (!real) real = await SoftKeyEdge.open();
    return real;
  }, [wantReal]);

  const run = useCallback(async (work: (s: Source) => Promise<EdgeView>) => {
    setBusy(true);
    setError(null);
    /* how long each part of an action takes, for the log (Brad, 2026-10-06: presses lag) - times only, nothing sensitive */
    const t0 = Date.now();
    const parts: string[] = [];
    let tp = t0;
    const lap = (name: string) => { const n = Date.now(); parts.push(`${name} ${n - tp}`); tp = n; };
    try {
      const s = await source();
      if (!s) {
        setView({verdict: {kind: 'locked'}, headSeq: null, lastSync: null, rows: []});
        return;
      }
      setView(await work(s));
      lap('work');
      /* one head read, one copy load for the rest of this refresh (SoftKeyEdge.beginRun) */
      (s as unknown as {beginRun?: () => void}).beginRun?.();
      setBudgets(await s.budgets());
      lap('budgets');
      /* budget history: what this phone opened that is not live now (soft key only) */
      const src = s as unknown as {pastBudgets?: () => Promise<EdgeBudget[]>};
      setPast(src.pastBudgets ? await src.pastBudgets().catch(() => []) : []);
      lap('past');
      const dv = s as unknown as {deviceBudgets?: (id: string, name: string) => Promise<EdgeBudget[]>};
      if (dv.deviceBudgets) {
        const {loadDevices, nametagOf, ownStatement} = require('../edgeDevices');
        const all: EdgeBudget[] = [];
        const views: Record<string, EdgeView> = {};
        const dview = s as unknown as {deviceView?: (id: string) => Promise<EdgeView>};
        for (const d of await loadDevices().catch(() => [])) {
          const n = await nametagOf(d).catch(() => null);
          const view = dview.deviceView ? await dview.deviceView(d.deviceId).catch(() => null) : null;
          if (view) views[String(d.deviceId).toLowerCase()] = view;
          all.push(...(await dv.deviceBudgets(d.deviceId, n?.nametag ?? `device ${String(d.deviceId).slice(0, 8)}`).catch(() => [])));
        }
        setOthers(all);
        setDeviceViews(views);
        setOwnName((await ownStatement().catch(() => null))?.nametag ?? null);
      }
      setKeyState(s.state ? await s.state() : null);
      setEnded(s.ended ? await s.ended() : []);
      lap('state+ended');
      const pending = await s.pending();
      setRequests(pending);
      lap('pending');
      /* every sync, not only with a request waiting: a copy that fails the budget rules (R3) must show on the tab, not only on the sheet (2026-10-04) */
      setCopyCheck(await s.check().catch(() => null));
      lap('check');
      const path = (s as unknown as {edge?: {grants?: {lastPath?: string | null}}}).edge?.grants?.lastPath;
      console.log(`[edge] run ${Date.now() - t0} ms: ${parts.join(', ')}${path ? ` (copy check: ${path})` : ''}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      const s = real;
      (s as unknown as {endRun?: () => void} | null)?.endRun?.();
      setBusy(false);
    }
  }, [source]);

  /** B1: HEAD, READ what is new, store, verify everything. */
  const sync = useCallback(() => run(async s => (await syncMirror(s)).view), [run]);
  /* a merge or a nametag change (edgeDevices): your other devices' cards and logs are read again at once - no pull needed */
  useEffect(() => {
    if (!wantReal) return undefined;
    const {onDevicesChanged} = require('../edgeDevices');
    return onDevicesChanged(() => { void sync(); });
  }, [sync, wantReal]);
  /**
   * The Sync button: a full check from the root (Brad, 2026-10-06) - this session's
   * remembered results are dropped first. Pull-down, presses and the 4 s poll use sync.
   */
  const fullSync = useCallback(() => run(async s => {
    forgetVerifiedFor(s.deviceId);
    (s as unknown as {edge?: {grants?: {forget?: () => void}}}).edge?.grants?.forget?.();
    return (await syncMirror(s)).view;
  }), [run]);
  /** Verify the stored copy against the live head WITHOUT reading - shows an edited copy as it is. */
  const verify = useCallback(() => run(async s => (await chainState.validity(s)).view), [run]);
  const tamper = useCallback(
    (how: Tamper) => run(async s => {
      const m = await tamperMirror(s.deviceId, how);
      return m.links.length ? liveView(s, m) : evaluate(m, null);
    }),
    [run],
  );
  /*
   * BLOCKS (BLOCKS.md §3, Brad 2026-10-07): this key's copy as canonical JSON blocks,
   * shared as a .json file - what anyone can check with SHA-256 and the key's public key.
   * -> a line for the tab: how many blocks, how many links still open, any that did not verify
   */
  const exportBlocks = useCallback(async (): Promise<string> => {
    const s = await source();
    if (!s) return 'the key did not answer';
    const r = await blocksOf(s.deviceId);
    if (!r.count) return r.reason ? 'no blocks: ' + r.reason : 'no blocks yet - a block closes when a budget ends';
    await NativeShare.shareFile('onlykey-edge-blocks-' + new Date().toISOString().slice(0, 10) + '.json', r.json, 'application/json', 'Edge blocks');
    return r.count + ' block(s), ' + r.open + ' link(s) after the last seal' + (r.bad ? ' - ' + r.bad + ' did not verify' : ', all verified');
  }, [source]);
  /** An agent asks for a budget (testing mode, on either key). */
  const request = useCallback(async (from: string, reason: string, scopes: EdgeRequest['scopes']) => {
    const s = await source();
    if (!s) return;
    s.request(from, reason, scopes);
    setRequests(await s.pending());
    setCopyCheck(await s.check());
  }, [source]);
  /*
   * RULE 8 (Brad, 2026-10-06): a Hold or Revoke the person taps is never kept
   * waiting by the tab's own background work - its buttons follow `stopping`
   * (one of these in flight), not `busy` - and it goes to the front of the
   * key's lane (SoftKeyEdge: urgent). The log says how long it took, from the tap.
   */
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const stop = useCallback((what: 'hold' | 'revoke', grantId: number, act: (s: Source) => Promise<void>) => {
    if (stoppingRef.current) return Promise.resolve(); /* a second tap while one is on its way */
    stoppingRef.current = true;
    setStopping(true);
    const t = Date.now();
    console.log(`[edge] ${what} tapped (budget ${grantId})`);
    return run(async s => {
      await act(s);
      console.log(`[edge] ${what} on the key ${Date.now() - t} ms after the tap`);
      return (await syncMirror(s)).view;
    }).finally(() => {
      stoppingRef.current = false;
      setStopping(false);
    });
  }, [run]);
  const revoke = useCallback((grantId: number) => stop('revoke', grantId, async s => { await s.revoke(grantId); }), [stop]);
  /* the clasp: Yes sends the request; the key waits for the press; then it is live */
  const approve = useCallback((id: number) => run(async s => {
    try {
      await s.approve(id, () => setPressFor(`r${id}`));
    } finally {
      setPressFor(null);
    }
    return (await syncMirror(s)).view;
  }), [run]);
  /* R15a: hold needs no press; resume runs the copy check, then waits for one */
  const hold = useCallback((grantId: number) => stop('hold', grantId, async s => { await s.hold?.(grantId); }), [stop]);
  const resume = useCallback((grantId: number) => run(async s => {
    try {
      await s.resume?.(grantId, () => setPressFor(`resume:${grantId}`));
    } finally {
      setPressFor(null);
    }
    return (await syncMirror(s)).view;
  }), [run]);
  /* R18: the person's Yes on screen first (EdgeScreen), then the press */
  const settle = useCallback(() => run(async s => {
    try {
      await s.settle?.(() => setPressFor('settle'));
    } finally {
      setPressFor(null);
    }
    return (await syncMirror(s)).view;
  }), [run]);
  /* Continue: a request for what is left; then Approve is the usual Yes and press */
  const continueBudget = useCallback((grantId: number) => run(async s => {
    await s.continueBudget?.(grantId);
    return (await chainState.validity(s)).view;
  }), [run]);
  /* 4.7a: an ended AGENT budget only goes away - the agent continues it, not the tab */
  const dismissEnded = useCallback((grantId: number) => run(async s => {
    await s.dismissEnded?.(grantId);
    return (await chainState.validity(s)).view;
  }), [run]);
  /* R24 / the red banner: Yes on screen, then the press; the key links LOSS {from, to} */
  const acceptLoss = useCallback((from: number, to: number) => run(async s => {
    try {
      await s.acceptLoss?.(from, to, () => setPressFor('loss'));
    } finally {
      setPressFor(null);
    }
    return (await syncMirror(s)).view;
  }), [run]);
  /* testing mode: an agent's pressed sign with no receipt (soft key only) */
  const agentSign = useCallback(() => run(async s => {
    const k = s as Source & {agentSign?: (t: string) => Promise<void>};
    await k.agentSign?.('sign');
    return (await syncMirror(s)).view;
  }), [run]);
  const press = useCallback(async () => {
    const s = await source();
    await s?.press();
  }, [source]);
  const decline = useCallback((id: number) => run(async s => {
    await s.decline(id);
    return (await chainState.validity(s)).view;
  }), [run]);
  /* the tab opens: sync (B1) */
  useEffect(() => {
    void sync();
  }, [sync]);

  /*
   * THE CARD FOLLOWS THE KEY (spec session, 2026-10-03, bug 2): an agent spends
   * straight on the key over Bluetooth, not through this tab, so the copy fell
   * behind and the card said 0 spent. While the tab is open, read the key's head
   * every few seconds; when it moved, sync - the budgets and their spend reload.
   * Safe beside an agent: a computer's conversation holds the key's lane
   * (vendorBridge), and this read waits its turn.
   */
  const lastSeq = useRef<number | null>(null);
  const syncWhenFree = useRef(false);
  useEffect(() => {
    if (!wantReal) return;
    return onKeyFree(() => {
      if (!syncWhenFree.current) return;
      syncWhenFree.current = false;
      void sync();
    });
  }, [wantReal, sync]);
  useEffect(() => {
    if (!wantReal) return;
    let stopped = false;
    const t = setInterval(async () => {
      try {
        /*
         * A COMPUTER HOLDS THE KEY (Brad, 2026-10-06): the tab's reads would only
         * queue behind the agent (6-7 s each, measured) - skip, and sync once the
         * key is free (the effect below).
         */
        if (computerHoldsKey()) {
          syncWhenFree.current = true;
          return;
        }
        const s = await source();
        if (!s || stopped) return;
        const {seq} = await s.head();
        if (lastSeq.current !== null && seq !== lastSeq.current) void sync();
        lastSeq.current = seq;
      } catch {
        /* the key busy, locked or gone: the next tick tries again */
      }
    }, HEAD_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [wantReal, source, sync]);

  return {
    view, budgets, past, others, ownName, deviceViews, requests, busy, stopping, error, pressFor, copyCheck, keyState, ended, available: wantReal, fullSync,
    sync, verify, tamper, request, revoke, approve, press, decline,
    hold, resume, settle, agentSign, continueBudget, dismissEnded, acceptLoss, exportBlocks,
  };
}
