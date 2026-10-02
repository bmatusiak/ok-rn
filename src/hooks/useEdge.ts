/**
 * The Edge tab's state: one key source, its mirror, and the verdict.
 *
 * The source is the FAKE key for now (testing mode only, see src/edgeFake.ts);
 * the soft key's Edge plugin (E3) replaces it behind the same EdgeSource
 * interface. One fake per app session, kept outside React so switching tabs
 * does not throw its history away.
 */
import {useCallback, useEffect, useState} from 'react';
import {FakeEdgeKey, type EdgeBudget} from '../edgeFake';
import {evaluate, loadMirror, sync as syncMirror, tamper as tamperMirror, type EdgeView, type Tamper} from '../edgeStore';

let fake: FakeEdgeKey | null = null;
const source = () => (fake ??= FakeEdgeKey.demo());

export function useEdge() {
  const [view, setView] = useState<EdgeView | null>(null);
  const [budgets, setBudgets] = useState<EdgeBudget[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (work: () => Promise<EdgeView>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await work());
      setBudgets(await source().budgets());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /** B1: HEAD, READ what is new, store, verify everything. */
  const sync = useCallback(() => run(async () => (await syncMirror(source())).view), [run]);
  /** Verify the stored copy against the live head WITHOUT reading - shows an edited copy as it is. */
  const verify = useCallback(
    () => run(async () => evaluate(await loadMirror(source().deviceId), await source().head())),
    [run],
  );
  const tamper = useCallback(
    (how: Tamper) => run(async () => {
      const m = await tamperMirror(source().deviceId, how);
      return evaluate(m, m.links.length ? await source().head() : null);
    }),
    [run],
  );
  /** A fake-key action (agent use, ticket, clasp, lock), then a sync, as the app would after relaying it. */
  const act = useCallback((fn: (k: FakeEdgeKey) => void) => {
    fn(source());
    return sync();
  }, [sync]);
  const resetFake = useCallback(async () => {
    await tamperMirror(source().deviceId, 'forget');
    fake = FakeEdgeKey.demo();
    await run(async () => evaluate(await loadMirror(source().deviceId), null));
  }, [run]);

  /* the tab opens: sync (B1) */
  useEffect(() => {
    void sync();
  }, [sync]);

  return {view, budgets, busy, error, sync, verify, tamper, act, resetFake};
}
