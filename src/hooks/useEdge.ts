/**
 * The Edge tab's state: one key source, its mirror, and the verdict.
 *
 * WHICH KEY: the soft key, when this build staged the edge firmware plugin
 * (OKEMU_PLUGINS=edge, buildInfo.hasSoftKeyPlugin) and the soft key is the
 * active key; otherwise the FAKE key (src/edgeFake.ts), which builds a real
 * chain with the library so every screen can be exercised without firmware.
 * Both answer the same EdgeSource / EdgeInbox calls. One instance per app
 * session, kept outside React so switching tabs keeps it.
 */
import {useCallback, useEffect, useState} from 'react';
import {FakeEdgeKey, type EdgeBudget, type EdgeCopyCheck, type EdgeInbox, type EdgeKeyState, type EdgeReplay, type EdgeRequest, type EdgeSource} from '../edgeFake';
import {SoftKeyEdge} from '../edgeSoftKey';
import {hasSoftKeyPlugin} from '../buildInfo';
import {useBackend} from './KeyContext';
import {evaluate, loadMirror, sync as syncMirror, tamper as tamperMirror, type EdgeView, type Tamper} from '../edgeStore';

type Source = EdgeSource & EdgeInbox;

let fake: FakeEdgeKey | null = null;
let real: SoftKeyEdge | null = null;

export function useEdge() {
  const backend = useBackend();
  const wantReal = backend === 'embedded' && hasSoftKeyPlugin('edge');
  const [view, setView] = useState<EdgeView | null>(null);
  const [budgets, setBudgets] = useState<EdgeBudget[]>([]);
  const [requests, setRequests] = useState<EdgeRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * What the key is waiting for a PHYSICAL press on: a request ('r<id>'), a
   * resume ('resume:<id>'), a waive ('waive') or the end of a restore ('restore').
   */
  const [pressFor, setPressFor] = useState<string | null>(null);
  /* debts, holds and a restore, from HEAD (keys that have them) */
  const [keyState, setKeyState] = useState<EdgeKeyState | null>(null);
  /* the last replay's outcome, for the Restore card (B6) */
  const [replay, setReplay] = useState<EdgeReplay | null>(null);
  /* R27: whether a budget may be asked for from this phone's copy (Yes is off, with the reason, until it may) */
  const [copyCheck, setCopyCheck] = useState<EdgeCopyCheck | null>(null);

  /* the key to talk to; null = this build has Edge but the soft key did not answer (locked?) */
  const source = useCallback(async (): Promise<Source | null> => {
    if (!wantReal) return (fake ??= FakeEdgeKey.demo());
    if (!real) real = await SoftKeyEdge.open();
    return real;
  }, [wantReal]);

  const run = useCallback(async (work: (s: Source) => Promise<EdgeView>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await source();
      if (!s) {
        setView({verdict: {kind: 'locked'}, headSeq: null, lastSync: null, rows: []});
        return;
      }
      setView(await work(s));
      setBudgets(await s.budgets());
      setKeyState(s.state ? await s.state() : null);
      const pending = await s.pending();
      setRequests(pending);
      setCopyCheck(pending.length ? await s.check() : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [source]);

  /** B1: HEAD, READ what is new, store, verify everything. */
  const sync = useCallback(() => run(async s => (await syncMirror(s)).view), [run]);
  /** Verify the stored copy against the live head WITHOUT reading - shows an edited copy as it is. */
  const verify = useCallback(() => run(async s => evaluate(await loadMirror(s.deviceId), await s.head())), [run]);
  const tamper = useCallback(
    (how: Tamper) => run(async s => {
      const m = await tamperMirror(s.deviceId, how);
      return evaluate(m, m.links.length ? await s.head() : null);
    }),
    [run],
  );
  /** A fake-key action (agent use, ticket, lock), then a sync, as the app would after relaying it. */
  const act = useCallback((fn: (k: FakeEdgeKey) => void) => {
    if (!fake || wantReal) return Promise.resolve();
    fn(fake);
    return sync();
  }, [sync, wantReal]);
  /** An agent asks for a budget (testing mode, on either key). */
  const request = useCallback(async (from: string, reason: string, scopes: EdgeRequest['scopes']) => {
    const s = await source();
    if (!s) return;
    s.request(from, reason, scopes);
    setRequests(await s.pending());
    setCopyCheck(await s.check());
  }, [source]);
  const revoke = useCallback((grantId: number) => run(async s => {
    await s.revoke(grantId);
    return (await syncMirror(s)).view;
  }), [run]);
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
  const hold = useCallback((grantId: number) => run(async s => {
    await s.hold?.(grantId);
    return (await syncMirror(s)).view;
  }), [run]);
  const resume = useCallback((grantId: number) => run(async s => {
    try {
      await s.resume?.(grantId, () => setPressFor(`resume:${grantId}`));
    } finally {
      setPressFor(null);
    }
    return (await syncMirror(s)).view;
  }), [run]);
  /* R18: the person's Yes on screen first (EdgeScreen), then the press */
  const waive = useCallback(() => run(async s => {
    try {
      await s.waive?.(() => setPressFor('waive'));
    } finally {
      setPressFor(null);
    }
    return (await syncMirror(s)).view;
  }), [run]);
  /* testing mode: an agent's pressed sign with no ticket (soft key only) */
  const agentSign = useCallback(() => run(async s => {
    const k = s as Source & {agentSign?: (t: string) => Promise<void>};
    await k.agentSign?.('sign');
    return (await syncMirror(s)).view;
  }), [run]);
  /* R26 / B6: replay this phone's copy, then the press over "restored to #N" */
  const replayCopy = useCallback(() => run(async s => {
    if (s.replayCopy) setReplay(await s.replayCopy());
    return evaluate(await loadMirror(s.deviceId), await s.head());
  }), [run]);
  const finishRestore = useCallback((newestSeq: number) => run(async s => {
    try {
      await s.finishRestore?.(newestSeq, () => setPressFor('restore'));
    } finally {
      setPressFor(null);
    }
    setReplay(null);
    return (await syncMirror(s)).view;
  }), [run]);
  const press = useCallback(async () => {
    const s = await source();
    await s?.press();
  }, [source]);
  const decline = useCallback((id: number) => run(async s => {
    await s.decline(id);
    return evaluate(await loadMirror(s.deviceId), await s.head());
  }), [run]);
  const resetFake = useCallback(async () => {
    if (wantReal) return;
    await tamperMirror((fake ??= FakeEdgeKey.demo()).deviceId, 'forget');
    fake = FakeEdgeKey.demo();
    await run(async s => evaluate(await loadMirror(s.deviceId), null));
  }, [run, wantReal]);

  /* the tab opens: sync (B1) */
  useEffect(() => {
    void sync();
  }, [sync]);

  return {
    view, budgets, requests, busy, error, pressFor, copyCheck, keyState, replay, isFake: !wantReal,
    sync, verify, tamper, act, request, revoke, approve, press, decline, resetFake,
    hold, resume, waive, replayCopy, finishRestore, agentSign,
  };
}
